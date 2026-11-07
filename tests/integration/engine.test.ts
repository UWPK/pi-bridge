import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../src/persistence.js";
import { defaultConfig } from "../../src/config.js";
import { PolicyStore } from "../../src/policies.js";
import { PiSupervisor } from "../../src/supervisor.js";
import { SessionManager } from "../../src/session-manager.js";
import { TaskEngine } from "../../src/tasks.js";
import { parseTaskRequest, type ParsedTaskRequest } from "../../src/schema.js";
import { BridgeError } from "../../src/errors.js";
import { createFixtureGitProject, passCommand, failCommand } from "../fixtures/create-fixture.js";

/**
 * Integration test for the full orchestration path using a *real* spawned child
 * process that speaks the documented pi RPC protocol. This exercises the actual
 * spawn/RPC/verify/handoff code without requiring model credentials.
 *
 * IMPORTANT: the fake peer is a PROTOCOL peer, NOT a real model. Nothing here is a
 * substitute for real-model acceptance; the real path is covered only by
 * tests/smoke (which skips without credentials). These tests prove the state
 * machine, generation guards, cancellation and process-tree termination.
 */

const FAKE_PI = `
const readline = require("node:readline");
const fs = require("node:fs");
const rl = readline.createInterface({ input: process.stdin });
function send(o){ process.stdout.write(JSON.stringify(o) + "\\n"); }
function respond(id, command, data){ send({ id, type: "response", command, success: true, data }); }
const behavior = process.env.FAKE_PI_BEHAVIOR || "pass";
const writeRel = process.env.FAKE_PI_WRITE || "";
const hangStartup = process.env.FAKE_PI_HANG_STARTUP === "1";
function runPrompt(id){
  respond(id, "prompt", { disposition: "started" });
  send({ type: "agent_start" });
  send({ type: "turn_start" });
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  if (writeRel) { try { fs.writeFileSync(writeRel, "worker-change\\n"); } catch(e){} }
  const finish = () => {
    const text = behavior === "fail" ? "I attempted the task but tests fail." : "Done: applied the requested change.";
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
    send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    send({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
    send({ type: "agent_end", messages: [], willRetry: false });
    send({ type: "agent_settled", aborted: false });
  };
  const delay = Number(process.env.FAKE_PI_DELAY_MS || "0");
  if (process.env.FAKE_PI_NO_SETTLE === "1") return;
  if (process.env.FAKE_PI_EXIT_AFTER_PROMPT === "1") { process.exit(0); }
  if (delay > 0) setTimeout(finish, delay); else finish();
}
rl.on("line", (line) => {
  if (!line.trim()) return;
  let cmd; try { cmd = JSON.parse(line); } catch { return; }
  switch (cmd.type) {
    case "get_state":
      if (hangStartup) break;
      respond(cmd.id, "get_state", { model: { provider: "fixture-provider", id: "fixture-model" }, sessionFile: "/tmp/session-" + process.pid + ".jsonl", isStreaming: false });
      break;
    case "new_session": respond(cmd.id, "new_session", { cancelled: false }); break;
    case "switch_session": respond(cmd.id, "switch_session", { cancelled: false }); break;
    case "set_model": respond(cmd.id, "set_model", { provider: cmd.provider, id: cmd.modelId }); break;
    case "get_available_models": respond(cmd.id, "get_available_models", { models: [{ provider: "fixture-provider", id: "fixture-model" }] }); break;
    case "get_last_assistant_text": respond(cmd.id, "get_last_assistant_text", { text: "Done: applied the requested change." }); break;
    case "get_session_stats": {
      const d = Number(process.env.FAKE_PI_STATS_DELAY_MS || "0");
      const payload = { tokens: { input: 100, output: 20, total: 120 }, cost: 0.001 };
      if (d > 0) setTimeout(() => respond(cmd.id, "get_session_stats", payload), d);
      else respond(cmd.id, "get_session_stats", payload);
      break;
    }
    case "clear_queue": respond(cmd.id, "clear_queue", { steering: [], followUp: [] }); break;
    case "abort": respond(cmd.id, "abort", {}); break;
    case "abort_bash": respond(cmd.id, "abort_bash", {}); break;
    case "prompt": runPrompt(cmd.id); break;
    default: respond(cmd.id, cmd.type, {});
  }
});
`;

