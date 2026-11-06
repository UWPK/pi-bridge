import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerifier } from "../../src/verifier.js";
import { BridgeError } from "../../src/errors.js";
import { createFixtureGitProject, passCommand, failCommand, writeFileCommand, treeMarkerCommand } from "../fixtures/create-fixture.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("runVerifier runs a real argv command and records exit code 0 as pass", async () => {
  const fx = createFixtureGitProject("verify-ok");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  try {
    const bundle = await runVerifier([{ kind: "command", command: passCommand(), timeoutSeconds: 20 }], {
      workspace: fx.dir,
      logDir,
      defaultTimeoutSeconds: 20,
      maxLogBytes: 100_000,
    });
    assert.equal(bundle.acceptance, "pass");
    assert.equal(bundle.results.length, 1);
    assert.equal(bundle.results[0].exitCode, 0);
    assert.equal(bundle.results[0].result, "pass");
    assert.ok(bundle.results[0].logRef && existsSync(bundle.results[0].logRef));
  } finally {
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("runVerifier reports a real nonzero exit code as fail (never fakes pass)", async () => {
  const fx = createFixtureGitProject("verify-fail");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  try {
    const bundle = await runVerifier([{ kind: "command", command: failCommand(), timeoutSeconds: 20 }], {
      workspace: fx.dir,
      logDir,
      defaultTimeoutSeconds: 20,
      maxLogBytes: 100_000,
    });
    assert.equal(bundle.acceptance, "fail");
    assert.equal(bundle.results[0].exitCode, 3);
    assert.equal(bundle.results[0].result, "fail");
  } finally {
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("runVerifier returns not_run for an empty acceptance list", async () => {
  const fx = createFixtureGitProject("verify-none");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  try {
    const bundle = await runVerifier([], { workspace: fx.dir, logDir, defaultTimeoutSeconds: 20, maxLogBytes: 100_000 });
    assert.equal(bundle.acceptance, "not_run");
    assert.equal(bundle.results.length, 0);
  } finally {
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("runVerifier executes in the workspace cwd (real side effect) and redacts secrets in logs", async () => {
  const fx = createFixtureGitProject("verify-cwd");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  try {
    const bundle = await runVerifier(
      [
        { kind: "command", command: writeFileCommand("out.txt", "created"), timeoutSeconds: 20 },
        { kind: "command", command: [process.execPath, "-e", "console.log('token=sk-SECRETSECRETSECRET')"], timeoutSeconds: 20 },
      ],
      { workspace: fx.dir, logDir, defaultTimeoutSeconds: 20, maxLogBytes: 100_000 },
    );
    assert.equal(bundle.acceptance, "pass");
    assert.equal(existsSync(join(fx.dir, "out.txt")), true);
    assert.equal(readFileSync(join(fx.dir, "out.txt"), "utf8"), "created");
    const secondLog = readFileSync(bundle.results[1].logRef!, "utf8");
    assert.equal(secondLog.includes("sk-SECRETSECRETSECRET"), false, "secret must be redacted");
  } finally {
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("runVerifier times out long commands and marks them fail", async () => {
  const fx = createFixtureGitProject("verify-timeout");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  try {
    const bundle = await runVerifier(
      [{ kind: "command", command: [process.execPath, "-e", "setTimeout(()=>{}, 60000)"], timeoutSeconds: 1 }],
      { workspace: fx.dir, logDir, defaultTimeoutSeconds: 1, maxLogBytes: 100_000 },
    );
    assert.equal(bundle.acceptance, "fail");
    assert.equal(bundle.results[0].timedOut, true);
  } finally {
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("runVerifier timeout kills the WHOLE process tree (a grandchild cannot keep writing)", async () => {
  const fx = createFixtureGitProject("verify-tree-timeout");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  const markerDir = mkdtempSync(join(tmpdir(), "bridge-marker-"));
  const marker = join(markerDir, "marker.txt");
  try {
    const bundle = await runVerifier(
      [{ kind: "command", command: treeMarkerCommand(marker, 2500), timeoutSeconds: 1 }],
      { workspace: fx.dir, logDir, defaultTimeoutSeconds: 1, maxLogBytes: 100_000 },
    );
    assert.equal(bundle.acceptance, "fail");
    assert.equal(bundle.results[0].timedOut, true);
    // If only the parent were killed, the grandchild would write the marker at ~2.5s.
    await sleep(3200);
    assert.equal(existsSync(marker), false, "grandchild must not survive the timeout kill");
  } finally {
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  }
});

test("runVerifier abort signal kills the tree and runs no further command", async () => {
  const fx = createFixtureGitProject("verify-abort");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  const markerDir = mkdtempSync(join(tmpdir(), "bridge-marker-"));
  const marker = join(markerDir, "marker.txt");
  const controller = new AbortController();
  try {
    const running = runVerifier(
      [
        { kind: "command", command: treeMarkerCommand(marker, 2500), timeoutSeconds: 30 },
        { kind: "command", command: writeFileCommand("second.txt", "x"), timeoutSeconds: 30 },
      ],
      { workspace: fx.dir, logDir, defaultTimeoutSeconds: 30, maxLogBytes: 100_000, signal: controller.signal },
    );
    await sleep(300);
    controller.abort();
    const bundle = await running;
    assert.equal(bundle.acceptance, "fail");
    assert.equal(bundle.results.length, 1, "no further command runs after abort");
    assert.equal(existsSync(join(fx.dir, "second.txt")), false, "second command never ran");
    await sleep(3200);
    assert.equal(existsSync(marker), false, "aborted command's grandchild is terminated");
  } finally {
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
    rmSync(markerDir, { recursive: true, force: true });
  }
});

test("runVerifier fails closed (UNAVAILABLE) when a killed command's tree cannot be confirmed", async () => {
  const fx = createFixtureGitProject("verify-treekill");
  const logDir = mkdtempSync(join(tmpdir(), "bridge-vlog-"));
  // Force the tree-kill (taskkill) to be unavailable so termination cannot be proven
  // while the command is still alive.
  const savedPath = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "bridge-empty-bin-"));
  try {
    await assert.rejects(
      () =>
        runVerifier(
          [{ kind: "command", command: [process.execPath, "-e", "setTimeout(()=>{}, 2500)"], timeoutSeconds: 1 }],
          { workspace: fx.dir, logDir, defaultTimeoutSeconds: 1, maxLogBytes: 100_000, terminateWaitMs: 700 },
        ),
      (err: unknown) => err instanceof BridgeError && err.code === 4,
    );
  } finally {
    // The command could not be killed; let it self-exit (>2.5s) before removing its cwd.
    await sleep(2800);
    process.env.PATH = savedPath;
    fx.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});
