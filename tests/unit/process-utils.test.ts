import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminateTree } from "../../src/process-utils.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("terminateTree cannot claim success for an already-reaped child on Windows", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((r) => child.on("close", r));
  const ok = await terminateTree(child, 3000);
  if (process.platform === "win32") {
    // taskkill /T cannot enumerate reparented descendants once the parent is gone.
    assert.equal(ok, false);
  } else {
    assert.equal(ok, true);
  }
});

test("terminateTree kills a live tree so a grandchild cannot write a marker later", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pu-marker-"));
  const marker = join(dir, "marker.txt");
  const inner = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`;
  const script =
    `const cp=require('child_process');` +
    `cp.spawn(process.execPath,['-e',${JSON.stringify(inner)}],{stdio:'ignore'});` +
    `setTimeout(()=>{},60000);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await sleep(300);
    const ok = await terminateTree(child, 8000);
    assert.equal(ok, true, "live tree termination is confirmed");
    await sleep(2000);
    assert.equal(existsSync(marker), false, "grandchild was killed together with the tree");
  } finally {
    child.stdout?.destroy();
    child.stderr?.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminateTree returns false when the parent exits but an inheriting descendant keeps the pipes open", async () => {
  // The parent exits ~100ms; the grandchild inherits stdio and lives far past the
  // confirmation window, so termination cannot be proven (fail-closed).
  const script =
    `const cp=require('child_process');` +
    `cp.spawn(process.execPath,['-e','setTimeout(()=>{},6000)'],{stdio:'inherit'});` +
    `setTimeout(()=>process.exit(0),100);`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((r) => child.on("exit", r));
    const ok = await terminateTree(child, 2500);
    assert.equal(ok, false, "cannot prove termination while a descendant holds our pipes");
  } finally {
    // Release our read ends so the orphan's handles do not keep this process alive.
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
});
