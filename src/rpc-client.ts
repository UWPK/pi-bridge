import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { JsonAgentSessionEvent } from "./pi-types.js";
import { BridgeError, ExitCode } from "./errors.js";
import { groupedSpawnOptions, terminateTree } from "./process-utils.js";

/**
 * Minimal, spec-faithful RPC client for pi (docs/rpc.md, docs/rpc-commands.md).
 *
 * The task allows using the exported `RpcClient` when importable, or driving
 * `pi --mode rpc` over JSONL directly while honouring the documented protocol.
 * We implement the documented protocol so the bridge carries no heavy runtime
 * dependency, and expose the exact same command/event surface the docs define.
 *
 * Framing rules we respect (docs/rpc.md):
 *   - stdout is JSONL only; records terminate with LF; strip an optional preceding CR.
 *   - Do NOT use Node `readline` (it splits on U+2028/U+2029 which are valid in JSON strings).
 *   - Read stdout continuously to avoid stalling pi via backpressure.
 *   - stderr is diagnostics only, never parsed as protocol.
 */

export interface SpawnOptions {
  cliPath: string;
  nodePath?: string;
  cwd: string;
  provider?: string;
  model?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Called for every parsed session event. */
  onEvent?: (event: JsonAgentSessionEvent) => void;
  /** Called for every parsed command response. */
  onResponse?: (resp: RpcResponseRecord) => void;
  /** Called for raw stderr lines (diagnostics). */
  onStderr?: (line: string) => void;
}

export interface RpcResponseRecord {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: string;
  [k: string]: unknown;
}

