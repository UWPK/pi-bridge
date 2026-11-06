import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWithin, assertAuthorized, validateScope, inScope, canonicalize } from "../../src/paths.js";
import { BridgeError } from "../../src/errors.js";

const tmp = mkdtempSync(join(tmpdir(), "bridge-paths-"));
const proj = join(tmp, "Proj");
const proj2 = join(tmp, "Project2");
mkdirSync(join(proj, "models"), { recursive: true });
mkdirSync(join(proj, "tests"), { recursive: true });
mkdirSync(proj2, { recursive: true });
writeFileSync(join(proj, "models", "net.py"), "x");
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

test("isWithin respects the directory boundary (E:\\Proj vs E:\\Project2)", () => {
  assert.equal(isWithin(proj, join(proj, "models", "net.py")), true);
  assert.equal(isWithin(proj, proj), true);
  assert.equal(isWithin(proj, proj2), false);
  assert.equal(isWithin(proj, join(proj2, "x")), false);
});

test("isWithin rejects a crafted sibling-prefix escape", () => {
  const sneaky = `${proj}2\\inner`;
  assert.equal(isWithin(proj, sneaky), false);
});

test("assertAuthorized rejects an unauthorized path with exit 5", () => {
  assert.throws(
    () => assertAuthorized(proj2, [proj]),
    (err: unknown) => err instanceof BridgeError && err.code === 5,
  );
});

test("assertAuthorized rejects when no roots are configured", () => {
  assert.throws(
    () => assertAuthorized(proj, []),
    (err: unknown) => err instanceof BridgeError && err.code === 5,
  );
});

test("assertAuthorized accepts an in-root path", () => {
  const abs = assertAuthorized(join(proj, "models"), [proj]);
  assert.equal(abs, canonicalize(join(proj, "models")));
});

test("validateScope returns workspace-relative prefixes", () => {
  const scope = validateScope(proj, ["models/", "tests/"]);
  assert.deepEqual(scope.sort(), ["models", "tests"]);
});

test("validateScope rejects a scope that escapes the workspace", () => {
  assert.throws(
    () => validateScope(proj, ["../Project2"]),
    (err: unknown) => err instanceof BridgeError && err.code === 5,
  );
});

test("validateScope treats an explicit '' as whole workspace; whitespace-only is still rejected", () => {
  // '' / '.' both mean "the whole workspace" (normalized to "").
  assert.deepEqual(validateScope(proj, [""]), [""]);
  assert.deepEqual(validateScope(proj, ["."]), [""]);
  // blank (non-empty whitespace) remains invalid input.
  assert.throws(
    () => validateScope(proj, ["   "]),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
  assert.throws(
    () => validateScope(proj, ["\t"]),
    (err: unknown) => err instanceof BridgeError && err.code === 2,
  );
});

test("inScope matches file paths under a prefix and rejects others", () => {
  assert.equal(inScope("models/net.py", ["models"]), true);
  assert.equal(inScope("models", ["models"]), true);
  assert.equal(inScope("src/other.py", ["models"]), false);
  assert.equal(inScope("anything/at/all.py", []), true);
});

test("inScope respects path component boundaries (scope 'src' must not match 'src2')", () => {
  assert.equal(inScope("src2/file.ts", ["src"]), false);
  assert.equal(inScope("src2", ["src"]), false);
  assert.equal(inScope("srcs/file.ts", ["src"]), false);
  assert.equal(inScope("src/file.ts", ["src"]), true);
  assert.equal(inScope("src/nested/file.ts", ["src"]), true);
  assert.equal(inScope("src", ["src"]), true);
  // trailing slash / backslash prefixes normalize consistently
  assert.equal(inScope("src/file.ts", ["src/"]), true);
  assert.equal(inScope("src\\file.ts", ["src"]), true);
  assert.equal(inScope("src2/file.ts", ["src/"]), false);
  // empty prefix keeps whole-workspace semantics
  assert.equal(inScope("anything/x.ts", [""]), true);
});
