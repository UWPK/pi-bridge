import { piWorkerArgs, validatePiWorkerSupport } from "./worker-profile.js";
import { configuredModel } from "./config.js";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { PiRpcProcess } from "./rpc-client.js";
import type { JsonAgentSessionEvent } from "./pi-types.js";
import { redactText } from "./redact.js";
import { BridgeError, ExitCode } from "./errors.js";
import type { BridgeConfig } from "./types.js";

/**
 * Single-worker supervisor (需求文档 §3.1, §3.3, §6).
 *
 * One pi RPC process at a time. The process is long-lived: a short-lived CLI call or
 * daemon restart does not recreate it. cwd and model are fixed when the process is
 * spawned, so switching either requires a fresh process.
 *
 * Termination discipline (P0):
 *   - A run accepts an AbortSignal from the caller (cancel/timeout/daemon stop). The
 *     current run is registered BEFORE startup so a cancel during ensureWorker/
 *     newSession is honoured, not just during the model turn.
 *   - Startup is abort-aware and its cleanup is AWAITED: we never release the serial
 *     lock while a half-started worker is still alive (no fire-and-forget race).
 *   - After cancel/timeout/maxTurns/error the worker is RETIRED (abort + kill tree +
 *     await provable exit) and never reused. If termination cannot be confirmed the
 *     supervisor latches `stuck` and refuses to start the next run.
 *   - An unexpected worker exit settles the run immediately instead of waiting out
 *     the whole-run timeout.
 *   - All lifecycle operations (ensureWorker / retire / shutdown) are mutually
 *     exclusive so a diagnostic can never repoint the worker under an active run.
 */

export interface RunCallbacks {
  onEvent?: (event: JsonAgentSessionEvent) => void;
  onToolStart?: (toolName: string, args: unknown) => void;
}

export interface RunOutcome {
  finalText: string;
  settled: boolean;
  aborted: boolean;
  turnCount: number;
  toolCalls: number;
  usage: { input: number | null; output: number | null; total: number | null; cost: number | null };
  stopReason: string | null;
  rawLogRef: string;
  errorCode: string | null;
  /** Session file path to persist for later continuation, or null. */
  sessionPath: string | null;
}

export interface RunOptions {
  taskId: string;
  runId: string;
  workspace: string;
  model: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
  logDir: string;
  /** If continueSession, we do NOT create a new session first. */
  continueSession: boolean;
  sessionPath?: string | null;
}

interface WorkerSlot {
  actualModel?: string | null;
  thinkingLevel?: string | null;
  process: PiRpcProcess;
  workspace: string;
  model: string;
}

