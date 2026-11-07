#!/usr/bin/env node
import { configuredModel } from "./config.js";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadConfig, runtimePaths, ensureDir } from "./config.js";
import { readEndpoint, ipcCall, type IpcResponse } from "./ipc.js";
import { parseJsonStrict, parseTaskRequest } from "./schema.js";
import { BridgeError, ExitCode } from "./errors.js";
import { redactText } from "./redact.js";
import { runStep } from "./run-step.js";
import type { Handoff } from "./types.js";

/**
 * Short-lived CLI (需求文档 §5).
 *
 * Contract:
 *   - With --json, stdout contains ONLY machine-parseable JSON.
 *   - Diagnostics go to stderr.
 *   - Exit codes follow §5.1.
 * It talks to the daemon over localhost IPC and never owns the pi worker.
 */

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["json", "wait", "detach", "all", "help", "h", "host"]);

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[0] ?? "";
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq >= 0) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1));
      } else {
        const name = tok.slice(2);
        if (BOOLEAN_FLAGS.has(name)) {
          flags.set(name, true);
        } else {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith("--")) {
            flags.set(name, next);
            i++;
          } else {
            flags.set(name, true);
          }
        }
      }
    } else if (tok.startsWith("-") && tok.length > 1) {
      flags.set(tok.slice(1), true);
    } else {
      positionals.push(tok);
    }
  }
  return { command, positionals, flags };
}

function out(json: boolean, payload: unknown, human: string): void {
  if (json) {
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    process.stdout.write(human.endsWith("\n") ? human : human + "\n");
  }
}

function diag(msg: string): void {
  process.stderr.write(redactText(msg) + "\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const json = args.flags.has("json");

  if (!args.command || args.command === "help" || args.flags.has("help") || args.flags.has("h")) {
    out(json, { usage: usageText() }, usageText());
    return ExitCode.OK;
  }

  switch (args.command) {
    case "up":
      return cmdUp(args, json);
    case "down":
      return cmdDown(args, json);
    case "doctor":
      return cmdDoctor(args, json);
    case "models":
      return cmdModels(args, json);
    case "authorize":
      return cmdAuthorize(args, json);
    case "delegate":
      return cmdDelegate(args, json);
    case "status":
      return cmdStatus(args, json);
    case "logs":
      return cmdLogs(args, json);
    case "cancel":
      return cmdCancel(args, json);
    case "resume":
      return cmdResume(args, json);
    case "check":
      return cmdCheck(args, json);
    case "config":
      return cmdConfig(args, json);
    default:
      diag(`未知命令: ${args.command}`);
      out(json, { error: "unknown_command", command: args.command }, usageText());
      return ExitCode.BAD_REQUEST;
  }
}

/* -------------------------------------------------------------- */
/* commands                                                       */
/* -------------------------------------------------------------- */

async function cmdUp(args: ParsedArgs, json: boolean): Promise<number> {
  const cfg = loadConfig();
  const paths = runtimePaths(cfg.home);
  ensureDir(cfg.home);
  const existing = readEndpoint(paths, cfg.ipc.host);
  if (existing) {
    try {
      const ping = await ipcCall(existing, { command: "ping" }, 3000);
      if (ping.ok) {
        out(json, { started: false, alreadyRunning: true, ...(ping.data as object) }, `Daemon 已在运行。`);
        return ExitCode.OK;
      }
    } catch {
      /* stale endpoint; fall through to restart */
      rmSync(paths.portFile, { force: true });
      rmSync(paths.tokenFile, { force: true });
    }
  }

  const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), "daemon-entry.js");
  const logPath = join(paths.logsDir, "daemon.log");
  ensureDir(paths.logsDir);
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    windowsHide: true,
    env: { ...process.env, BRIDGE_HOME: cfg.home },
  });
  child.unref();

  // Wait for the endpoint to appear.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(400);
    const ep = readEndpoint(paths, cfg.ipc.host);
    if (ep) {
      try {
        const ping = await ipcCall(ep, { command: "ping" }, 3000);
        if (ping.ok) {
          out(json, { started: true, pid: (ping.data as { pid?: number }).pid, logFile: logPath }, `Daemon 已启动 (log: ${logPath})`);
          return ExitCode.OK;
        }
      } catch {
        /* keep waiting */
      }
    }
  }
  diag(`Daemon 启动超时，请查看日志: ${logPath}`);
  out(json, { started: false, error: "startup_timeout", logFile: logPath }, "Daemon 启动超时");
  return ExitCode.UNAVAILABLE;
}

