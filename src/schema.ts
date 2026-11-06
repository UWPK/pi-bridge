import type { TaskRequest, Handoff, AcceptanceCommand, TaskMode, TaskPolicy } from "./types.js";
import { DEFAULT_POLICY } from "./types.js";
import { BridgeError, ExitCode } from "./errors.js";

/**
 * Runtime schema validation (需求文档 §5.2, §5.3).
 *
 * We hand-roll validation to keep runtime dependencies at zero and to produce
 * precise, actionable error messages with exit code 2 on bad input.
 */

const MODES: TaskMode[] = ["economy", "standard", "strict"];

function fail(message: string, details?: unknown): never {
  throw new BridgeError(ExitCode.BAD_REQUEST, `TaskRequest 校验失败: ${message}`, details);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) fail(`${field} 必须是字符串数组`);
  return v.map((x, i) => {
    if (typeof x !== "string") fail(`${field}[${i}] 必须是字符串`);
    return x;
  });
}

function parseAcceptance(v: unknown): AcceptanceCommand[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) fail("acceptance 必须是数组");
  return v.map((entry, i) => {
    if (!isObject(entry)) fail(`acceptance[${i}] 必须是对象`);
    if (entry.kind !== "command") fail(`acceptance[${i}].kind 目前只支持 "command"`);
    if (!Array.isArray(entry.command) || entry.command.length === 0) {
      fail(`acceptance[${i}].command 必须是非空 argv 数组`);
    }
    const argv = entry.command.map((c, j) => {
      if (typeof c !== "string") fail(`acceptance[${i}].command[${j}] 必须是字符串`);
      return c;
    });
    let timeoutSeconds: number | undefined;
    if (entry.timeoutSeconds !== undefined) {
      if (typeof entry.timeoutSeconds !== "number" || !Number.isFinite(entry.timeoutSeconds) || entry.timeoutSeconds <= 0) {
        fail(`acceptance[${i}].timeoutSeconds 必须是正数`);
      }
      timeoutSeconds = entry.timeoutSeconds;
    }
    return { kind: "command", command: argv, timeoutSeconds };
  });
}

function parsePolicy(v: unknown): Partial<TaskPolicy> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObject(v)) fail("policy 必须是对象");
  const out: Partial<TaskPolicy> = {};
  if (v.allowWrite !== undefined) {
    if (typeof v.allowWrite !== "boolean") fail("policy.allowWrite 必须是布尔值");
    out.allowWrite = v.allowWrite;
  }
  if (v.allowNetwork !== undefined) {
    if (typeof v.allowNetwork !== "boolean") fail("policy.allowNetwork 必须是布尔值");
    out.allowNetwork = v.allowNetwork;
  }
  if (v.requireCleanDiff !== undefined) {
    if (typeof v.requireCleanDiff !== "boolean") fail("policy.requireCleanDiff 必须是布尔值");
    out.requireCleanDiff = v.requireCleanDiff;
  }
  if (v.maxWorkerTurns !== undefined) {
    if (typeof v.maxWorkerTurns !== "number" || !Number.isInteger(v.maxWorkerTurns) || v.maxWorkerTurns <= 0) {
      fail("policy.maxWorkerTurns 必须是正整数");
    }
    out.maxWorkerTurns = v.maxWorkerTurns;
  }
  if (v.timeoutSeconds !== undefined) {
    if (typeof v.timeoutSeconds !== "number" || !Number.isFinite(v.timeoutSeconds) || v.timeoutSeconds <= 0) {
      fail("policy.timeoutSeconds 必须是正数");
    }
    out.timeoutSeconds = v.timeoutSeconds;
  }
  return out;
}

export interface ParsedTaskRequest extends Required<Pick<TaskRequest, "title" | "workspace" | "mode" | "objective">> {
  schemaVersion: string;
  taskId?: string;
  model?: string;
  scope: string[];
  constraints: string[];
  acceptance: AcceptanceCommand[];
  stopConditions: string[];
  policy: TaskPolicy;
}

export function parseTaskRequest(input: unknown): ParsedTaskRequest {
  if (!isObject(input)) fail("顶层必须是 JSON 对象");
  const req = input as Record<string, unknown>;

  const schemaVersion = typeof req.schemaVersion === "string" ? req.schemaVersion : "2.0";
  if (!/^2\./.test(schemaVersion)) fail(`不支持的 schemaVersion: ${schemaVersion} (期望 2.x)`);

  if (typeof req.title !== "string" || req.title.trim() === "") fail("title 必填且为非空字符串");
  if (typeof req.workspace !== "string" || req.workspace.trim() === "") fail("workspace 必填且为非空字符串");
  if (typeof req.objective !== "string" || req.objective.trim() === "") fail("objective 必填且为非空字符串");
  if (typeof req.mode !== "string" || !MODES.includes(req.mode as TaskMode)) {
    fail(`mode 必须是 ${MODES.join(" | ")}`);
  }
  if (req.model !== undefined && typeof req.model !== "string") fail("model 必须是字符串");
  if (req.taskId !== undefined && typeof req.taskId !== "string") fail("taskId 必须是字符串");

  // Structural validation only: a legal legacy request with the default
  // `allowNetwork:false` must still parse. Whether the requested policy/scope is
  // *enforceable* is decided at run time by TaskEngine.submit/resume via
  // assertEnforceableRun() — not here.
  const policy = { ...DEFAULT_POLICY, ...(parsePolicy(req.policy) ?? {}) };

  return {
    schemaVersion,
    taskId: req.taskId as string | undefined,
    title: req.title,
    workspace: req.workspace,
    mode: req.mode as TaskMode,
    model: req.model as string | undefined,
    objective: req.objective,
    scope: asStringArray(req.scope, "scope") ?? [],
    constraints: asStringArray(req.constraints, "constraints") ?? [],
    acceptance: parseAcceptance(req.acceptance) ?? [],
    stopConditions: asStringArray(req.stopConditions, "stopConditions") ?? [],
    policy,
  };
}

export function parseHandoff(input: unknown): Handoff {
  if (!isObject(input)) throw new BridgeError(ExitCode.BAD_REQUEST, "Handoff 必须是 JSON 对象");
  const h = input as Record<string, unknown>;
  const allowedStatus = ["passed", "partial", "failed", "blocked"];
  if (typeof h.status !== "string" || !allowedStatus.includes(h.status)) {
    throw new BridgeError(ExitCode.BAD_REQUEST, `Handoff.status 非法: ${String(h.status)}`);
  }
  if (typeof h.taskId !== "string" || typeof h.runId !== "string") {
    throw new BridgeError(ExitCode.BAD_REQUEST, "Handoff 缺少 taskId/runId");
  }
  return h as unknown as Handoff;
}

/** Parse JSON from a file/stdin string, converting parse failures to exit code 2. */
export function parseJsonStrict(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BridgeError(ExitCode.BAD_REQUEST, `${label} 不是合法 JSON: ${(err as Error).message}`);
  }
}