/** Reject as soon as `signal` aborts, racing a bounded promise. */
function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined, message = "运行已取消"): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new BridgeError(ExitCode.ABORTED, message));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BridgeError(ExitCode.ABORTED, message));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export class PiSupervisor {
  private slot: WorkerSlot | null = null;
  private profileValidated = false;
  private currentRun: { runId: string; taskId: string; cancel: () => void } | null = null;
  /** Set when a killed worker could not be confirmed dead; blocks the next run. */
  private stuckReason: string | null = null;
  /** Serializes all worker lifecycle transitions. */
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private cfg: BridgeConfig) {}

  get pid(): number | null {
    return this.slot?.process.pid ?? null;
  }

  get workspace(): string | null {
    return this.slot?.workspace ?? null;
  }

  get model(): string | null {
    return this.slot?.model ?? null;
  }

  get isAlive(): boolean {
    return !!this.slot?.process.isAlive;
  }

  get activeRunId(): string | null {
    return this.currentRun?.runId ?? null;
  }

  get stuck(): string | null {
    return this.stuckReason;
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycle;
    let release!: () => void;
    this.lifecycle = new Promise<void>((r) => (release = r));
    return prev.then(fn).finally(() => release());
  }

  private assertNotStuck(): void {
    if (this.stuckReason) {
      throw new BridgeError(
        ExitCode.UNAVAILABLE,
        `worker 未被清理干净（${this.stuckReason}）；为避免并发执行，已阻止启动新运行。请重启 bridge daemon。`,
      );
    }
  }

  /** Ensure a worker with the requested cwd+model exists; reuse if it already matches. */
  ensureWorker(workspace: string, model: string, signal?: AbortSignal): Promise<PiRpcProcess> {
    return this.runExclusive(() => this.ensureWorkerInner(workspace, model, signal));
  }

  private async ensureWorkerInner(workspace: string, model: string, signal?: AbortSignal): Promise<PiRpcProcess> {
    this.assertNotStuck();
    if (this.slot && this.slot.process.isAlive && this.slot.workspace === workspace && this.slot.model === model) {
      return this.slot.process;
    }
    if (signal?.aborted) throw new BridgeError(ExitCode.ABORTED, "运行已取消");

    // Different cwd/model (or dead): retire the old process before starting a new one.
    if (this.slot) {
      const old = this.slot;
      const ok = await old.process.stop(2000);
      if (!ok) {
        this.stuckReason = `旧 pi 进程 pid=${old.process.pid} 未能在超时内终止`;
        throw new BridgeError(ExitCode.UNAVAILABLE, this.stuckReason);
      }
      if (this.slot === old) this.slot = null;
    }

    const loaderArgs = piWorkerArgs(this.cfg.pi);
    if (!this.profileValidated) {
      validatePiWorkerSupport(this.cfg.pi, loaderArgs);
      this.profileValidated = true;
    }
    const [provider, modelId] = splitModel(model);
    const proc = new PiRpcProcess({
      cliPath: this.cfg.pi.cliPath,
      nodePath: this.cfg.pi.nodePath,
      cwd: workspace,
      provider,
      model: modelId,
      args: ["--session-dir", join(this.cfg.home, "sessions"), ...loaderArgs],
    });
    // Cancel during startup must still tear the freshly-spawned process down; the
    // stop is single-flight with the catch-path stop below and its result is awaited.
    const onAbort = () => {
      void proc.stop(2000);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      await proc.start(this.cfg.worker.startupTimeoutMs);
      this.throwIfAborted(signal);
      // Health check via a documented command (docs/rpc.md: get_state).
      const state = await proc.getState(this.cfg.worker.startupTimeoutMs);
      this.throwIfAborted(signal);
      const actual = state.model ? `${state.model.provider}/${state.model.id}` : "(none)";
      if (state.model && actual !== model && provider && modelId) {
        // Try to align the model explicitly, then fail loudly if we can't.
        await proc.setModel(provider, modelId, 30_000);
        this.throwIfAborted(signal);
      }
      const ready = state.model && actual !== model && provider && modelId ? await proc.getState(this.cfg.worker.startupTimeoutMs) : state;
      this.throwIfAborted(signal);
      this.slot = { process: proc, workspace, model, actualModel: ready.model ? `${ready.model.provider}/${ready.model.id}` : null, thinkingLevel: ready.thinkingLevel ?? null };
      return proc;
    } catch (err) {
      const ok = await proc.stop(2000);
      if (!ok) this.stuckReason = `新 pi 进程 pid=${proc.pid} 未能在超时内终止`;
      throw err;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new BridgeError(ExitCode.ABORTED, "运行已取消");
  }

  async doctor(): Promise<{ ok: boolean; pid: number | null; model: string | null; startupMs: number }> {
    const t0 = Date.now();
    const proc = await this.ensureWorker(this.slot?.workspace ?? this.warmupDir(), this.defaultModel());
    const state = await proc.getState(this.cfg.worker.startupTimeoutMs);
    return {
      ok: !!state.model,
      pid: proc.pid,
      model: state.model ? `${state.model.provider}/${state.model.id}` : null,
      startupMs: Date.now() - t0,
    };
  }

  private defaultModel(): string {
    return configuredModel(this.cfg);
  }

  /** Neutral workspace used only to warm/verify a worker without user authorization. */
  private warmupDir(): string {
    const dir = join(this.cfg.home, "warmup");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Ensure a worker exists (for models listing) without requiring an authorized workspace. */
  async ensureForModels(): Promise<Array<{ provider: string; id: string }>> {
    if (!this.slot || !this.slot.process.isAlive) {
      await this.ensureWorker(this.warmupDir(), this.defaultModel());
    }
    return this.slot!.process.getAvailableModels(30_000).then((r) => r.models ?? []);
  }

  getAvailableModels(): Promise<Array<{ provider: string; id: string }>> {
    if (!this.slot) throw new BridgeError(ExitCode.UNAVAILABLE, "pi worker 未启动");
    return this.slot.process.getAvailableModels(30_000).then((r) => r.models ?? []);
  }

  /** Directory holding raw verify logs for a run. */
  runLogDir(runId: string): string {
    return join(this.cfg.home, "logs", runId);
  }

  /** Cached worker status for diagnostics that must not disturb an active run. */
  workerSnapshot() {
    return {
      alive: this.isAlive,
      pid: this.pid,
      workspace: this.workspace,
      model: this.model,
      stuck: this.stuckReason,
      actualModel: this.slot?.actualModel ?? null,
      thinkingLevel: this.slot?.thinkingLevel ?? null,
      profile: this.cfg.pi.profile ?? "inherit",
      loaderArgs: piWorkerArgs(this.cfg.pi),
    };
  }

  /**
   * Retire (never reuse) the current worker: ask it to abort (concurrently, bounded),
   * then kill the whole process tree and confirm it is gone. The slot (and its pid)
   * is retained when termination cannot be confirmed.
   */
  private retireWorker(expected?: PiRpcProcess | null): Promise<void> {
    return this.runExclusive(() => this.retireWorkerInner(expected));
  }

  private async retireWorkerInner(expected?: PiRpcProcess | null): Promise<void> {
    const slot = this.slot;
    if (!slot) return;
    if (expected && slot.process !== expected) return;
    const proc = slot.process;
    if (proc.isAlive) {
      await Promise.allSettled([proc.clearQueue(3000), proc.abort(3000), proc.abortBash(3000)]);
    }
    const confirmed = await proc.stop(this.cfg.worker.abortGraceMs);
    if (confirmed) {
      if (this.slot === slot) this.slot = null;
    } else {
      this.stuckReason = `pi 进程树 pid=${proc.pid} 未能在超时内终止`;
    }
  }

  /**
   * Run one prompt to completion (agent_settled), timeout or abort.
   * The caller owns the timeout and passes an AbortSignal; this method also listens
   * for an unexpected worker exit so it settles promptly.
   */
  async runPrompt(opts: RunOptions, callbacks: RunCallbacks = {}, signal?: AbortSignal): Promise<RunOutcome> {
    this.assertNotStuck();
    if (this.currentRun) {
      throw new BridgeError(ExitCode.LIMIT, `已有活动运行 ${this.currentRun.runId}，单 Worker 串行执行`);
    }

    let cancelled = false;
    let exceededMaxTurns = false;
    let workerExited = false;
    let proc: PiRpcProcess | null = null;

    let resolveSettle: () => void = () => {};
    const settledPromise = new Promise<void>((res) => (resolveSettle = res));
    const requestCancel = () => {
      cancelled = true;
      resolveSettle();
    };

    // Register the run BEFORE any await so a cancel during startup/newSession is honoured.
    this.currentRun = { runId: opts.runId, taskId: opts.taskId, cancel: requestCancel };
    const onAbort = () => requestCancel();
    if (signal) {
      if (signal.aborted) cancelled = true;
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    let finalText = "";
    let settled = false;
    let aborted = false;
    let turnCount = 0;
    let toolCalls = 0;
    let stopReason: string | null = null;
    let errorCode: string | null = null;
    let sessionPath: string | null = opts.sessionPath ?? null;
    const usage = { input: null as number | null, output: null as number | null, total: null as number | null, cost: null as number | null };

    if (!existsSync(opts.logDir)) mkdirSync(opts.logDir, { recursive: true });
    const rawLogRef = join(opts.logDir, "pi-events.jsonl");
    const logStream = createWriteStream(rawLogRef, { flags: "a" });
    logStream.on("error", () => {
      /* ignore async write errors (e.g. log dir removed during teardown) */
    });
    const writeEvent = (evt: unknown) => {
      try {
        logStream.write(redactText(JSON.stringify(evt)) + "\n");
      } catch {
        /* ignore */
      }
    };

    let unsubscribe: () => void = () => {};
    let removeExit: () => void = () => {};

    try {
      // No fire-and-forget race here: ensureWorker is abort-aware and awaits its own
      // cleanup, so a cancel during startup cannot leave a live process behind.
      proc = await this.ensureWorker(opts.workspace, opts.model, signal);
      this.throwIfAborted(signal);

      // If the worker died between startup and listener registration, settle now
      // rather than hang until the whole-run timeout.
      if (!proc.isAlive) {
        workerExited = true;
        errorCode = "worker_exited";
        stopReason = "error:worker_exited";
        throw new BridgeError(ExitCode.UNAVAILABLE, "pi worker 启动后立即退出");
      }

      // Settle promptly if the worker dies unexpectedly (do not wait for timeout).
      removeExit = proc.onExit(() => {
        workerExited = true;
        errorCode = errorCode ?? "worker_exited";
        stopReason = stopReason ?? "error:worker_exited";
        resolveSettle();
      });

      // Session isolation: new task in same cwd/model uses new_session; continuation
      // reuses the persistent session file via switch_session if provided.
      if (opts.continueSession && opts.sessionPath) {
        try {
          await raceAbort(proc.switchSession(opts.sessionPath, 30_000), signal);
        } catch (err) {
          if (signal?.aborted) throw err;
          await proc.newSession(30_000); // safe fallback; recorded as interrupted by caller
          sessionPath = null;
        }
      } else {
        await raceAbort(proc.newSession(30_000), signal);
        sessionPath = null;
      }
      this.throwIfAborted(signal);

      const listener = (event: JsonAgentSessionEvent) => {
        writeEvent(event);
        callbacks.onEvent?.(event);
        const t = (event as { type: string }).type;
        switch (t) {
          case "turn_start":
            turnCount++;
            if (turnCount > opts.maxTurns) {
              exceededMaxTurns = true;
              stopReason = `stop:maxWorkerTurns(${opts.maxTurns})`;
              // ask pi to stop, then pretend settled
              proc?.abort(20_000).catch(() => {});
              resolveSettle();
            }
            break;
          case "tool_execution_start": {
            toolCalls++;
            const e = event as { toolName?: string; args?: unknown };
            callbacks.onToolStart?.(e.toolName ?? "unknown", e.args);
            break;
          }
          case "message_update": {
            const e = event as { usage?: { input?: number; output?: number; totalTokens?: number; cost?: { total?: number } } };
            if (e.usage) {
              if (typeof e.usage.input === "number") usage.input = e.usage.input;
              if (typeof e.usage.output === "number") usage.output = e.usage.output;
              if (typeof e.usage.totalTokens === "number") usage.total = e.usage.totalTokens;
              if (e.usage.cost && typeof e.usage.cost.total === "number") usage.cost = e.usage.cost.total;
            }
            break;
          }
          case "message_end": {
            const e = event as { message?: { role?: string; content?: unknown } };
            const text = extractText(e.message);
            if (text) finalText = text;
            break;
          }
          case "bridge_worker_error": {
            errorCode = "backend_failed";
            stopReason = `error:${(event as unknown as { message?: string }).message || "backend failed"}`;
            resolveSettle();
            break;
          }
          case "agent_settled": {
            aborted = !!(event as { aborted?: boolean }).aborted;
            settled = true;
            resolveSettle();
            break;
          }
          case "auto_retry_end": {
            const e = event as { success?: boolean; finalError?: string };
            if (e.success === false) stopReason = `model_error:${e.finalError ?? "unknown"}`;
            break;
          }
          case "compaction_end": {
            const e = event as { errorMessage?: string; aborted?: boolean };
            if (e.errorMessage) stopReason = `compaction_error:${e.errorMessage}`;
            break;
          }
          default:
            break;
        }
      };

      unsubscribe = proc.onEvent(listener);

      // Subscribe is already active; now send the prompt.
      const resp = await raceAbort(proc.prompt(opts.prompt, 60_000), signal);
      const disposition = (resp.data as { disposition?: string } | undefined)?.disposition;
      if (!resp.success) {
        errorCode = "prompt_rejected";
        throw new BridgeError(ExitCode.UNAVAILABLE, `prompt 被拒绝: ${resp.error ?? "unknown"}`);
      }
      if (disposition === "handled") {
        // No run started for this prompt; do not wait for agent_settled.
        settled = true;
      } else {
        await settledPromise;
      }
    } catch (err) {
      if (err instanceof BridgeError && err.code === ExitCode.ABORTED) {
        cancelled = true;
      } else if (err instanceof BridgeError && err.code === ExitCode.UNAVAILABLE) {
        errorCode = errorCode ?? "pi_unavailable";
        stopReason = stopReason ?? `error:${err.message}`;
      } else {
        errorCode = errorCode ?? "run_error";
        stopReason = stopReason ?? `error:${(err as Error).message}`;
      }
    } finally {
      // Best-effort stats collection, but WITHOUT swallowing a cancel/timeout: the
      // abort listener stays active and every RPC is raced against the signal, so an
      // abort during this phase cannot be missed (which would otherwise leave the old
      // worker un-retired and reused).
      try {
        const normalSettle =
          settled && !cancelled && !exceededMaxTurns && !workerExited && errorCode === null && !!proc && proc.isAlive && !signal?.aborted;
        if (normalSettle && proc) {
          if (!finalText) {
            try {
              const last = await raceAbort(proc.getLastAssistantText(15_000), signal);
              if (last.text) finalText = last.text;
            } catch {
              /* aborted or failed */
            }
          }
          if (!signal?.aborted) {
            try {
              const stats = await raceAbort(proc.getSessionStats(15_000), signal);
              if (stats.tokens) {
                usage.input = usage.input ?? stats.tokens.input ?? null;
                usage.output = usage.output ?? stats.tokens.output ?? null;
                usage.total = usage.total ?? stats.tokens.total ?? null;
              }
              if (typeof stats.cost === "number") usage.cost = stats.cost;
            } catch {
              /* aborted or failed */
            }
          }
          if (!signal?.aborted && !sessionPath) {
            try {
              const st = await raceAbort(proc.getState(15_000), signal);
              sessionPath = st.sessionFile ?? null;
            } catch {
              /* aborted or failed */
            }
          }
        }
      } finally {
        // Re-evaluate retirement AFTER stats: an abort during stats must still retire
        // the worker and must not let the run report success.
        if (signal?.aborted) cancelled = true;
        const mustRetire = cancelled || exceededMaxTurns || workerExited || errorCode !== null || !settled;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (mustRetire) await this.retireWorker(proc);
        this.currentRun = null;
        logStream.end();
        unsubscribe();
        removeExit();
        if (cancelled) stopReason = stopReason ?? "stop:cancelled";
      }
    }

    return {
      finalText,
      settled: settled && !cancelled,
      aborted,
      turnCount,
      toolCalls,
      usage,
      stopReason,
      rawLogRef,
      errorCode,
      sessionPath,
    };
  }

  async shutdown(): Promise<void> {
    if (this.currentRun) this.currentRun.cancel();
    await this.runExclusive(async () => {
      const slot = this.slot;
      if (!slot) return;
      const confirmed = await slot.process.stop(5000);
      if (confirmed) {
        if (this.slot === slot) this.slot = null;
      } else {
        this.stuckReason = `pi 进程树 pid=${slot.process.pid} 未能在超时内终止`;
      }
    });
  }
}

function splitModel(model: string): [string | undefined, string | undefined] {
  if (!model || model === "default") return [undefined, undefined];
  const idx = model.indexOf("/");
  if (idx < 0) return [undefined, model];
  return [model.slice(0, idx), model.slice(idx + 1)];
}

function extractText(message: { content?: unknown } | undefined): string {
  if (!message || !message.content) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          return String((block as { text?: string }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
}
