import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openStore, type Store } from "./persistence.js";
import { loadConfig, runtimePaths, ensureDir } from "./config.js";
import { PolicyStore } from "./policies.js";
import { PiSupervisor } from "./supervisor.js";
import { SessionManager } from "./session-manager.js";
import { TaskEngine } from "./tasks.js";
import { parseTaskRequest } from "./schema.js";
import { startIpcServer, writeEndpoint, clearEndpoint, newToken, type IpcRequest } from "./ipc.js";
import { BridgeError, ExitCode } from "./errors.js";
import { redactText } from "./redact.js";

/**
 * Bridge Daemon (需求文档 §3.1).
 *
 * Long-lived process that owns the pi RPC worker and the store. The short-lived CLI
 * never owns the worker; it only sends IPC requests. On startup we recover tasks that
 * were left `running` by a previous crash (AC-09).
 */

export interface DaemonHandle {
  stop(): Promise<void>;
}

export async function startDaemon(cfg = loadConfig()): Promise<DaemonHandle> {
  const paths = runtimePaths(cfg.home);
  ensureDir(cfg.home);

  if (existsSync(paths.pidFile)) {
    const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
    if (pid && isAlive(pid)) {
      throw new BridgeError(ExitCode.LIMIT, `Daemon 已在运行 (pid=${pid})`);
    }
    rmSync(paths.pidFile, { force: true });
  }

  const store: Store = await openStore(paths.dbFile, paths.jsonDbFile);
  store.migrate();

  const policies = new PolicyStore(store);
  const supervisor = new PiSupervisor(cfg);
  const sessions = new SessionManager(paths.sessionsDir);
  const engine = new TaskEngine(cfg, store, supervisor, sessions, policies);

  const recovered = engine.recoverAfterRestart();

  const token = newToken();
  let stopping = false;

  const handler = async (req: IpcRequest): Promise<unknown> => {
    // Reject work that would mutate worker/authorization once shutdown has begun.
    if (stopping && ["delegate", "resume", "doctor", "models", "authorize", "revoke"].includes(req.command)) {
      throw new BridgeError(ExitCode.UNAVAILABLE, "Daemon 正在关闭，拒绝新请求");
    }
    switch (req.command) {
      case "ping":
        return { ok: true, pid: process.pid, backend: store.backend };
      case "status": {
        const params = req.params ?? {};
        if (params.all) {
          return { tasks: engine.listStatus() };
        }
        const taskId = String(params.taskId ?? "");
        const st = engine.getStatus(taskId);
        if (!st) throw new BridgeError(ExitCode.BAD_REQUEST, `task 不存在: ${taskId}`);
        return st;
      }
      case "delegate": {
        const task = parseTaskRequest(req.params?.task);
        const wait = req.params?.wait === true;
        const { taskId, wait: waitPromise } = await engine.submit(task, { wait });
        if (!wait) return { taskId, status: "pending" };
        const handoff = await waitPromise;
        return { taskId, handoff };
      }
      case "cancel": {
        const taskId = String(req.params?.taskId ?? "");
        const cancelled = await engine.cancel(taskId);
        return { taskId, cancelled };
      }
      case "resume": {
        const taskId = String(req.params?.taskId ?? "");
        const wait = req.params?.wait === true;
        const { wait: waitPromise } = await engine.resume(taskId);
        if (!wait) {
          waitPromise.catch(() => {});
          return { taskId, status: "running" };
        }
        const handoff = await waitPromise;
        return { taskId, handoff };
      }
      case "authorize": {
        const dir = String(req.params?.dir ?? "");
        const roots = policies.authorizeRoot(dir);
        return { authorizedRoots: roots };
      }
      case "revoke": {
        const dir = String(req.params?.dir ?? "");
        return { authorizedRoots: policies.revokeRoot(dir) };
      }
      case "models": {
        // Must not repoint the worker (cwd/model) while a task is running.
        if (engine.isBusy()) {
          throw new BridgeError(ExitCode.LIMIT, "worker 正在执行任务，暂不可查询/切换模型，请稍后重试");
        }
        const list = await supervisor.ensureForModels();
        return { models: list };
      }
      case "logs": {
        const taskId = String(req.params?.taskId ?? "");
        const st = engine.getStatus(taskId);
        if (!st) throw new BridgeError(ExitCode.BAD_REQUEST, `task 不存在: ${taskId}`);
        const runs = st.runs.map((r) => {
          const dir = supervisor.runLogDir(r.id);
          const files = existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : [];
          return { runId: r.id, status: r.status, rawLogRef: join(dir, "pi-events.jsonl"), files };
        });
        return { taskId, runs };
      }
      case "doctor": {
        // Never call ensureWorker while a run is active: it could switch cwd/model and
        // disrupt the live worker. Return cached state instead and mark health unknown.
        const busy = engine.isBusy();
        const startup = busy
          ? { skipped: true, reason: "engine busy; returned cached worker state" }
          : supervisor.isAlive
            ? null
            : await supervisor.doctor().catch((e) => ({ ok: false, error: (e as Error).message }));
        const workerOk = !busy && !(startup && (startup as { ok?: boolean }).ok === false);
        const health = busy ? "unknown" : workerOk ? "ok" : "failed";
        return {
          backend: store.backend,
          migrations: store.appliedVersions(),
          piAlive: supervisor.isAlive,
          pid: supervisor.pid,
          workerWorkspace: supervisor.workspace,
          workerModel: supervisor.model,
          worker: { ...supervisor.workerSnapshot(), ok: workerOk },
          health,
          blocked: engine.blocked(),
          authorizedRoots: policies.authorizedRoots(),
          limits: policies.limits(),
          startup,
        };
      }
      case "shutdown":
        return { stopping: true };
      default:
        throw new BridgeError(ExitCode.BAD_REQUEST, `未知命令: ${req.command}`);
    }
  };

  const ipc = await startIpcServer({
    host: cfg.ipc.host,
    token,
    handler,
    onShutdownRequest: () => {
      void stop().catch((e) => {
        process.stderr.write(redactText(`[daemon] shutdown failed: ${(e as Error).message}\n`));
      });
    },
  });

  writeEndpoint(paths, ipc.endpoint);
  writeFileSync(paths.pidFile, String(process.pid), { encoding: "utf8", mode: 0o600 });

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    engine.beginStopping();
    // Synchronously invalidate any in-flight task, then drain. If the engine cannot
    // settle in time this THROWS: we must NOT close the store or report stopped while
    // a late run/verifier/handoff write could still land.
    await engine.shutdown();
    await supervisor.shutdown();
    await ipc.close();
    clearEndpoint(paths);
    try {
      rmSync(paths.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    store.close();
  }

  return { stop };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Entry point used when the daemon is launched as a detached child. */
export async function runDaemonMain(): Promise<void> {
  const cfg = loadConfig();
  const handle = await startDaemon(cfg);
  const shutdown = () => {
    void handle
      .stop()
      .then(() => process.exit(0))
      .catch((e) => {
        process.stderr.write(redactText(`[daemon] shutdown did not complete: ${(e as Error).message}\n`));
        // Do NOT exit 0: keep the process (and store) open rather than claim stopped.
        process.exit(1);
      });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("uncaughtException", (err) => {
    process.stderr.write(redactText(`[daemon] uncaught: ${(err as Error).stack ?? String(err)}\n`));
  });
  // Keep the event loop alive.
  await new Promise(() => {});
}
