import { configuredModel } from "./config.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./persistence.js";
import { newId } from "./persistence.js";
import type { BridgeConfig, TaskRecord, RunRecord, TaskStatus, Handoff } from "./types.js";
import type { ParsedTaskRequest } from "./schema.js";
import { parseTaskRequest } from "./schema.js";
import { PiSupervisor } from "./supervisor.js";
import { SessionManager } from "./session-manager.js";
import { PolicyStore } from "./policies.js";
import { runVerifier, type VerificationBundle } from "./verifier.js";
import { buildHandoff, serializeHandoff } from "./handoff.js";
import { gitDiff, gitStatus } from "./git.js";
import { assertAuthorized, validateScope, inScope } from "./paths.js";
import { assertEnforceableRun } from "./policy-enforcement.js";
import { BridgeError, ExitCode } from "./errors.js";
import { redactText } from "./redact.js";

/**
 * Task state machine + orchestration (需求文档 §4.2, §6.2, §7).
 *
 * Lifecycle: pending -> running -> (succeeded | failed | blocked | cancelled | interrupted).
 * Every result write is generation-guarded so a late result can never overwrite a newer
 * generation (§7.2). Terminal tasks are never flipped back to running.
 *
 * Termination discipline (P0):
 *   - The enforceability gate runs BEFORE any DB write / worker spawn.
 *   - Claiming a run is atomic AND status-gated; only one run per task can be
 *     enqueued (dedupe) so a repeated resume cannot double-execute.
 *   - cancel() supersedes the generation + clears activeRunId + marks cancelled
 *     synchronously, before any await, and signals only that task's run.
 *   - The whole-run timeout covers startup/session/prompt/worker/verifier; it first
 *     invalidates the run (records timeout/failed) and THEN aborts so late writes
 *     are dropped and the caller never receives a `passed` result.
 */

type AbortReason = "cancelled" | "timeout";

interface RunHandle {
  taskId: string;
  runId: string;
  req: ParsedTaskRequest;
  workspace: string;
  model: string;
  scopePrefixes: string[];
  expectedGeneration: number;
  eligibleStatuses: TaskStatus[];
  controller: AbortController;
  reason: AbortReason | null;
  resolve: (h: Handoff | null) => void;
  reject: (e: Error) => void;
}

const SUBMIT_ELIGIBLE: TaskStatus[] = ["pending"];
const RESUME_ELIGIBLE: TaskStatus[] = ["interrupted", "needs_review", "failed", "cancelled"];
const CANCEL_ELIGIBLE: TaskStatus[] = ["pending", "running", "interrupted", "needs_review"];

export class TaskEngine {
  private queue: RunHandle[] = [];
  private current: RunHandle | null = null;
  private draining = false;
  private readonly inFlight = new Set<string>();
  /** Set when a verifier process tree could not be confirmed terminated. */
  private blockedReason: string | null = null;
  /** Set once shutdown begins; rejects new work. */
  private stopping = false;

  constructor(
    private cfg: BridgeConfig,
    private store: Store,
    private supervisor: PiSupervisor,
    private sessions: SessionManager,
    private policies: PolicyStore,
  ) {}

  isBusy(): boolean {
    return this.current !== null;
  }

  blocked(): string | null {
    return this.blockedReason;
  }

  /** Begin orderly shutdown: reject new submissions immediately. */
  beginStopping(): void {
    this.stopping = true;
  }

  private assertAccepting(): void {
    if (this.stopping) {
      throw new BridgeError(ExitCode.UNAVAILABLE, "engine 正在关闭，拒绝新任务");
    }
    if (this.blockedReason) {
      throw new BridgeError(
        ExitCode.UNAVAILABLE,
        `engine 已阻止后续运行：${this.blockedReason}（请重启 bridge daemon）`,
      );
    }
  }

  activeRunId(): string | null {
    return this.supervisor.activeRunId;
  }

