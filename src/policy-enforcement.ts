import type { TaskPolicy } from "./types.js";
import { BridgeError, ExitCode } from "./errors.js";

/**
 * Runtime enforceability gate (fail-closed), applied by the task engine *before*
 * any DB write or worker spawn — never by structural parsing.
 *
 * The Bridge drives a real `pi` process, which runs with the permissions of the
 * current OS user and has **no built-in sandbox** (see pi docs/security.md and
 * docs/containerization.md). Therefore the Bridge cannot enforce at the OS/tool
 * layer:
 *   - `allowWrite: false` could only be *detected* after the fact via `git diff`,
 *     which is not prevention and cannot be trusted as read-only.
 *   - `allowNetwork: false` has no execution-path enforcement at all.
 *   - a subdirectory/file `scope` cannot be hard-limited either: pi can still read
 *     or write anywhere the OS user can, so a scope is at best a post-hoc check.
 *
 * Rather than advertise an isolation guarantee the Bridge cannot keep, we refuse
 * to *run* any task that requests such a restriction (fail-closed). Whole-workspace
 * tasks (`scope` empty, `["."]`, or the workspace root) that explicitly opt into
 * `allowWrite:true` + `allowNetwork:true` are accepted for a trusted host.
 *
 * Note: structural validation (`parseTaskRequest`) intentionally does NOT call this
 * gate, so a legal legacy request carrying the default `allowNetwork:false` still
 * parses; it is only refused when someone actually tries to execute it.
 */

/** Requested policy restrictions the Bridge cannot enforce. */
export function unenforceableRestrictions(policy: TaskPolicy): string[] {
  const out: string[] = [];
  if (policy.allowWrite === false) out.push("allowWrite:false（只读）");
  if (policy.allowNetwork === false) out.push("allowNetwork:false（断网）");
  return out;
}

/**
 * Scope entries that request a sub-directory/file limit the Bridge cannot enforce.
 * A normalized prefix of `""` means the whole workspace, which is allowed.
 */
export function unenforceableScope(scopePrefixes: string[]): string[] {
  return scopePrefixes.filter((p) => p !== "");
}

function rejectionMessage(reasons: string[]): string {
  // Kept verbatim from the original policy error contract; do not reword.
  return (
    `拒绝无法强制执行的策略（fail-closed）: ${reasons.join("、")}。` +
    `Bridge 只能驱动 pi 进程，没有 OS/工具层沙箱：allowWrite/allowNetwork 无法作为隔离保证。` +
    `若确实需要只读或断网，请在容器/VM/OpenShell 等隔离环境中运行 pi，并在隔离边界内移除这些声明后重试。`
  );
}

/** Throw exit code 2 when only the *policy* requests an unenforceable restriction. */
export function assertEnforceablePolicy(policy: TaskPolicy): void {
  const bad = unenforceableRestrictions(policy);
  if (bad.length === 0) return;
  throw new BridgeError(ExitCode.BAD_REQUEST, rejectionMessage(bad));
}

/**
 * Full run-time gate used by TaskEngine.submit/resume: refuses an unenforceable
 * policy AND a sub-directory/file scope. `scopePrefixes` are the normalized,
 * workspace-relative prefixes produced by `validateScope`.
 */
export function assertEnforceableRun(policy: TaskPolicy, scopePrefixes: string[]): void {
  const reasons = unenforceableRestrictions(policy);
  const scopes = unenforceableScope(scopePrefixes);
  if (scopes.length) reasons.push(`scope 限定为子目录/文件（${scopes.join(", ")}）`);
  if (reasons.length === 0) return;
  throw new BridgeError(ExitCode.BAD_REQUEST, rejectionMessage(reasons));
}