async function cmdDown(args: ParsedArgs, json: boolean): Promise<number> {
  const cfg = loadConfig();
  const paths = runtimePaths(cfg.home);
  const ep = readEndpoint(paths, cfg.ipc.host);
  if (!ep) {
    out(json, { stopped: false, running: false }, "Daemon 未运行。");
    return ExitCode.OK;
  }
  try {
    await ipcCall(ep, { command: "shutdown" }, 5000);
  } catch {
    /* daemon may exit before replying */
  }
  // Only report stopped (and remove the endpoint) once the daemon is actually gone.
  const deadline = Date.now() + 15_000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      const ping = await ipcCall(ep, { command: "ping" }, 2000);
      alive = ping.ok === true;
    } catch {
      alive = false;
    }
    if (!alive) break;
    await sleep(300);
  }
  if (alive) {
    // Do NOT delete a live endpoint or claim success — keep the state operable.
    diag("Daemon 未能在超时内停止；保留端点，可重试 bridge down 或查看 daemon 日志");
    out(json, { stopped: false, running: true }, "Daemon 仍在运行，未移除端点。");
    return ExitCode.UNAVAILABLE;
  }
  rmSync(paths.portFile, { force: true });
  rmSync(paths.tokenFile, { force: true });
  out(json, { stopped: true }, "Daemon 已停止。");
  return ExitCode.OK;
}

async function cmdDoctor(args: ParsedArgs, json: boolean): Promise<number> {
  const cfg = loadConfig();
  const version = {
    node: process.version,
    backend: cfg.backend || "pi",
    healthScope: cfg.backend === "dsh" ? "adapter RPC only; headless model requires a real task" : "Pi RPC worker",
    piCliPath: cfg.pi.cliPath,
    piCliExists: existsSync(cfg.pi.cliPath),
    defaultModel: configuredModel(cfg),
  };
  const ep = readEndpoint(runtimePaths(cfg.home), cfg.ipc.host);
  let daemon: unknown = null;
  let running = false;
  let health: "ok" | "failed" | "unknown" = "unknown";
  if (ep) {
    try {
      const ping = await ipcCall(ep, { command: "ping" }, 5000);
      if (ping.ok) {
        running = true;
        const resp = await ipcCall(ep, { command: "doctor" }, 60_000);
        if (!resp.ok) {
          daemon = { error: resp.error };
          health = "failed";
        } else {
          daemon = resp.data;
          const d = resp.data as {
            health?: string;
            worker?: { ok?: boolean } | null;
            startup?: { ok?: boolean; skipped?: boolean } | null;
          };
          if (typeof d?.health === "string") health = d.health as "ok" | "failed" | "unknown";
          else if (d?.worker && d.worker.ok === false) health = "failed";
          else if (d?.startup && d.startup.ok === false) health = "failed";
          else if (d?.startup && d.startup.skipped) health = "unknown";
          else health = "ok";
        }
      } else {
        daemon = { error: ping.error ?? "daemon 未响应 ping" };
        health = "failed";
      }
    } catch (err) {
      daemon = { error: (err as Error).message };
      health = "failed";
    }
  }
  const payload = { version, daemon, daemonRunning: running, health };
  out(json, payload, humanDoctor(payload));
  // Honest: unreachable/stale endpoint, a failed doctor response, or a failed health
  // probe all report not-running/failed with exit 4. A busy daemon (cached worker
  // state) is reported with health "unknown" — not a verified health check.
  return running && health !== "failed" ? ExitCode.OK : ExitCode.UNAVAILABLE;
}

async function cmdModels(args: ParsedArgs, json: boolean): Promise<number> {
  if (loadConfig().backend === "dsh") {
    out(json, { models: [], supported: false, reason: "DSH headless uses its configured model; enumeration is unavailable" }, "DSH headless model enumeration is unavailable.");
    return ExitCode.OK;
  }
  const ep = requireEndpoint();
  const resp = await ipcCall(ep, { command: "models" }, 60_000);
  return finish(resp, json, (d) => {
    const models = (d as { models: Array<{ provider: string; id: string }> }).models;
    return models.map((m) => `${m.provider}/${m.id}`).join("\n");
  });
}

async function cmdAuthorize(args: ParsedArgs, json: boolean): Promise<number> {
  const dir = strFlag(args, "dir") ?? args.positionals[0];
  if (!dir) throw new BridgeError(ExitCode.BAD_REQUEST, "authorize 需要 --dir <路径>");
  const ep = requireEndpoint();
  const resp = await ipcCall(ep, { command: "authorize", params: { dir: resolve(dir) } }, 15_000);
  return finish(resp, json, (d) => `已授权根目录:\n${((d as { authorizedRoots: string[] }).authorizedRoots).join("\n")}`);
}

