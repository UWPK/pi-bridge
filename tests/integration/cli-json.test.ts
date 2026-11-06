import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "..", "src", "cli.js");

function runCli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function runCliAsync(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("cli --json help prints machine-parseable JSON to stdout only", () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const r = runCli(["help", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.usage);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli config show --json emits valid JSON with no diagnostics on stdout", () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const r = runCli(["config", "show", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.pi.provider, process.env.BRIDGE_PI_PROVIDER || "");
    assert.equal(parsed.pi.model, process.env.BRIDGE_PI_MODEL || "");
    assert.ok(parsed.limits.summaryMaxTokens > 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli unknown command exits with code 2 and JSON error", () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const r = runCli(["frobnicate", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 2);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.error, "unknown_command");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli status without a daemon exits with code 4 and JSON error (unavailable)", () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const r = runCli(["status", "--task", "task_x", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 4);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.error);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli delegate with bad JSON file exits with code 2", () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const badFile = join(home, "task.json");
    writeFileSync(badFile, "{not valid json", "utf8");
    const r = runCli(["delegate", "--task-file", badFile, "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 2);
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.error);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli doctor --json never leaks non-JSON onto stdout", () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const r = runCli(["doctor", "--json"], { BRIDGE_HOME: home });
    // daemon not running -> still valid JSON on stdout, reported honestly with exit 4
    const parsed = JSON.parse(r.stdout);
    assert.ok(parsed.version);
    assert.equal(parsed.daemonRunning, false);
    assert.equal(r.code, 4);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli down reports not-running without error when there is no endpoint", () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-cli-"));
  try {
    const r = runCli(["down", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.running, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli down only reports stopped and removes the endpoint after the daemon actually stops", async () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-down-"));
  const token = "test-token";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let cmd = "";
      try {
        cmd = (JSON.parse(body || "{}") as { command?: string }).command ?? "";
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (cmd === "shutdown") {
        res.end(JSON.stringify({ ok: true, data: { stopping: true } }));
        // Stop answering shortly after acknowledging, simulating a real stop.
        setTimeout(() => server.close(), 50);
      } else {
        res.end(JSON.stringify({ ok: true, data: { ok: true, pid: process.pid } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(join(home, "daemon.port"), String(port), "utf8");
  writeFileSync(join(home, "daemon.token"), token, "utf8");
  try {
    const r = await runCliAsync(["down", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.stopped, true);
    assert.equal(existsSync(join(home, "daemon.port")), false, "endpoint removed only after a real stop");
  } finally {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    rmSync(home, { recursive: true, force: true });
  }
});

async function startFakeDaemon(home: string, doctorData: unknown): Promise<{ close: () => void }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let cmd = "";
      try {
        cmd = (JSON.parse(body || "{}") as { command?: string }).command ?? "";
      } catch {
        /* ignore */
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (cmd === "doctor") res.end(JSON.stringify({ ok: true, data: doctorData }));
      else res.end(JSON.stringify({ ok: true, data: { ok: true, pid: process.pid } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(join(home, "daemon.port"), String(port), "utf8");
  writeFileSync(join(home, "daemon.token"), "test-token", "utf8");
  return { close: () => server.close() };
}

test("cli doctor exits 4 when the daemon reports failed health", async () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-doc-"));
  const fake = await startFakeDaemon(home, { health: "failed", worker: { ok: false } });
  try {
    const r = await runCliAsync(["doctor", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 4, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.daemonRunning, true);
    assert.equal(parsed.health, "failed");
  } finally {
    fake.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("cli doctor annotates unknown health for a busy daemon but exits 0", async () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-doc-"));
  const fake = await startFakeDaemon(home, { health: "unknown", startup: { skipped: true }, worker: { ok: true } });
  try {
    const r = await runCliAsync(["doctor", "--json"], { BRIDGE_HOME: home });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.daemonRunning, true);
    assert.equal(parsed.health, "unknown");
  } finally {
    fake.close();
    rmSync(home, { recursive: true, force: true });
  }
});