interface Ctx {
  fx: ReturnType<typeof createFixtureGitProject>;
  home: string;
  fakePi: string;
  cfg: ReturnType<typeof defaultConfig>;
  engine: TaskEngine;
  supervisor: PiSupervisor;
  store: Awaited<ReturnType<typeof openStore>>;
}

async function makeCtx(): Promise<Ctx> {
  const fx = createFixtureGitProject("engine");
  const home = mkdtempSync(join(tmpdir(), "bridge-home-"));
  const fakePi = join(home, "fake-pi.cjs");
  writeFileSync(fakePi, FAKE_PI, "utf8");

  const cfg = defaultConfig({ home });
  cfg.pi.cliPath = fakePi;
  cfg.pi.nodePath = process.execPath;
  cfg.worker.startupTimeoutMs = 20_000;

  const store = await openStore(join(home, "db.sqlite"), join(home, "db.json"));
  store.migrate();
  const policies = new PolicyStore(store);
  policies.authorizeRoot(fx.dir);
  const supervisor = new PiSupervisor(cfg);
  const sessions = new SessionManager(join(home, "sessions"));
  const engine = new TaskEngine(cfg, store, supervisor, sessions, policies);
  return { fx, home, fakePi, cfg, engine, supervisor, store };
}

/** A trusted-host request: explicit opt-in to whole-workspace write + network. */
function hostTask(ctx: Ctx, over: Record<string, unknown> = {}): ParsedTaskRequest {
  return parseTaskRequest({
    title: "t",
    workspace: ctx.fx.dir,
    mode: "standard",
    objective: "change the file",
    policy: { allowWrite: true, allowNetwork: true },
    ...over,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error("waitFor timed out");
}

async function teardown(ctx: Ctx) {
  try {
    // Drain any detached run so its late writes/log-stream land before we close.
    await ctx.engine.shutdown(15_000);
  } catch {
    /* ignore */
  }
  try {
    await ctx.supervisor.shutdown();
  } catch {
    /* ignore */
  }
  try {
    ctx.store.close();
  } catch {
    /* ignore */
  }
  try {
    ctx.fx.cleanup();
  } catch {
    /* ignore */
  }
  rmSync(ctx.home, { recursive: true, force: true });
}

function clearEnv() {
  for (const k of [
    "FAKE_PI_BEHAVIOR",
    "FAKE_PI_WRITE",
    "FAKE_PI_DELAY_MS",
    "FAKE_PI_HANG_STARTUP",
    "FAKE_PI_NO_SETTLE",
    "FAKE_PI_EXIT_AFTER_PROMPT",
    "FAKE_PI_STATS_DELAY_MS",
  ]) {
    delete process.env[k];
  }
}

test("engine: passing verifier + real worker change => passed handoff", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  try {
    const task = hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] });
    const { taskId, wait } = await ctx.engine.submit(task, { wait: true });
    const handoff = await wait;
    assert.ok(handoff, "handoff present");
    assert.equal(handoff!.status, "passed");
    assert.equal(handoff!.evidenceLevel, "verified");
    assert.equal(handoff!.verification[0].result, "pass");
    assert.equal(ctx.engine.getStatus(taskId)?.task.status, "succeeded");
    assert.equal(ctx.store.getTask(taskId)?.status, "succeeded");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: worker claim only (no verifier evidence) => partial, never passed", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  try {
    const task = hostTask(ctx, { acceptance: [] });
    const { wait } = await ctx.engine.submit(task, { wait: true });
    const handoff = await wait;
    assert.ok(handoff);
    assert.equal(handoff!.status, "partial");
    assert.equal(handoff!.evidenceLevel, "worker_claim_only");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: failing verifier => failed handoff", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "fail";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  try {
    const task = hostTask(ctx, { acceptance: [{ kind: "command", command: failCommand(), timeoutSeconds: 20 }] });
    const { wait } = await ctx.engine.submit(task, { wait: true });
    const handoff = await wait;
    assert.ok(handoff);
    assert.equal(handoff!.status, "failed");
    assert.equal(handoff!.verification[0].result, "fail");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: default (offline) policy is refused up-front with exit 2, before any DB write", async () => {
  const ctx = await makeCtx();
  try {
    const task = parseTaskRequest({ title: "t", workspace: ctx.fx.dir, mode: "standard", objective: "o" });
    await assert.rejects(
      () => ctx.engine.submit(task, { wait: false }),
      (err: unknown) => (err as { code?: number }).code === 2,
    );
    assert.equal(ctx.store.listTasks().length, 0, "no task row written when policy is unenforceable");
  } finally {
    await teardown(ctx);
  }
});

