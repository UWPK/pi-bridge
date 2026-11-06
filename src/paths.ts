import { realpathSync, existsSync, statSync } from "node:fs";
import { resolve, sep, normalize } from "node:path";
import { BridgeError, ExitCode } from "./errors.js";

/**
 * Path authorization and boundary checks (需求文档 §8.1).
 *
 * A cwd whitelist is NOT an OS sandbox; it only prevents the bridge itself from
 * starting work in, or writing to, an unapproved location. We still refuse to
 * advertise it as a hard sandbox in docs.
 */

/** Canonicalize a path, resolving symlinks/junctions and `..`. Falls back to a resolved path when missing. */
export function canonicalize(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return normalize(abs);
  }
}

/**
 * True when `child` equals `root` or lives under it, using a strict directory-boundary
 * comparison so `E:\Proj` never matches `E:\Project2` (需求文档 §8.1).
 */
export function isWithin(root: string, child: string): boolean {
  const r = canonicalize(root);
  const c = canonicalize(child);
  if (r === c) return true;
  const withSep = r.endsWith(sep) ? r : r + sep;
  return c.startsWith(withSep);
}

export function assertExistsDir(dir: string, label = "目录"): string {
  const abs = canonicalize(dir);
  if (!existsSync(abs)) {
    throw new BridgeError(ExitCode.UNAUTHORIZED, `${label}不存在: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new BridgeError(ExitCode.UNAUTHORIZED, `${label}不是目录: ${abs}`);
  }
  return abs;
}

/**
 * Assert `target` is inside one of the authorized roots.
 * Returns the canonical target.
 */
export function assertAuthorized(target: string, authorizedRoots: string[]): string {
  const abs = assertExistsDir(target);
  if (authorizedRoots.length === 0) {
    throw new BridgeError(
      ExitCode.UNAUTHORIZED,
      `尚未授权任何工作目录，请先执行: bridge authorize --dir "${abs}"`,
    );
  }
  if (!authorizedRoots.some((root) => isWithin(root, abs))) {
    throw new BridgeError(
      ExitCode.UNAUTHORIZED,
      `路径未授权或越界: ${abs}；已授权根: ${authorizedRoots.join(", ")}`,
    );
  }
  return abs;
}

/**
 * Check that every workspace-relative scope entry stays inside the workspace.
 * Returns normalized scope prefixes (workspace-relative, forward slashes) or throws.
 */
export function validateScope(workspace: string, scope: string[] | undefined): string[] {
  const root = canonicalize(workspace);
  const out: string[] = [];
  for (const raw of scope ?? []) {
    // Explicit empty string means "whole workspace" (equivalent to [] / ["."]); a
    // whitespace-only entry is still invalid.
    if (typeof raw !== "string" || (raw !== "" && raw.trim() === "")) {
      throw new BridgeError(ExitCode.BAD_REQUEST, `scope 条目非法: ${JSON.stringify(raw)}`);
    }
    const candidate = raw.startsWith("/") || /^[A-Za-z]:/.test(raw)
      ? canonicalize(raw)
      : canonicalize(resolve(root, raw));
    if (!isWithin(root, candidate)) {
      throw new BridgeError(ExitCode.UNAUTHORIZED, `scope 越界: ${raw} 不在 ${root} 之内`);
    }
    // keep as workspace-relative prefix for later diff checks
    const rel = candidate.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    out.push(rel);
  }
  return out;
}

/** Normalize a workspace-relative path/prefix to forward slashes without leading `./` or trailing `/`. */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/**
 * True when a workspace-relative path is covered by any scope prefix.
 *
 * Matching is by path *component boundary*, not a raw string prefix: scope `src`
 * must cover `src/file.ts` but never `src2/file.ts`. An empty scope array, or a
 * prefix equal to the workspace root (normalized to `""`), keeps the existing
 * whole-workspace semantics.
 */
export function inScope(relPath: string, scopePrefixes: string[]): boolean {
  if (scopePrefixes.length === 0) return true;
  const norm = normalizeRel(relPath);
  return scopePrefixes.some((p) => {
    const prefix = normalizeRel(p);
    if (prefix === "") return true; // whole workspace (existing semantics)
    return norm === prefix || norm.startsWith(prefix + "/");
  });
}