async function cmdDelegate(args: ParsedArgs, json: boolean): Promise<number> {
  const taskFile = strFlag(args, "task-file");
  const wait = args.flags.has("wait") || !args.flags.has("detach");

  let raw: unknown;
  if (taskFile === "-") {
    raw = parseJsonStrict(await readStdin(), "stdin");
  } else if (taskFile) {
    const p = resolve(taskFile);
    if (!existsSync(p)) throw new BridgeError(ExitCode.BAD_REQUEST, `任务文件不存在: ${p}`);
    raw = parseJsonStrict(readFileSync(p, "utf8"), `任务文件 ${p}`);
  } else if (args.flags.has("stdin")) {
    raw = parseJsonStrict(await readStdin(), "stdin");
  } else {
    const task = strFlag(args, "task");
    const dir = strFlag(args, "dir");
    if (!task || !dir) {
      throw new BridgeError(ExitCode.BAD_REQUEST, "delegate 需要 --task-file，或同时提供 --task 与 --dir");
    }
    raw = {
      title: strFlag(args, "title") ?? task.slice(0, 60),
      workspace: resolve(dir),
      objective: task,
      mode: strFlag(args, "mode") ?? "standard",
      model: strFlag(args, "model"),
      // The conservative default is offline; the inline path has no task file, so
      // trusted host execution must be opted into explicitly with --host.
      policy: args.flags.has("host") ? { allowWrite: true, allowNetwork: true } : undefined,
      scope: splitList(strFlag(args, "scope")),
      acceptance: strFlag(args, "verify")
        ? [
            {
              kind: "command",
              command: splitArgv(strFlag(args, "verify")!),
              timeoutSeconds: numFlag(args, "verify-timeout"),
            },
          ]
        : [],
    };
  }

  const parsed = parseTaskRequest(raw);
  const ep = requireEndpoint();
  const resp = await ipcCall(
    ep,
    { command: "delegate", params: { task: parsed, wait } },
    wait ? 24 * 3600 * 1000 : 30_000,
  );
  if (!resp.ok) return finish(resp, json, () => "");
  const data = resp.data as { taskId: string; status?: string; handoff?: Handoff };
  if (!wait || !data.handoff) {
    out(json, { taskId: data.taskId, status: data.status ?? "pending" }, `任务已提交: ${data.taskId}`);
    return ExitCode.OK;
  }
  const handoff = data.handoff;
  out(json, { taskId: data.taskId, handoff }, humanHandoff(handoff));
  return exitForHandoff(handoff);
}

async function cmdStatus(args: ParsedArgs, json: boolean): Promise<number> {
  const ep = requireEndpoint();
  if (args.flags.has("all")) {
    const resp = await ipcCall(ep, { command: "status", params: { all: true } }, 30_000);
    return finish(resp, json, (d) => humanStatusAll(d));
  }
  const taskId = strFlag(args, "task") ?? args.positionals[0];
  if (!taskId) throw new BridgeError(ExitCode.BAD_REQUEST, "status 需要 --task <id> 或 --all");
  const resp = await ipcCall(ep, { command: "status", params: { taskId } }, 30_000);
  return finish(resp, json, (d) => humanStatusOne(d));
}

async function cmdLogs(args: ParsedArgs, json: boolean): Promise<number> {
  const taskId = strFlag(args, "task") ?? args.positionals[0];
  if (!taskId) throw new BridgeError(ExitCode.BAD_REQUEST, "logs 需要 --task <id>");
  const tail = numFlag(args, "tail") ?? 100;
  const ep = requireEndpoint();
  const resp = await ipcCall(ep, { command: "logs", params: { taskId } }, 30_000);
  if (!resp.ok) return finish(resp, json, () => "");
  const data = resp.data as { taskId: string; runs: Array<{ runId: string; files: string[] }> };
  const payload = data.runs.map((r) => ({
    runId: r.runId,
    files: r.files.map((f) => {
      if (!existsSync(f)) return { file: f, tail: [] as string[] };
      const lines = readFileSync(f, "utf8").split(/\r?\n/);
      return { file: f, tail: lines.slice(-tail) };
    }),
  }));
  if (json) {
    out(true, { taskId: data.taskId, runs: payload }, "");
    return ExitCode.OK;
  }
  if (!payload.length || payload.every((r) => r.files.length === 0)) {
    process.stdout.write(`(未找到 task ${taskId} 的日志)\n`);
    return ExitCode.OK;
  }
  for (const r of payload) {
    for (const f of r.files) {
      process.stdout.write(`=== ${f.file} ===\n${f.tail.join("\n")}\n`);
    }
  }
  return ExitCode.OK;
}