test("engine: sub-directory scope is refused up-front with exit 2 (cannot be hard-enforced)", async () => {
  const ctx = await makeCtx();
  try {
    const task = hostTask(ctx, { scope: ["src/"] });
    await assert.rejects(
      () => ctx.engine.submit(task, { wait: false }),
      (err: unknown) => (err as { code?: number }).code === 2,
    );
    assert.equal(ctx.store.listTasks().length, 0);
  } finally {
    await teardown(ctx);
  }
});

test("engine: unauthorized workspace is rejected before any run (exit 5)", async () => {
  const other = mkdtempSync(join(tmpdir(), "bridge-other-"));
  const ctx = await makeCtx();
  try {
    const task = hostTask(ctx, { workspace: other });
    await assert.rejects(
      () => ctx.engine.submit(task, { wait: false }),
      (err: unknown) => (err as { code?: number }).code === 5,
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
    await teardown(ctx);
  }
});

test("engine: worker reuse across tasks in same cwd/model keeps one process", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  try {
    const theTask = () => hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] });
    const a = await ctx.engine.submit(theTask(), { wait: true });
    await a.wait;
    const pidAfterFirst = ctx.supervisor.pid;
    const b = await ctx.engine.submit(theTask(), { wait: true });
    await b.wait;
    assert.equal(ctx.supervisor.pid, pidAfterFirst, "same worker process reused");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: recoverAfterRestart marks running/pending tasks interrupted and invalidates them", async () => {
  const ctx = await makeCtx();
  try {
    const taskId = "task_crashed";
    const now = new Date().toISOString();
    ctx.store.insertTask({
      id: taskId,
      workspace: ctx.fx.dir,
      status: "running",
      activeRunId: "run_crashed",
      generation: 1,
      requestJson: "{}",
      createdAt: now,
      updatedAt: now,
    });
    const n = ctx.engine.recoverAfterRestart();
    assert.ok(n >= 1);
    assert.equal(ctx.engine.getStatus(taskId)?.task.status, "interrupted");
    assert.equal(ctx.store.getTask(taskId)?.activeRunId, null);
    assert.equal(ctx.store.getTask(taskId)?.generation, 2);
  } finally {
    await teardown(ctx);
  }
});