  /** Submit a task. Resolves with a Handoff when --wait, or null when detached. */
  async submit(req: ParsedTaskRequest, opts: { wait: boolean }): Promise<{ taskId: string; wait: Promise<Handoff | null> }> {
    // Authorization + scope validation + enforceability gate happen before any DB
    // write or worker spawn (§8.1, fail-closed).
    const workspace = assertAuthorized(req.workspace, this.policies.authorizedRoots());
    const scopePrefixes = validateScope(workspace, req.scope);
    assertEnforceableRun(req.policy, scopePrefixes);
    this.assertAccepting();

    const model = req.model ?? configuredModel(this.cfg);
    if (this.cfg.backend === "dsh" && model !== "default") throw new BridgeError(ExitCode.BAD_REQUEST, "DSH headless uses its own configured model; omit task.model");
    const taskId = req.taskId ?? newId("task");
    const now = new Date().toISOString();

    if (this.store.getTask(taskId)) {
      throw new BridgeError(ExitCode.BAD_REQUEST, `taskId 已存在: ${taskId}`);
    }
    if (this.inFlight.has(taskId)) {
      throw new BridgeError(ExitCode.LIMIT, `任务已在执行或排队: ${taskId}`);
    }
    const limits = this.policies.limits();
    if (limits.maxActiveTasks === 1 && this.isBusy()) {
      throw new BridgeError(ExitCode.LIMIT, "已有任务在执行（本地单 Worker 串行限制）");
    }

    const task: TaskRecord = {
      id: taskId,
      workspace,
      status: "pending",
      activeRunId: null,
      generation: 0,
      requestJson: JSON.stringify({ ...req, workspace, resolvedScope: scopePrefixes }),
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertTask(task);

    const waitPromise = this.enqueue(taskId, req, workspace, model, scopePrefixes, task.generation, SUBMIT_ELIGIBLE);
    return this.finishEnqueue(taskId, waitPromise, opts.wait);
  }

  private finishEnqueue(
    taskId: string,
    waitPromise: Promise<Handoff | null>,
    wait: boolean,
  ): { taskId: string; wait: Promise<Handoff | null> } {
    if (wait) return { taskId, wait: waitPromise };
    // Detached: never leave an unhandled rejection (the run may reject on cancel/timeout).
    waitPromise.catch(() => {});
    return { taskId, wait: Promise.resolve(null) };
  }

  private enqueue(
    taskId: string,
    req: ParsedTaskRequest,
    workspace: string,
    model: string,
    scopePrefixes: string[],
    expectedGeneration: number,
    eligibleStatuses: TaskStatus[],
  ): Promise<Handoff | null> {
    if (this.inFlight.has(taskId)) {
      return Promise.reject(new BridgeError(ExitCode.LIMIT, `任务已在执行或排队: ${taskId}`));
    }
    let resolveFn: (h: Handoff | null) => void = () => {};
    let rejectFn: (e: Error) => void = () => {};
    const wait = new Promise<Handoff | null>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const handle: RunHandle = {
      taskId,
      runId: newId("run"),
      req,
      workspace,
      model,
      scopePrefixes,
      expectedGeneration,
      eligibleStatuses,
      controller: new AbortController(),
      reason: null,
      resolve: resolveFn,
      reject: rejectFn,
    };
    this.queue.push(handle);
    this.inFlight.add(taskId);
    void this.pump();
    return wait;
  }

  /** Single serial consumer: one run at a time, in queue order. */
  private async pump(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const handle = this.queue[0];
        this.current = handle;
        try {
          const handoff = await this.executeRun(handle);
          handle.resolve(handoff);
        } catch (err) {
          handle.reject(err as Error);
        } finally {
          this.queue = this.queue.filter((x) => x !== handle);
          if (this.current === handle) this.current = null;
          // Only clear the in-flight marker when no other handle for the same task
          // remains (a cancel/resume may have queued a fresh handle already).
          const stillQueued = this.queue.some((h) => h.taskId === handle.taskId) || this.current?.taskId === handle.taskId;
          if (!stillQueued) this.inFlight.delete(handle.taskId);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async executeRun(handle: RunHandle): Promise<Handoff> {
    const { taskId, runId, req, workspace, model, scopePrefixes, expectedGeneration, eligibleStatuses } = handle;
    const task = this.store.getTask(taskId);
    if (!task) throw new BridgeError(ExitCode.BAD_REQUEST, `task 不存在: ${taskId}`);

    // Preconditions BEFORE inserting a run row: if the task was cancelled/superseded
    // while queued, drop it here so we neither create a phantom run nor start a verifier.
    if (task.generation !== expectedGeneration || !eligibleStatuses.includes(task.status)) {
      throw this.abortError(handle);
    }

    const generation = expectedGeneration + 1;
    const runDir = join(this.cfg.home, "logs", runId);
    mkdirSync(runDir, { recursive: true });

    // --- preconditions ---------------------------------------------------
    const git = gitStatus(workspace);
    const riskNotes: string[] = [];
    if (!git.isRepo) {
      riskNotes.push("工作目录不是 Git 仓库：无法提供 diff 证据，requireCleanDiff 无法强制");
      if (req.policy.allowWrite) {
        riskNotes.push("非 Git 项目写模式已执行（MVP 未强制隔离），请人工复核改动");
      }
    } else if (!git.clean) {
      riskNotes.push("工作目录在任务开始前已有未提交改动，diff 可能包含既有变更");
    }

    const run: RunRecord = {
      id: runId,
      taskId,
      generation,
      status: "running",
      model,
      piSessionPath: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorCode: null,
    };
    this.store.insertRun(run);

    // Atomically claim this run AND flip the task to `running`, guarded by the
    // expected previous generation and an eligible status set. If cancel/timeout/
    // a competing claim already moved the task, this fails (fail-closed).
    const claimed = this.store.claimRun(
      taskId,
      runId,
      generation,
      expectedGeneration,
      eligibleStatuses,
      new Date().toISOString(),
    );
    if (!claimed) {
      run.status = "failed";
      run.errorCode = "stale_generation";
      run.finishedAt = new Date().toISOString();
      this.store.updateRun(run);
      throw new BridgeError(ExitCode.ABORTED, handle.reason === "timeout" ? "任务超时" : "任务已被取消或状态已变化，拒绝执行过期请求");
    }

    const scopeNote = scopePrefixes.length ? `\n允许范围(scope): ${scopePrefixes.join(", ")}` : "\n允许范围(scope): 整个工作目录";
    const constraints = req.constraints.length ? `\n禁止事项:\n- ${req.constraints.join("\n- ")}` : "";
    const stops = req.stopConditions.length ? `\n停止条件(命中即停止并说明):\n- ${req.stopConditions.join("\n- ")}` : "";
    const allowWrite = req.policy.allowWrite ? "允许写入文件" : "只读/分析模式，不得修改文件";

    const prompt =
      `你是由 Bridge 调度的执行 Worker。工作目录: ${workspace}\n` +
      `任务标题: ${req.title}\n` +
      `模式: ${req.mode}\n` +
      `权限: ${allowWrite}${scopeNote}${constraints}${stops}\n\n` +
      `目标:\n${req.objective}\n\n` +
      `请实际执行（使用真实工具读写/运行命令）。完成后用简短文字总结你所做的改动与结果；` +
      `不要声称「已完成」而不实际修改文件。验收命令由 Bridge 独立执行，你无需自证。`;

    const continueSession = this.sessions.canContinue(taskId, workspace, model);
    const sessionBinding = this.sessions.get(taskId);

    // Whole-run timeout: covers startup/session/prompt/worker AND the verifier below.
    // On fire we first invalidate the run (record timeout/failed), THEN abort.
    const timeoutMs = req.policy.timeoutSeconds * 1000;
    const timer = setTimeout(() => {
      handle.reason = handle.reason ?? "timeout";
      this.invalidateRun(taskId, runId, generation, "timeout");
      handle.controller.abort();
    }, timeoutMs);

    try {
    let outcome;
    try {
      outcome = await this.supervisor.runPrompt(
        {
          taskId,
          runId,
          workspace,
          model,
          prompt,
          maxTurns: req.policy.maxWorkerTurns,
          timeoutMs,
          logDir: runDir,
          continueSession,
          sessionPath: sessionBinding?.sessionPath ?? null,
        },
        {},
        handle.controller.signal,
      );
    } catch (err) {
      // Only record failure if this run is still current; a cancelled/superseded
      // run must not flip a newer task state (§7.2).
      if (this.isRunActive(taskId, runId, generation)) {
        run.status = "failed";
        run.errorCode = err instanceof BridgeError ? `exit_${err.code}` : "run_error";
        run.finishedAt = new Date().toISOString();
        this.store.updateRun(run);
        this.writeGuardedStatus(taskId, runId, generation, "failed");
      }
      throw err;
    }

    // Fail-closed: a cancel/timeout that landed during the run supersedes the
    // generation; discard all late session/verifier/handoff/usage writes.
    if (!this.isRunActive(taskId, runId, generation)) {
      throw this.abortError(handle);
    }

    // Record session for continuation (only while this run is current).
    if (outcome.sessionPath) {
      this.sessions.set({ taskId, workspace, model, sessionPath: outcome.sessionPath });
    }
    run.piSessionPath = outcome.sessionPath;

    // --- real verification (independent of worker prose) -----------------
    let bundle: VerificationBundle = { results: [], acceptance: "not_run" };
    if (this.isRunActive(taskId, runId, generation)) {
      try {
        bundle = await runVerifier(req.acceptance, {
          workspace,
          logDir: runDir,
          defaultTimeoutSeconds: this.cfg.limits.verifyTimeoutSeconds,
          maxLogBytes: this.cfg.limits.maxRunLogBytes,
          signal: handle.controller.signal,
          terminateWaitMs: this.cfg.limits.verifyTerminateWaitMs,
        });
      } catch (err) {
        // Verifier could not prove its process tree terminated: fail closed and block
        // any further serial work rather than risk overlapping side effects.
        this.blockedReason = (err as Error).message || "verifier 进程树未确认终止";
        throw err;
      }
      if (this.isRunActive(taskId, runId, generation)) {
        for (const v of bundle.results) {
          if (v.logRef && existsSync(v.logRef)) {
            this.store.insertArtifact({
              runId,
              kind: "verify_log",
              path: v.logRef,
              artifactKey: "",
              sizeBytes: 0,
            });
          }
        }
      }
    }

    // --- diff + scope check ----------------------------------------------
    const diff = gitDiff(workspace);
    const outOfScope = scopePrefixes.length
      ? diff.changedFiles.filter((f) => !inScope(f.path, scopePrefixes))
      : [];
    const risks = [...riskNotes];
    if (this.cfg.backend === "dsh") risks.push("DSH headless: fresh session per task/resume; internal turn/tool counts and usage unavailable; maxWorkerTurns is not enforced inside DSH. Host timeout and independent acceptance remain enforced.");
    let stopReason = outcome.stopReason;
    if (outOfScope.length) {
      risks.push(`改动超出 scope: ${outOfScope.map((f) => f.path).join(", ")}`);
    }

    // --- stop conditions --------------------------------------------------
    let executionOk = outcome.settled && !outcome.errorCode;
    if (outcome.errorCode) risks.push(`执行错误: ${outcome.errorCode}`);
    if (stopReason?.startsWith("stop:")) executionOk = false;
    if (req.policy.requireCleanDiff && outOfScope.length) {
      stopReason = "blocked:out_of_scope_change";
      executionOk = false;
    }
    if (!req.policy.allowWrite && diff.changedFiles.length) {
      stopReason = "blocked:write_in_readonly_mode";
      executionOk = false;
    }

    const handoff = buildHandoff({
      taskId,
      runId,
      workerModel: model,
      workerFinalText: outcome.finalText,
      changedFiles: diff.changedFiles,
      diffSummary: diff.summary,
      verification: bundle.results,
      acceptance: bundle.acceptance,
      executionOk,
      stopReason,
      risks,
      rawLogRef: outcome.rawLogRef,
      summaryMaxTokens: this.cfg.limits.summaryMaxTokens,
      summaryMaxChars: this.cfg.limits.summaryMaxChars,
    });

    // Final fail-closed guard: if the task was cancelled/timed out while the
    // verifier ran, drop the late writes and refuse to report a result.
    if (!this.isRunActive(taskId, runId, generation)) {
      throw this.abortError(handle);
    }

    // Persist handoff + usage.
    this.store.insertHandoff({
      id: newId("handoff"),
      runId,
      taskId,
      status: handoff.status,
      payloadJson: serializeHandoff(handoff),
      createdAt: new Date().toISOString(),
    });
    this.store.insertModelUsage({
      runId,
      source: "pi_rpc",
      inputTokens: outcome.usage.input,
      outputTokens: outcome.usage.output,
      reportedCost: outcome.usage.cost,
      measurement: "provider_reported",
    });

    run.status = outcome.settled ? "settled" : outcome.errorCode ? "failed" : "timeout";
    run.finishedAt = new Date().toISOString();
    run.errorCode = outcome.errorCode;
    this.store.updateRun(run);

    const finalStatus = mapTaskStatus(handoff.status, outcome);
    this.writeGuardedStatus(taskId, runId, generation, finalStatus);

    return handoff;
    } finally {
      // Cleared only after the WHOLE run (worker AND verifier) is done, so the
      // timeout truly covers verification too.
      clearTimeout(timer);
    }
  }

  private abortError(handle: RunHandle): BridgeError {
    return new BridgeError(ExitCode.ABORTED, handle.reason === "timeout" ? "任务超时" : "任务已取消");
  }

  /** True when (runId, generation) is still the task's current run/generation. */
  private isRunActive(taskId: string, runId: string, generation: number): boolean {
    const t = this.store.getTask(taskId);
    return !!t && t.activeRunId === runId && t.generation === generation;
  }

  /**
   * Invalidate a run before aborting it (used by the whole-run timeout): supersede
   * the task generation (clear activeRunId, mark failed) and record the run timeout.
   */
  private invalidateRun(taskId: string, runId: string, generation: number, reason: AbortReason): void {
    const now = new Date().toISOString();
    const t = this.store.getTask(taskId);
    if (t && t.activeRunId === runId && t.generation === generation) {
      this.store.supersedeTask(taskId, generation + 1, generation, "failed", now);
    }
    const r = this.store.getRun(runId);
    if (r && r.status === "running") {
      r.status = reason === "timeout" ? "timeout" : "cancelled";
      r.errorCode = reason;
      r.finishedAt = now;
      this.store.updateRun(r);
    }
  }

  /**
   * Generation-guarded status write. If the write affects 0 rows, the result is stale:
   * we only archive, never update the task's latest state (§7.2).
   */
  private writeGuardedStatus(taskId: string, runId: string, generation: number, status: TaskStatus): void {
    const ok = this.store.updateTaskStatusGuarded(taskId, status, runId, generation, new Date().toISOString());
    if (!ok) {
      // Result is stale (cancelled/newer generation). Archive only.
      const archiveDir = join(this.cfg.home, "logs", "stale");
      mkdirSync(archiveDir, { recursive: true });
      void redactText(JSON.stringify({ taskId, runId, generation, status, at: new Date().toISOString() }));
    }
  }

  getStatus(taskId: string) {
    const task = this.store.getTask(taskId);
    if (!task) return null;
    const runs = this.store.listRuns(taskId);
    const handoffs = this.store.listHandoffs(taskId);
    return { task, runs, latestHandoff: handoffs.length ? handoffs[handoffs.length - 1] : null };
  }

  listStatus() {
    return this.store.listTasks().map((t) => {
      const runs = this.store.listRuns(t.id);
      return { ...t, runCount: runs.length, lastRun: runs.length ? runs[runs.length - 1] : null };
    });
  }

  /**
   * Cancel a task: synchronously (before ANY await) atomically supersede its
   * generation, clear activeRunId and mark it cancelled, then signal ONLY that
   * task's run. Other tasks/runs are untouched.
   */
  async cancel(taskId: string): Promise<boolean> {
    const task = this.store.getTask(taskId);
    if (!task) throw new BridgeError(ExitCode.BAD_REQUEST, `task 不存在: ${taskId}`);
    if (!CANCEL_ELIGIBLE.includes(task.status)) return false;

    const now = new Date().toISOString();
    const nextGeneration = task.generation + 1;
    // Synchronous atomic supersede — no await before this point.
    const ok = this.store.supersedeTask(taskId, nextGeneration, task.generation, "cancelled", now);
    if (!ok) return false;

    // Mark this task's own running run cancelled (never another task's run).
    if (task.activeRunId) {
      const active = this.store.getRun(task.activeRunId);
      if (active && active.taskId === taskId && active.status === "running") {
        active.status = "cancelled";
        active.finishedAt = now;
        active.errorCode = "cancelled";
        this.store.updateRun(active);
      }
    }

    // Signal only the run belonging to this task.
    const handle = this.findHandle(taskId);
    if (handle) {
      handle.reason = handle.reason ?? "cancelled";
      handle.controller.abort();
    }
    // Free the task for a legitimate subsequent resume; the cancelled handle still
    // drains (its writes are generation-guarded) and its pump cleanup will not clear
    // a newer handle's marker.
    this.inFlight.delete(taskId);
    return true;
  }

  private findHandle(taskId: string): RunHandle | undefined {
    if (this.current && this.current.taskId === taskId) return this.current;
    return this.queue.find((h) => h.taskId === taskId);
  }

  /**
   * Resume a task by creating a NEW run that continues the session. The stored
   * request is RE-PARSED and RE-VALIDATED (authorization, scope, enforceability)
   * rather than trusted as JSON.
   */
  async resume(taskId: string): Promise<{ taskId: string; wait: Promise<Handoff | null> }> {
    const task = this.store.getTask(taskId);
    if (!task) throw new BridgeError(ExitCode.BAD_REQUEST, `task 不存在: ${taskId}`);
    if (!RESUME_ELIGIBLE.includes(task.status)) {
      throw new BridgeError(ExitCode.BAD_REQUEST, `任务状态 ${task.status} 不允许 resume（终态需新建 task）`);
    }
    if (this.inFlight.has(taskId)) {
      throw new BridgeError(ExitCode.LIMIT, `任务已在执行或排队: ${taskId}`);
    }
    this.assertAccepting();

    const req = parseTaskRequest(JSON.parse(task.requestJson));
    const workspace = assertAuthorized(req.workspace, this.policies.authorizedRoots());
    const scopePrefixes = validateScope(workspace, req.scope);
    assertEnforceableRun(req.policy, scopePrefixes);
    const model = req.model ?? configuredModel(this.cfg);
    if (this.cfg.backend === "dsh" && model !== "default") throw new BridgeError(ExitCode.BAD_REQUEST, "DSH headless uses its own configured model; omit task.model");
    const waitPromise = this.enqueue(taskId, req, workspace, model, scopePrefixes, task.generation, RESUME_ELIGIBLE);
    return { taskId, wait: waitPromise };
  }

  /** Mark any tasks left in running/pending state after a crash as interrupted (AC-09). */
  recoverAfterRestart(): number {
    let n = 0;
    for (const t of this.store.listTasks()) {
      if (t.status === "running" || t.status === "pending") {
        const ok = this.store.supersedeTask(t.id, t.generation + 1, t.generation, "interrupted", new Date().toISOString());
        if (ok) n++;
      }
    }
    return n;
  }

  /**
   * Shut down for daemon stop: synchronously INVALIDATE every queued/active task
   * (supersede generation + mark interrupted/cancelled) so no late run/verifier/
   * handoff write can land, then abort and drain. Throws if the serial consumer does
   * not settle within the budget, so the daemon does NOT close the store or claim it
   * stopped while writes could still be in flight.
   */
  async shutdown(timeoutMs = 20_000): Promise<void> {
    this.stopping = true;
    const now = new Date().toISOString();
    const handles = [...this.queue, ...(this.current ? [this.current] : [])];
    for (const h of handles) {
      const t = this.store.getTask(h.taskId);
      if (t && (t.status === "running" || t.status === "pending")) {
        this.store.supersedeTask(h.taskId, t.generation + 1, t.generation, "interrupted", now);
      }
      const r = this.store.getRun(h.runId);
      if (r && r.status === "running") {
        r.status = "cancelled";
        r.errorCode = "shutdown";
        r.finishedAt = now;
        this.store.updateRun(r);
      }
    }
    for (const h of handles) h.controller.abort();

    const deadline = Date.now() + timeoutMs;
    while ((this.current || this.queue.length) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.current || this.queue.length) {
      throw new BridgeError(
        ExitCode.UNAVAILABLE,
        "engine 未能在超时内停止串行执行；为避免丢失/迟到写入，未关闭 store",
      );
    }
  }
}

function mapTaskStatus(handoffStatus: Handoff["status"], outcome: { settled: boolean; stopReason: string | null }): TaskStatus {
  switch (handoffStatus) {
    case "passed":
      return "succeeded";
    case "blocked":
      return "blocked";
    case "partial":
      return "needs_review";
    case "failed":
    default:
      return outcome.stopReason?.startsWith("stop:timeout") ? "failed" : "failed";
  }
}