async function cmdCancel(args: ParsedArgs, json: boolean): Promise<number> {
  const taskId = strFlag(args, "task") ?? args.positionals[0];
  if (!taskId) throw new BridgeError(ExitCode.BAD_REQUEST, "cancel 需要 --task <id>");
  const ep = requireEndpoint();
  const resp = await ipcCall(ep, { command: "cancel", params: { taskId } }, 60_000);
  return finish(resp, json, (d) => `任务 ${taskId} 已取消: ${(d as { cancelled: boolean }).cancelled}`);
}

async function cmdResume(args: ParsedArgs, json: boolean): Promise<number> {
  const taskId = strFlag(args, "task") ?? args.positionals[0];
  if (!taskId) throw new BridgeError(ExitCode.BAD_REQUEST, "resume 需要 --task <id>");
  const wait = args.flags.has("wait");
  const ep = requireEndpoint();
  const resp = await ipcCall(ep, { command: "resume", params: { taskId, wait } }, wait ? 24 * 3600 * 1000 : 30_000);
  if (!resp.ok) return finish(resp, json, () => "");
  const data = resp.data as { taskId: string; status?: string; handoff?: Handoff };
  if (!data.handoff) {
    out(json, { taskId: data.taskId, status: data.status ?? "running" }, `任务已恢复: ${data.taskId}`);
    return ExitCode.OK;
  }
  out(json, { taskId: data.taskId, handoff: data.handoff }, humanHandoff(data.handoff));
  return exitForHandoff(data.handoff);
}

async function cmdCheck(args: ParsedArgs, json: boolean): Promise<number> {
  // Runs the project's own gates: typecheck + build + unit + integration + smoke.
  // 'smoke' talks to the REAL pi model and clear-SKIPs (exit 0) when credentials are
  // unavailable — so a green `bridge check` without credentials is NOT proof that a
  // real model run succeeded; it only means every non-provider gate passed.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const steps: Array<{ name: string; cmd: string[] }> = [
    { name: "typecheck", cmd: [process.execPath, tsc, "-p", "tsconfig.json", "--noEmit"] },
    { name: "build", cmd: [process.execPath, tsc, "-p", "tsconfig.json"] },
    { name: "unit", cmd: [process.execPath, "--test", "--test-timeout=120000", "dist/tests/unit/*.test.js"] },
    { name: "integration", cmd: [process.execPath, "--test", "--test-timeout=120000", "dist/tests/integration/*.test.js"] },
    { name: "smoke", cmd: [process.execPath, "--test", "--test-timeout=300000", "dist/tests/smoke/*.test.js"] },
  ];
  const results: Array<{ name: string; code: number }> = [];
  for (const step of steps) {
    if (!json) diag(`[check] ${step.name} ...`);
    const code = await runStep(step.cmd, root, !json);
    results.push({ name: step.name, code });
    if (code !== 0) break;
  }
  const ok = results.every((r) => r.code === 0) && results.length === steps.length;
  out(json, { ok, steps: results }, ok ? "check 全部通过" : "check 失败");
  return ok ? ExitCode.OK : ExitCode.TASK_FAILED;
}

async function cmdConfig(args: ParsedArgs, json: boolean): Promise<number> {
  const sub = args.positionals[0] ?? "show";
  if (sub !== "show") throw new BridgeError(ExitCode.BAD_REQUEST, `未知 config 子命令: ${sub}`);
  const cfg = loadConfig();
  const redacted = { ...cfg, pi: { ...cfg.pi } };
  out(json, redacted, JSON.stringify(redacted, null, 2));
  return ExitCode.OK;
}

/* -------------------------------------------------------------- */
/* helpers                                                        */
/* -------------------------------------------------------------- */

function requireEndpoint() {
  const cfg = loadConfig();
  const ep = readEndpoint(runtimePaths(cfg.home), cfg.ipc.host);
  if (!ep) {
    throw new BridgeError(ExitCode.UNAVAILABLE, "Daemon 未运行，请先执行: bridge up");
  }
  return ep;
}