test("engine: artifacts/logs are written under home/logs", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  try {
    const task = hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] });
    const { wait } = await ctx.engine.submit(task, { wait: true });
    const handoff = await wait;
    assert.ok(handoff!.rawLogRef && existsSync(handoff!.rawLogRef));
    assert.match(readFileSync(handoff!.rawLogRef!, "utf8"), /agent_settled/);
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: cancel during a run supersedes generation; late settle cannot overwrite", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  process.env.FAKE_PI_DELAY_MS = "1500";
  try {
    const task = hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] });
    const { taskId, wait } = await ctx.engine.submit(task, { wait: false });
    wait.catch(() => {});

    await waitFor(() => ctx.engine.activeRunId() !== null);
    const runId = ctx.engine.activeRunId()!;
    const generationBefore = ctx.store.getTask(taskId)!.generation;

    const cancelled = await ctx.engine.cancel(taskId);
    assert.equal(cancelled, true);

    const afterCancel = ctx.store.getTask(taskId)!;
    assert.equal(afterCancel.status, "cancelled");
    assert.ok(afterCancel.generation > generationBefore, "cancel supersedes the generation");
    assert.equal(afterCancel.activeRunId, null);

    assert.equal(
      ctx.store.updateTaskStatusGuarded(taskId, "succeeded", runId, generationBefore, new Date().toISOString()),
      false,
    );

    // Give the delayed fake-pi completion time to arrive and be discarded.
    await sleep(2200);
    assert.equal(ctx.store.getTask(taskId)!.status, "cancelled", "late result did not overwrite status");
    assert.equal(ctx.store.listHandoffs(taskId).length, 0, "no stale handoff persisted");
    assert.equal(ctx.store.listRuns(taskId).filter((r) => r.status === "running").length, 0);
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: repeated cancel returns false and does not disturb the task", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_DELAY_MS = "1500";
  try {
    const { taskId, wait } = await ctx.engine.submit(hostTask(ctx), { wait: false });
    wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null);
    assert.equal(await ctx.engine.cancel(taskId), true);
    const gen = ctx.store.getTask(taskId)!.generation;
    assert.equal(await ctx.engine.cancel(taskId), false, "second cancel is a no-op");
    assert.equal(ctx.store.getTask(taskId)!.generation, gen, "generation not bumped again");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: cancel of a queued (pending) task does not affect the running task", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  process.env.FAKE_PI_DELAY_MS = "1200";
  try {
    // Allow a second task to be accepted so it can sit in the pending queue.
    (ctx.engine as unknown as { policies: PolicyStore }).policies.setLimits({ maxActiveTasks: 2 });
    const a = await ctx.engine.submit(hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] }), { wait: false });
    a.wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null);

    const b = await ctx.engine.submit(hostTask(ctx), { wait: false });
    b.wait.catch(() => {});
    assert.equal(ctx.store.getTask(b.taskId)!.status, "pending");

    assert.equal(await ctx.engine.cancel(b.taskId), true);
    assert.equal(ctx.store.getTask(b.taskId)!.status, "cancelled");
    assert.equal(ctx.store.getTask(a.taskId)!.status, "running", "running task A is untouched");

    await a.wait.catch(() => {});
    await waitFor(() => ctx.store.getTask(a.taskId)!.status === "succeeded", 10_000);
    assert.equal(ctx.store.getTask(a.taskId)!.status, "succeeded", "task A completed normally");
    assert.equal(ctx.store.getTask(b.taskId)!.status, "cancelled");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: repeated resume of the same task cannot double-execute (dedupe)", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_DELAY_MS = "800";
  try {
    const { taskId, wait } = await ctx.engine.submit(hostTask(ctx), { wait: false });
    wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null);
    await ctx.engine.cancel(taskId);
    // task is now cancelled (resume-eligible)
    const r1 = await ctx.engine.resume(taskId);
    r1.wait.catch(() => {});
    await assert.rejects(
      () => ctx.engine.resume(taskId),
      (err: unknown) => (err as { code?: number }).code === 3,
    );
    await r1.wait.catch(() => {});
    // Only ONE handoff/run should have been produced for the resumed execution.
    const settledHandoffs = ctx.store.listHandoffs(taskId);
    assert.equal(settledHandoffs.length, 1, "exactly one handoff from the single resumed run");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: cancel during worker startup is honoured and the spawned tree is retired", async () => {
  const ctx = await makeCtx();
  (ctx.supervisor as unknown as { cfg: { worker: { startupTimeoutMs: number } } }).cfg.worker.startupTimeoutMs = 60_000;
  process.env.FAKE_PI_HANG_STARTUP = "1";
  try {
    const { taskId, wait } = await ctx.engine.submit(hostTask(ctx), { wait: false });
    wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null, 5000);
    assert.equal(await ctx.engine.cancel(taskId), true);
    assert.equal(ctx.store.getTask(taskId)!.status, "cancelled");
    // the half-started worker must be gone, not reused
    await waitFor(() => ctx.supervisor.isAlive === false, 15_000);
    assert.equal(ctx.supervisor.isAlive, false);
    // and no run is left "running"
    await waitFor(() => ctx.store.listRuns(taskId).every((r) => r.status !== "running"), 15_000);
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: an unexpected worker exit settles the run quickly (does not wait out the timeout)", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_EXIT_AFTER_PROMPT = "1";
  try {
    const task = hostTask(ctx, { policy: { allowWrite: true, allowNetwork: true, timeoutSeconds: 120 } });
    const started = Date.now();
    const { taskId, wait } = await ctx.engine.submit(task, { wait: true });
    const handoff = await wait;
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 30_000, `settled promptly, elapsed=${elapsed}ms`);
    assert.ok(handoff, "handoff returned rather than hanging");
    assert.notEqual(handoff!.status, "passed");
    assert.equal(ctx.store.getTask(taskId)!.status, "failed");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: whole-run timeout makes the wait reject (exit 6), marks the task failed and writes no handoff", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_NO_SETTLE = "1";
  try {
    const task = hostTask(ctx, { policy: { allowWrite: true, allowNetwork: true, timeoutSeconds: 1 } });
    const { taskId, wait } = await ctx.engine.submit(task, { wait: true });
    await assert.rejects(
      () => wait,
      (err: unknown) => err instanceof BridgeError && err.code === 6,
    );
    assert.equal(ctx.store.getTask(taskId)!.status, "failed", "task marked failed on timeout");
    assert.equal(ctx.store.listHandoffs(taskId).length, 0, "no handoff persisted after timeout");
    assert.equal(ctx.store.listRuns(taskId).some((r) => r.status === "timeout"), true, "run recorded as timeout");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: a late write from a cancelled run cannot leak across a resumed run (generation guard)", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  process.env.FAKE_PI_DELAY_MS = "1200";
  try {
    const a = await ctx.engine.submit(
      hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] }),
      { wait: false },
    );
    a.wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null);
    const oldRunId = ctx.engine.activeRunId()!;
    const oldGen = ctx.store.getTask(a.taskId)!.generation;
    await ctx.engine.cancel(a.taskId);
    // Resume completes quickly with a fresh worker (no artificial delay).
    delete process.env.FAKE_PI_DELAY_MS;
    const r = await ctx.engine.resume(a.taskId);
    const handoff = await r.wait;
    assert.equal(handoff?.status, "passed");
    assert.equal(ctx.store.getTask(a.taskId)!.status, "succeeded");
    // A late write carrying the OLD run/generation must be rejected by the guard.
    assert.equal(
      ctx.store.updateTaskStatusGuarded(a.taskId, "failed", oldRunId, oldGen, new Date().toISOString()),
      false,
    );
    assert.equal(ctx.store.getTask(a.taskId)!.status, "succeeded", "resumed run's state is not clobbered");
    assert.equal(ctx.store.listHandoffs(a.taskId).length, 1, "only the resumed run produced a handoff");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: a detached run that rejects (cancel) produces no unhandled rejection", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_DELAY_MS = "1500";
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { taskId, wait } = await ctx.engine.submit(hostTask(ctx), { wait: false });
    void wait; // detached: caller ignores the (rejecting) wait
    await waitFor(() => ctx.engine.activeRunId() !== null);
    await ctx.engine.cancel(taskId);
    await sleep(2200);
    assert.deepEqual(unhandled, [], "the detached wait rejection was handled internally");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: the whole-run deadline also covers the verifier (worker < deadline, verifier > deadline)", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  try {
    const task = hostTask(ctx, {
      // Worker settles fast; the verifier command would run well past the 1s deadline.
      policy: { allowWrite: true, allowNetwork: true, timeoutSeconds: 1 },
      acceptance: [
        { kind: "command", command: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"], timeoutSeconds: 60 },
      ],
    });
    const { taskId, wait } = await ctx.engine.submit(task, { wait: true });
    await assert.rejects(
      () => wait,
      (err: unknown) => err instanceof BridgeError && err.code === 6,
    );
    assert.equal(ctx.store.getTask(taskId)!.status, "failed", "task failed on the whole-run deadline");
    assert.equal(ctx.store.listHandoffs(taskId).length, 0, "no handoff persisted when the deadline hit in the verifier");
    assert.equal(ctx.store.listRuns(taskId).some((r) => r.status === "timeout"), true, "run recorded as timeout");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: cancel during startup cleans up and the next run succeeds (no stuck/leak)", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_HANG_STARTUP = "1";
  try {
    const a = await ctx.engine.submit(hostTask(ctx), { wait: false });
    a.wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null, 5000);
    assert.equal(await ctx.engine.cancel(a.taskId), true);
    // Cleanup must complete (worker gone, nothing stuck) before the lock is free.
    await waitFor(() => ctx.supervisor.isAlive === false, 15_000);
    assert.equal(ctx.supervisor.stuck, null, "supervisor is not stuck after a startup cancel");
    await waitFor(() => ctx.store.listRuns(a.taskId).every((r) => r.status !== "running"), 15_000);
    await waitFor(() => !ctx.engine.isBusy(), 15_000);

    // A subsequent run must work.
    delete process.env.FAKE_PI_HANG_STARTUP;
    process.env.FAKE_PI_BEHAVIOR = "pass";
    const b = await ctx.engine.submit(
      hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] }),
      { wait: true },
    );
    const handoff = await b.wait;
    assert.equal(handoff?.status, "passed", "a fresh run succeeds after the startup cancel");
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: shutdown invalidates the running task, writes no late handoff and blocks new work", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  process.env.FAKE_PI_DELAY_MS = "1500";
  try {
    const { taskId, wait } = await ctx.engine.submit(
      hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] }),
      { wait: false },
    );
    wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null);

    await ctx.engine.shutdown(10_000);
    assert.equal(ctx.store.getTask(taskId)!.status, "interrupted", "task invalidated synchronously on shutdown");

    // Give any late settle time to try (and fail) to persist.
    await sleep(2200);
    assert.equal(ctx.store.listHandoffs(taskId).length, 0, "no late handoff written after shutdown");
    assert.equal(ctx.store.getTask(taskId)!.status, "interrupted");

    await assert.rejects(
      () => ctx.engine.submit(hostTask(ctx), { wait: false }),
      (err: unknown) => (err as { code?: number }).code === 4,
    );
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: an unconfirmable verifier tree fails closed and blocks the next run", { skip: process.platform !== "win32" }, async () => {
  const ctx = await makeCtx();
  ctx.cfg.limits.verifyTerminateWaitMs = 700; // keep the test fast
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  // Force taskkill to be unavailable so the verifier tree cannot be proven terminated.
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "bridge-empty-bin-"));
  try {
    const task = hostTask(ctx, {
      policy: { allowWrite: true, allowNetwork: true, timeoutSeconds: 30 },
      acceptance: [
        { kind: "command", command: [process.execPath, "-e", "setTimeout(()=>{}, 2500)"], timeoutSeconds: 1 },
      ],
    });
    const { wait } = await ctx.engine.submit(task, { wait: true });
    await assert.rejects(
      () => wait,
      (err: unknown) => err instanceof BridgeError && err.code === 4,
    );
    assert.ok(ctx.engine.blocked(), "engine latched a blocked reason");
    await assert.rejects(
      () => ctx.engine.submit(hostTask(ctx), { wait: false }),
      (err: unknown) => (err as { code?: number }).code === 4,
    );
  } finally {
    // The verifier command could not be killed; let it self-exit before cleanup.
    await sleep(2800);
    process.env.PATH = savedPath;
    clearEnv();
    await teardown(ctx);
  }
});

