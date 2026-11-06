import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTaskRequest, parseHandoff, parseJsonStrict } from "../../src/schema.js";
import { BridgeError } from "../../src/errors.js";

test("parseTaskRequest accepts a valid v2 request and applies the conservative default (offline)", () => {
  const parsed = parseTaskRequest({
    schemaVersion: "2.0",
    title: "fix bug",
    workspace: "E:\\tmp\\proj",
    mode: "standard",
    objective: "fix the dimension bug",
    scope: ["models/", "tests/"],
    acceptance: [{ kind: "command", command: ["python", "-m", "pytest", "-q"], timeoutSeconds: 60 }],
  });
  assert.equal(parsed.mode, "standard");
  assert.equal(parsed.policy.allowWrite, true);
  assert.equal(parsed.policy.allowNetwork, false, "default stays offline; we never widen permissions silently");
  assert.equal(parsed.policy.maxWorkerTurns, 24);
  assert.deepEqual(parsed.acceptance[0].command, ["python", "-m", "pytest", "-q"]);
});

test("parseTaskRequest rejects missing required fields with exit code 2", () => {
  assert.throws(
    () => parseTaskRequest({ schemaVersion: "2.0", workspace: "x", mode: "standard", objective: "y" }),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});

test("parseTaskRequest rejects an unknown mode", () => {
  assert.throws(
    () => parseTaskRequest({ title: "t", workspace: "w", mode: "hyper", objective: "o" }),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});

test("parseTaskRequest rejects an empty acceptance command argv", () => {
  assert.throws(
    () =>
      parseTaskRequest({
        title: "t",
        workspace: "w",
        mode: "standard",
        objective: "o",
        acceptance: [{ kind: "command", command: [], timeoutSeconds: 10 }],
      }),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});

test("parseTaskRequest rejects non-command acceptance kinds", () => {
  assert.throws(
    () =>
      parseTaskRequest({
        title: "t",
        workspace: "w",
        mode: "standard",
        objective: "o",
        acceptance: [{ kind: "shell", command: ["x"] }],
      }),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});

test("parseTaskRequest validates policy overrides", () => {
  const parsed = parseTaskRequest({
    title: "t",
    workspace: "w",
    mode: "economy",
    objective: "o",
    policy: { allowWrite: true, allowNetwork: true, maxWorkerTurns: 5, timeoutSeconds: 30 },
  });
  assert.equal(parsed.policy.allowWrite, true);
  assert.equal(parsed.policy.allowNetwork, true);
  assert.equal(parsed.policy.maxWorkerTurns, 5);
  assert.equal(parsed.policy.timeoutSeconds, 30);
});

test("parseTaskRequest parses a legacy offline/read-only contract (structure only, no enforcement)", () => {
  // The structural parser must accept these (they are legal requests); whether they
  // are *enforceable* is decided at run time by assertEnforceableRun, not here.
  const offline = parseTaskRequest({
    title: "t",
    workspace: "w",
    mode: "standard",
    objective: "o",
    policy: { allowNetwork: false },
  });
  assert.equal(offline.policy.allowNetwork, false);
  const readonly = parseTaskRequest({
    title: "t",
    workspace: "w",
    mode: "standard",
    objective: "o",
    policy: { allowWrite: false },
  });
  assert.equal(readonly.policy.allowWrite, false);
});

test("parseHandoff rejects an invalid status", () => {
  assert.throws(() => parseHandoff({ taskId: "a", runId: "b", status: "ok" }), BridgeError);
});

test("parseJsonStrict surfaces bad JSON as exit code 2", () => {
  assert.throws(
    () => parseJsonStrict("{not json", "task file"),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});
