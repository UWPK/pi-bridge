import { test } from "node:test";
import assert from "node:assert/strict";
import { runStep } from "../../src/run-step.js";

/**
 * `bridge check --json` runs steps with piped stdio. If the step writes more than the
 * OS pipe buffer (~64KB) and nobody reads it, the child blocks forever. runStep must
 * consume/discard the pipes so the step still completes.
 */

test("runStep drains a large piped stdout/stderr without deadlocking", async () => {
  const code = await runStep(
    [
      process.execPath,
      "-e",
      "process.stdout.write('x'.repeat(5_000_000)); process.stderr.write('y'.repeat(5_000_000));",
    ],
    process.cwd(),
    false,
  );
  assert.equal(code, 0);
});

test("runStep returns the child's exit code", async () => {
  const code = await runStep([process.execPath, "-e", "process.exit(3)"], process.cwd(), false);
  assert.equal(code, 3);
});
