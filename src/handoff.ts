import type {
  Handoff,
  HandoffStatus,
  ChangedFile,
  VerificationResult,
  DiffSummary,
  AcceptanceStatus,
} from "./types.js";
import { redactText } from "./redact.js";

/**
 * Bounded handoff construction (需求文档 §5.3, §9.2).
 *
 * The Codex/GPT side must receive a small structured summary, never raw pi stdout,
 * file contents or stack traces. We enforce both an estimated-token cap and a hard
 * character cap, and we record evidence level so a worker's prose claim alone can
 * never produce `passed`.
 */

export const HANDOFF_SCHEMA_VERSION = "2.0";

export interface HandoffInput {
  taskId: string;
  runId: string;
  workerModel: string;
  workerFinalText: string;
  changedFiles: ChangedFile[];
  diffSummary: DiffSummary;
  verification: VerificationResult[];
  acceptance: AcceptanceStatus;
  executionOk: boolean;
  stopReason?: string | null;
  risks?: string[];
  nextAction?: string;
  rawLogRef?: string | null;
  summaryMaxTokens: number;
  summaryMaxChars: number;
}

/** Rough token estimate (bytes/4 heuristic), matching pi's own estimateTokens philosophy. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Trim text so it fits both the token and char budget. Truncation is marked so the
 * receiver knows the summary is incomplete and should consult `bridge logs`.
 */
export function boundText(text: string, maxTokens: number, maxChars: number): { text: string; truncated: boolean } {
  const clean = redactText(text ?? "").replace(/\r\n/g, "\n").trim();
  let truncated = false;
  let out = clean;
  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  // trim by token budget too
  if (estimateTokens(out) > maxTokens) {
    // ~4 chars per token
    const budgetChars = maxTokens * 4;
    out = out.slice(0, budgetChars);
    truncated = true;
  }
  if (truncated) out = out.replace(/\s+$/, "") + "\n[摘要已截断，完整证据见 bridge logs]";
  return { text: out, truncated };
}

/**
 * Decide the outward status. A worker claiming success with no real verifier evidence
 * is `partial` at best (需求文档 §5.3, AC-06).
 */
export function decideStatus(input: HandoffInput): HandoffStatus {
  if (!input.executionOk) {
    if (input.stopReason?.startsWith("blocked")) return "blocked";
    return "failed";
  }
  const hasVerifier = input.verification.some((v) => v.result === "pass" || v.result === "fail");
  if (!hasVerifier) {
    // No acceptance command produced a result: can't be `passed`.
    if (input.acceptance === "blocked") return "blocked";
    return "partial";
  }
  if (input.acceptance === "pass") return "passed";
  if (input.acceptance === "blocked") return "blocked";
  return "failed";
}

export function buildHandoff(input: HandoffInput): Handoff {
  const status = decideStatus(input);
  const hasVerifier = input.verification.some((v) => v.result === "pass" || v.result === "fail");
  const bounded = boundText(input.workerFinalText, input.summaryMaxTokens, input.summaryMaxChars);

  const risks = [...(input.risks ?? [])];
  if (bounded.truncated) risks.push("worker 摘要超限已截断，请用 bridge logs 查看完整证据");
  if (!hasVerifier) risks.push("无真实验收命令结果，worker 自报完成不构成 passed 证据");

  const evidenceLevel: Handoff["evidenceLevel"] = hasVerifier
    ? "verified"
    : input.workerFinalText?.trim()
      ? "worker_claim_only"
      : "none";

  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    taskId: input.taskId,
    runId: input.runId,
    status,
    workerModel: input.workerModel,
    summary: bounded.text || "(worker 未返回文本摘要)",
    changedFiles: input.changedFiles,
    verification: input.verification,
    diffSummary: input.diffSummary,
    risks,
    nextAction: input.nextAction ?? defaultNextAction(status),
    rawLogRef: input.rawLogRef ?? null,
    evidenceLevel,
  };
}

function defaultNextAction(status: HandoffStatus): string {
  switch (status) {
    case "passed":
      return "GPT 依据现有证据判定是否验收；科研方法正确性仍需人工/GPT 复核";
    case "partial":
      return "缺少确定性验收证据，请检查 diff 后决定是否补充 acceptance 命令重跑";
    case "failed":
      return "验收未通过，请查看 bridge logs 中的失败日志并决定返工范围";
    case "blocked":
      return "命中停止条件，需要主控/GPT 明确新边界后再派发";
  }
}

/** Enforce a hard cap on the serialized handoff sent to the caller. */
export function serializeHandoff(h: Handoff, maxChars = 20000): string {
  let json = JSON.stringify(h, null, 2);
  if (json.length > maxChars) {
    const trimmed: Handoff = {
      ...h,
      summary: h.summary.slice(0, Math.max(200, maxChars - 2000)),
      risks: [...h.risks, "handoff 序列化超限已截断"],
    };
    json = JSON.stringify(trimmed, null, 2);
  }
  return json;
}
