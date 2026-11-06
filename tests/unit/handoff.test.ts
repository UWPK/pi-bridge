import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, boundText, decideStatus, buildHandoff, serializeHandoff, type HandoffInput } from "../../src/handoff.js";

function baseInput(over: Partial<HandoffInput> = {}): HandoffInput {
  return {
    taskId: "task_x",
    runId: "run_x",
    workerModel: "fixture-provider/fixture-model",
    workerFinalText: "done",
    changedFiles: [],
    diffSummary: { files: 0, insertions: 0, deletions: 0 },
    verification: [],
    acceptance: "not_run",
    executionOk: true,
    summaryMaxTokens: 800,
    summaryMaxChars: 4000,
    ...over,
  };
}

test("boundText truncates by character cap and marks truncation", () => {
  const big = "a".repeat(10_000);
  const { text, truncated } = boundText(big, 800, 500);
  assert.equal(truncated, true);
  assert.ok(text.length <= 500 + 40);
  assert.match(text, /摘要已截断/);
});

test("boundText truncates by token budget", () => {
  const text = "word ".repeat(5000);
  const { truncated } = boundText(text, 100, 100000);
  assert.equal(truncated, true);
  assert.ok(estimateTokens(boundText(text, 100, 100000).text) <= 140);
});

test("boundText leaves small text intact", () => {
  const { text, truncated } = boundText("short summary", 800, 4000);
  assert.equal(truncated, false);
  assert.equal(text, "short summary");
});

test("estimateTokens is roughly bytes/4", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});

test("decideStatus: worker claim alone is partial, never passed", () => {
  const status = decideStatus(baseInput({ verification: [], acceptance: "not_run", executionOk: true }));
  assert.equal(status, "partial");
});

test("decideStatus: real verifier pass yields passed", () => {
  const status = decideStatus(
    baseInput({
      verification: [{ command: ["node", "-e", "0"], exitCode: 0, result: "pass", logRef: "x", timedOut: false }],
      acceptance: "pass",
    }),
  );
  assert.equal(status, "passed");
});

test("decideStatus: failing verifier yields failed", () => {
  const status = decideStatus(
    baseInput({
      verification: [{ command: ["node", "-e", "1"], exitCode: 1, result: "fail", logRef: "x", timedOut: false }],
      acceptance: "fail",
    }),
  );
  assert.equal(status, "failed");
});

test("decideStatus: execution error yields failed, blocked prefix yields blocked", () => {
  assert.equal(decideStatus(baseInput({ executionOk: false })), "failed");
  assert.equal(decideStatus(baseInput({ executionOk: false, stopReason: "blocked:out_of_scope_change" })), "blocked");
});

test("buildHandoff records evidenceLevel and risks for claim-only results", () => {
  const h = buildHandoff(baseInput({ verification: [] }));
  assert.equal(h.evidenceLevel, "worker_claim_only");
  assert.ok(h.risks.some((r) => r.includes("无真实验收命令结果")));
  assert.equal(h.status, "partial");
});

test("buildHandoff with verifier evidence is 'verified'", () => {
  const h = buildHandoff(
    baseInput({
      verification: [{ command: ["node", "-e", "0"], exitCode: 0, result: "pass", logRef: "r", timedOut: false }],
      acceptance: "pass",
    }),
  );
  assert.equal(h.evidenceLevel, "verified");
  assert.equal(h.status, "passed");
});

test("serializeHandoff keeps output bounded", () => {
  const h = buildHandoff(baseInput({ workerFinalText: "x".repeat(100000) }));
  const out = serializeHandoff(h, 5000);
  assert.ok(out.length <= 5000 + 400);
});