type Pending = {
  resolve: (r: RpcResponseRecord) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export class PiRpcProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private pending = new Map<string, Pending>();
  private eventListeners = new Set<(event: JsonAgentSessionEvent) => void>();
  private reqCounter = 0;
  private stderrLines: string[] = [];
  private exited = false;
  private exitInfo: { code: number | null; signal: string | null } | null = null;
  private exitListeners = new Set<() => void>();
  private stopping: Promise<boolean> | null = null;
  private readonly opts: SpawnOptions;

  constructor(opts: SpawnOptions) {
    this.opts = opts;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  getStderr(): string {
    return this.stderrLines.join("\n");
  }

  /** Spawn pi in RPC mode and resolve once the process is running. */
  start(startupTimeoutMs = 60_000): Promise<void> {
    const { cliPath, nodePath, cwd, provider, model, args = [], env = {} } = this.opts;
    const useNode = /\.[cm]?js$/i.test(cliPath);
    const command = useNode ? nodePath ?? process.execPath : cliPath;
    const cliArgs = [...(useNode ? [cliPath] : []), "--mode", "rpc"];
    if (provider) cliArgs.push("--provider", provider);
    if (model) cliArgs.push("--model", model);
    cliArgs.push(...args);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new BridgeError(ExitCode.UNAVAILABLE, `pi RPC 启动超时 (${startupTimeoutMs}ms)`));
      }, startupTimeoutMs);

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, cliArgs, {
          cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env, ...env },
          ...groupedSpawnOptions(),
        }) as ChildProcessWithoutNullStreams;
      } catch (err) {
        clearTimeout(timer);
        reject(new BridgeError(ExitCode.UNAVAILABLE, `无法启动 pi: ${(err as Error).message}`));
        return;
      }

      this.child = child;
      // A worker killed mid-write can emit async EPIPE on stdin; never let it crash us.
      child.stdin.on("error", () => {
        /* ignore */
      });
      child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.stderrLines.push(line);
          if (this.stderrLines.length > 500) this.stderrLines.shift();
          this.opts.onStderr?.(line);
        }
      });
      child.on("error", (err) => {
        this.exited = true;
        this.emitExit();
        this.failAll(new BridgeError(ExitCode.UNAVAILABLE, `pi 进程错误: ${err.message}`));
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new BridgeError(ExitCode.UNAVAILABLE, `pi 进程错误: ${err.message}`));
        }
      });
      child.on("exit", (code, signal) => {
        this.exited = true;
        this.exitInfo = { code, signal };
        this.emitExit();
        this.failAll(
          new BridgeError(ExitCode.UNAVAILABLE, `pi 进程已退出 (code=${code} signal=${signal})`),
        );
      });

      // Give the process a moment to bind; pi will answer get_state once ready.
      child.once("spawn", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        // Malformed JSON: docs say pi emits a parse response; if we get a raw
        // non-JSON line it is a protocol violation — surface on stderr, don't throw.
        this.stderrLines.push(`[protocol] non-JSON stdout line: ${line.slice(0, 200)}`);
        continue;
      }
      this.handleRecord(record);
    }
  }

  private handleRecord(record: unknown): void {
    if (!record || typeof record !== "object") return;
    const rec = record as Record<string, unknown>;
    const type = rec.type;

    if (type === "response") {
      const resp = rec as unknown as RpcResponseRecord;
      this.opts.onResponse?.(resp);
      if (resp.id && this.pending.has(resp.id)) {
        const p = this.pending.get(resp.id)!;
        this.pending.delete(resp.id);
        clearTimeout(p.timer);
        p.resolve(resp);
      }
      return;
    }

    if (type === "extension_ui_request") {
      this.handleExtensionUi(rec as unknown as ExtensionUiRequest);
      return;
    }

    // Session event (agent_start, message_update, tool_execution_*, agent_settled, ...)
    const evt = rec as unknown as JsonAgentSessionEvent;
    this.opts.onEvent?.(evt);
    for (const l of this.eventListeners) {
      try {
        l(evt);
      } catch {
        /* a listener must not break the protocol reader */
      }
    }
  }

  /** Subscribe to parsed session events. Returns an unsubscribe function (docs/rpc.md). */
  onEvent(listener: (event: JsonAgentSessionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * Subscribe to process exit/error. Lets a run settle immediately when the worker
   * dies unexpectedly instead of waiting for the full run timeout.
   */
  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private emitExit(): void {
    for (const l of this.exitListeners) {
      try {
        l();
      } catch {
        /* a listener must not break the exit path */
      }
    }
  }

  /**
   * Dialog methods block until we answer. In a headless worker we decline them so the
   * process never hangs; fire-and-forget methods are ignored.
   */
  private handleExtensionUi(req: ExtensionUiRequest): void {
    if (!DIALOG_METHODS.has(req.method)) return;
    const response =
      req.method === "confirm"
        ? { type: "extension_ui_response", id: req.id, confirmed: false }
        : { type: "extension_ui_response", id: req.id, cancelled: true };
    this.writeLine(response);
  }

  private writeLine(obj: unknown): void {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      /* backpressure/closed; ignored */
    }
  }

  /** Send a command and await its correlated response. */
  send<T = unknown>(command: Record<string, unknown>, timeoutMs = 60_000): Promise<RpcResponseRecord & { data?: T }> {
    const id = `req-${++this.reqCounter}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(ExitCode.UNAVAILABLE, `命令 ${String(command.type)} 超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (r: RpcResponseRecord) => void, reject, timer });
      this.writeLine({ ...command, id });
    });
  }

  private async command<T = unknown>(type: string, extra: Record<string, unknown> = {}, timeoutMs?: number) {
    const resp = await this.send<T>({ type, ...extra }, timeoutMs);
    if (!resp.success) {
      throw new BridgeError(ExitCode.UNAVAILABLE, `pi 命令 ${type} 失败: ${resp.error ?? "unknown"}`);
    }
    return resp.data as T;
  }

  // --- documented commands (docs/rpc-commands.md) ---

  getState(timeoutMs?: number) {
    return this.command<{ model?: { provider: string; id: string }; thinkingLevel?: string; sessionFile?: string; sessionId?: string; messageCount?: number; isStreaming?: boolean }>("get_state", {}, timeoutMs);
  }

  prompt(message: string, timeoutMs?: number) {
    return this.send<{ disposition: "started" | "queued" | "handled" }>({ type: "prompt", message }, timeoutMs);
  }

  abort(timeoutMs?: number) {
    return this.command("abort", {}, timeoutMs);
  }

  clearQueue(timeoutMs?: number) {
    return this.command<{ steering: string[]; followUp: string[] }>("clear_queue", {}, timeoutMs);
  }

  abortBash(timeoutMs?: number) {
    return this.command("abort_bash", {}, timeoutMs);
  }

  newSession(timeoutMs?: number) {
    return this.command<{ cancelled: boolean }>("new_session", {}, timeoutMs);
  }

  switchSession(sessionPath: string, timeoutMs?: number) {
    return this.command<{ cancelled: boolean }>("switch_session", { sessionPath }, timeoutMs);
  }

  setModel(provider: string, modelId: string, timeoutMs?: number) {
    return this.command<{ provider: string; id: string }>("set_model", { provider, modelId }, timeoutMs);
  }

  getAvailableModels(timeoutMs?: number) {
    return this.command<{ models: Array<{ provider: string; id: string }> }>("get_available_models", {}, timeoutMs);
  }

  getSessionStats(timeoutMs?: number) {
    return this.command<{
      tokens?: { input?: number; output?: number; total?: number };
      cost?: number;
      contextUsage?: { percent?: number };
    }>("get_session_stats", {}, timeoutMs);
  }

  getLastAssistantText(timeoutMs?: number) {
    return this.command<{ text: string | null }>("get_last_assistant_text", {}, timeoutMs);
  }

  getCommands(timeoutMs?: number) {
    return this.command<{ commands: Array<{ name: string; source: string }> }>("get_commands", {}, timeoutMs);
  }

  setThinkingLevel(level: string, timeoutMs?: number) {
    return this.command("set_thinking_level", { level }, timeoutMs);
  }

  /**
   * Terminate the WHOLE process tree and wait for provable confirmation. Returns true
   * only when the tree is confirmed gone; false means the caller must treat the worker
   * as un-cleanable (block the next run) and keep the pid for retry/inspection.
   *
   * Single-flight: concurrent callers (an abort handler and an error path) share one
   * bounded termination promise. Bounded throughout.
   */
  async stop(killWaitMs = 10_000): Promise<boolean> {
    if (!this.child) return true;
    if (this.stopping) return this.stopping;
    this.stopping = this.doStop(killWaitMs).finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  private async doStop(killWaitMs: number): Promise<boolean> {
    this.eventListeners.clear();
    const child = this.child;
    if (!child) return true;
    // Intentionally do NOT end stdin first: that lets the parent exit alone and
    // orphan its descendants before the tree can be walked/killed.
    const confirmed = await terminateTree(child, killWaitMs);
    if (confirmed) {
      this.child = null;
      this.exited = true;
    }
    // On failure keep `this.child` (and its pid) so the pid is not silently dropped.
    return confirmed;
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