async function finish(resp: IpcResponse, json: boolean, human: (d: unknown) => string): Promise<number> {
  if (!resp.ok) {
    const code = (resp.error?.code ?? ExitCode.TASK_FAILED) as number;
    diag(resp.error?.message ?? "未知错误");
    out(json, { error: resp.error }, resp.error?.message ?? "未知错误");
    return code;
  }
  out(json, resp.data, human(resp.data));
  return ExitCode.OK;
}

function exitForHandoff(h: Handoff): number {
  switch (h.status) {
    case "passed":
      return ExitCode.OK;
    case "partial":
      return ExitCode.TASK_FAILED;
    case "failed":
      return ExitCode.TASK_FAILED;
    case "blocked":
      return ExitCode.ABORTED;
  }
}

function strFlag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === "string" ? v : undefined;
}
function numFlag(args: ParsedArgs, name: string): number | undefined {
  const v = strFlag(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function splitList(v?: string): string[] | undefined {
  if (!v) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
function splitArgv(v: string): string[] {
  // Split on spaces, honoring simple double-quotes. The result is an argv array,
  // never a shell string (verifier runs with shell:false).
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v))) out.push(m[1] ?? m[2]);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function listLogFiles(logDir: string, taskId: string): string[] {
  if (!existsSync(logDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(logDir)) {
    const full = join(logDir, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const f of readdirSync(full)) {
      if (f.endsWith(".log") || f.endsWith(".jsonl")) out.push(join(full, f));
    }
  }
  return out;
}

function humanDoctor(payload: { version: unknown; daemon: unknown; daemonRunning: boolean; health: string }): string {
  return [
    "== 版本 ==",
    JSON.stringify(payload.version, null, 2),
    "",
    `== Daemon == (health: ${payload.health})`,
    payload.daemonRunning ? JSON.stringify(payload.daemon, null, 2) : "(未运行；执行 bridge up 启动)",
  ].join("\n");
}

function humanHandoff(h: Handoff): string {
  return [
    `状态: ${h.status} (evidence: ${h.evidenceLevel})`,
    `worker 模型: ${h.workerModel}`,
    `摘要: ${h.summary}`,
    `改动文件: ${h.changedFiles.map((f) => `${f.path}(${f.change})`).join(", ") || "无"}`,
    `diff: +${h.diffSummary.insertions} -${h.diffSummary.deletions} (${h.diffSummary.files} 文件)`,
    `验收: ${h.verification.map((v) => `${v.command.join(" ")} => ${v.result}(${v.exitCode})`).join("; ") || "未执行"}`,
    `下一步: ${h.nextAction}`,
  ].join("\n");
}

function humanStatusOne(d: unknown): string {
  const { task, runs } = d as { task: { id: string; status: string; workspace: string }; runs: Array<{ id: string; status: string }> };
  return [`task ${task.id}: ${task.status}`, `workspace: ${task.workspace}`, `runs: ${runs.map((r) => `${r.id}=${r.status}`).join(", ") || "无"}`].join("\n");
}

function humanStatusAll(d: unknown): string {
  const { tasks } = d as { tasks: Array<{ id: string; status: string; runCount: number }> };
  if (!tasks.length) return "(无任务)";
  return tasks.map((t) => `${t.id}\t${t.status}\t${t.runCount} runs`).join("\n");
}

function usageText(): string {
  return [
    "bridge <command> [options]",
    "",
    "  up                                        启动本地 Daemon",
    "  down                                      优雅停止 Daemon",
    "  doctor [--json]                           环境/模型/DB/IPC 诊断",
    "  models --json                             列出 pi 可用模型",
    "  authorize --dir <path>                    授权工作目录",
    "  delegate --task-file <f> --wait --json    委派任务（文件）",
    "  delegate --task <t> --dir <d> --host       委派任务（参数；--host=显式允许写+联网，需整个 workspace）",
    "  status --task <id> | --all --json         查询任务状态",
    "  logs --task <id> [--tail N]               查看日志",
    "  cancel --task <id>                        取消任务",
    "  resume --task <id> [--wait]               恢复中断任务",
    "  check                                     运行 typecheck + build + unit + integration + smoke（smoke 无凭据时 skip）",
    "  config show                              显示配置",
    "",
    "退出码: 0 成功 1 失败 2 参数 3 限额 4 不可用 5 未授权 6 取消/超时",
  ].join("\n");
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const isBridge = err instanceof BridgeError;
    const code = isBridge ? err.code : ExitCode.TASK_FAILED;
    diag(`错误: ${(err as Error).message}`);
    if (process.argv.includes("--json")) {
      process.stdout.write(JSON.stringify({ error: { code, message: (err as Error).message } }) + "\n");
    }
    process.exit(code);
  });