test("engine: cancel during post-settle stats still retires the worker (no reuse)", async () => {
  const ctx = await makeCtx();
  process.env.FAKE_PI_BEHAVIOR = "pass";
  process.env.FAKE_PI_WRITE = join(ctx.fx.dir, "src", "app.txt");
  // Delay the stats RPC so the run is settled but still collecting stats when we cancel.
  process.env.FAKE_PI_STATS_DELAY_MS = "1500";
  try {
    const { taskId, wait } = await ctx.engine.submit(
      hostTask(ctx, { acceptance: [{ kind: "command", command: passCommand(), timeoutSeconds: 20 }] }),
      { wait: false },
    );
    wait.catch(() => {});
    await waitFor(() => ctx.engine.activeRunId() !== null);
    await waitFor(() => ctx.supervisor.isAlive, 5000);
    assert.ok(ctx.supervisor.pid, "worker is alive before the stats phase");
    await sleep(500); // let agent_settled happen; runPrompt now waits on the delayed stats RPC
    await ctx.engine.cancel(taskId);
    // The worker MUST be retired even though the run had already settled.
    await waitFor(() => ctx.supervisor.isAlive === false, 10_000);
    assert.equal(ctx.supervisor.isAlive, false, "worker retired after cancel during stats");
    assert.equal(ctx.store.getTask(taskId)!.status, "cancelled");
    assert.equal(ctx.store.listHandoffs(taskId).length, 0);
  } finally {
    clearEnv();
    await teardown(ctx);
  }
});
