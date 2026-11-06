import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertEnforceablePolicy,
  assertEnforceableRun,
  unenforceableRestrictions,
  unenforceableScope,
} from "../../src/policy-enforcement.js";
import { DEFAULT_POLICY } from "../../src/types.js";
import type { TaskPolicy } from "../../src/types.js";
import { BridgeError } from "../../src/errors.js";

const HOST_POLICY: TaskPolicy = { ...DEFAULT_POLICY, allowWrite: true, allowNetwork: true };

test("the default policy is offline and therefore NOT enforceable (fail-closed at run time)", () => {
  assert.deepEqual(unenforceableRestrictions(DEFAULT_POLICY), ["allowNetwork:false（断网）"]);
  assert.throws(
    () => assertEnforceablePolicy(DEFAULT_POLICY),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
  assert.throws(() => assertEnforceableRun(DEFAULT_POLICY, []), BridgeError);
});

test("allowWrite:false is rejected fail-closed with exit code 2", () => {
  assert.deepEqual(unenforceableRestrictions({ ...HOST_POLICY, allowWrite: false }), ["allowWrite:false（只读）"]);
  assert.throws(
    () => assertEnforceablePolicy({ ...HOST_POLICY, allowWrite: false }),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});

test("allowNetwork:false is rejected fail-closed with exit code 2", () => {
  assert.deepEqual(unenforceableRestrictions({ ...HOST_POLICY, allowNetwork: false }), ["allowNetwork:false（断网）"]);
  assert.throws(
    () => assertEnforceablePolicy({ ...HOST_POLICY, allowNetwork: false }),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});

test("a fully-open policy with a whole-workspace scope is allowed", () => {
  assert.doesNotThrow(() => assertEnforceableRun(HOST_POLICY, []));
  assert.doesNotThrow(() => assertEnforceableRun(HOST_POLICY, [""])); // '.' / workspace root normalizes to ""
});

test("a sub-directory/file scope is rejected up-front (cannot be hard-enforced)", () => {
  assert.deepEqual(unenforceableScope(["src", ""]), ["src"]);
  assert.throws(
    () => assertEnforceableRun(HOST_POLICY, ["src"]),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
  // and a scope restriction is also reported together with any policy restriction
  assert.throws(
    () => assertEnforceableRun({ ...HOST_POLICY, allowNetwork: false }, ["src"]),
    BridgeError,
  );
});

test("the fail-closed rejection keeps the original error-contract wording", () => {
  assert.throws(
    () => assertEnforceablePolicy({ ...HOST_POLICY, allowNetwork: false }),
    (err: unknown) => {
      const msg = (err as Error).message;
      return (
        msg.includes("拒绝无法强制执行的策略（fail-closed）: allowNetwork:false（断网）。") &&
        msg.includes("Bridge 只能驱动 pi 进程，没有 OS/工具层沙箱：allowWrite/allowNetwork 无法作为隔离保证。") &&
        msg.includes("若确实需要只读或断网，请在容器/VM/OpenShell 等隔离环境中运行 pi，并在隔离边界内移除这些声明后重试。")
      );
    },
  );
});
