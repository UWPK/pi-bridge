import { piWorkerArgs, validatePiWorkerSupport } from "../../src/worker-profile.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { createFixtureGitProject } from "../fixtures/create-fixture.js";
import { defaultConfig, resolvePiCli } from "../../src/config.js";
import { PiRpcProcess } from "../../src/rpc-client.js";

/**
 * End-to-end smoke test against the REAL pi CLI and this machine's credentials.
 *
 * Disabled live tests skip. Once explicitly enabled, unavailable credentials,
 * network/model errors and failed acceptance fail the test. It
 * never fabricates a pass. This is the only test that proves the real Codex ->
 * Bridge -> pi DeepSeek path (需求文档 §10.1 AC-03/04).
 */

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "..", "..", "src", "cli.js");

const PROVIDER = process.env.BRIDGE_PI_PROVIDER || "";
const MODEL = process.env.BRIDGE_PI_MODEL || "";
const SMOKE_SECONDS = Number(process.env.BRIDGE_SMOKE_TIMEOUT_SECONDS || 300);
if (!Number.isInteger(SMOKE_SECONDS) || SMOKE_SECONDS < 30 || SMOKE_SECONDS > 3600) throw new Error("BRIDGE_SMOKE_TIMEOUT_SECONDS must be an integer from 30 to 3600");

interface ProbeResult {
  available: boolean;
  reason: string;
  piCli: string | null;
}

/** Cheap readiness probe: can we spawn pi RPC and get a real model reply? */
async function probeCredentials(): Promise<ProbeResult> {
  if (process.env.BRIDGE_LIVE_TEST !== "1") return { available: false, reason: "Set BRIDGE_LIVE_TEST=1 to authorize real model requests", piCli: null };
  let piCli: string | null = null;
  try {
    piCli = resolvePiCli();
  } catch (err) {
    return { available: false, reason: `pi CLI 未找到: ${(err as Error).message}`, piCli: null };
  }

  const home = mkdtempSync(join(tmpdir(), "bridge-probe-"));
  const pi = { ...defaultConfig().pi, cliPath: piCli };
  const loaderArgs = piWorkerArgs(pi);
  validatePiWorkerSupport(pi, loaderArgs);
  const probeAbort = new AbortController();
  const proc = new PiRpcProcess({
    cliPath: piCli,
    nodePath: process.execPath,
    cwd: home,
    provider: PROVIDER,
    model: MODEL,
    args: ["--no-session", ...loaderArgs],
  });
  try {
    await proc.start(30_000);
    const completion = waitSettled(proc, SMOKE_SECONDS * 1000, probeAbort.signal);
    const resp = await proc.prompt("Reply with exactly: BRIDGE_SMOKE_OK", 30_000);
    if (!resp.success) {
      return { available: false, reason: `prompt 被拒绝: ${resp.error ?? "unknown"}`, piCli };
    }
    const settled = await completion;
    if (!settled) return { available: false, reason: `模型未在 ${SMOKE_SECONDS}s 内 agent_settled`, piCli };
    return { available: true, reason: "ok", piCli };
  } catch (err) {
    return { available: false, reason: `无法与真实 pi 通信: ${(err as Error).message}`, piCli };
  } finally {
    probeAbort.abort();
    try {
      await proc.stop(3000);
    } catch {
      /* ignore */
    }
    rmSync(home, { recursive: true, force: true });
  }
}

function waitSettled(proc: PiRpcProcess, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolveSettled) => {
    let unsub = () => {};
    const finish = (value: boolean) => {
      clearTimeout(timer);
      unsub();
      signal.removeEventListener("abort", onAbort);
      resolveSettled(value);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(onAbort, timeoutMs);
    unsub = proc.onEvent(event => {
      if (event.type === "agent_settled") finish(!(event as { aborted?: boolean }).aborted);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function runCli(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: (SMOKE_SECONDS + 60) * 1000,
  });
  return { code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

test("smoke: real pi RPC handshake and a real model turn", async (t) => {
  const probe = await probeCredentials();
  if (!probe.available) {
    if (process.env.BRIDGE_LIVE_TEST === "1") assert.fail(probe.reason);
    t.skip(`SKIP: 真实 pi 模型不可用 -> ${probe.reason}`);
    return;
  }
  assert.ok(probe.piCli);
  // Reaching here means a real spawn + prompt + agent_settled happened.
  assert.equal(probe.available, true);
});

test("smoke: full CLI daemon -> real pi worker -> real verifier (AC-03/04)", async (t) => {
  const probe = await probeCredentials();
  if (!probe.available) {
    if (process.env.BRIDGE_LIVE_TEST === "1") assert.fail(probe.reason);
    t.skip(`SKIP: 真实 pi 模型不可用 -> ${probe.reason}`);
    return;
  }
  const fx = createFixtureGitProject("smoke-e2e");
  const home = mkdtempSync(join(tmpdir(), "bridge-smoke-home-"));
  const env = { BRIDGE_HOME: home, BRIDGE_PI_CLI: probe.piCli! };
  let passed = false;

  try {
    const up = runCli(["up", "--json"], env);
    assert.equal(up.code, 0, `bridge up failed: ${up.stderr}`);
    try {
      const auth = runCli(["authorize", "--dir", fx.dir, "--json"], env);
      assert.equal(auth.code, 0, `authorize failed: ${auth.stderr}`);

      const taskFile = join(home, "task.json");
      writeFileSync(
        taskFile,
        JSON.stringify(
          {
            schemaVersion: "2.0",
            title: "create result file",
            workspace: fx.dir,
            mode: "economy",
            model: MODEL ? (PROVIDER ? `${PROVIDER}/${MODEL}` : MODEL) : undefined,
            objective: "Create the file src/result.txt with the single line 'done'. Do not modify any other file.",
            // Explicit trusted-host opt-in: whole workspace + write + network.
            // (The conservative default is offline and would be refused fail-closed.)
            policy: { allowWrite: true, allowNetwork: true, timeoutSeconds: SMOKE_SECONDS },
            acceptance: [
              {
                kind: "command",
                command: [process.execPath, "-e", "const fs=require('fs');process.exit(fs.readFileSync('src/result.txt','utf8').trim()==='done'?0:1)"],
                timeoutSeconds: 30,
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const del = runCli(["delegate", "--task-file", taskFile, "--wait", "--json"], env);
      // stdout must be pure JSON regardless of outcome
      const parsed = JSON.parse(del.stdout);
      assert.ok(parsed.handoff, `no handoff in output: ${del.stdout.slice(0, 400)}`);
      const handoff = parsed.handoff;

      // Honesty invariant: the reported status must match the real verifier evidence.
      const verifyResult = handoff.verification?.[0]?.result;
      assert.equal(handoff.status, "passed", JSON.stringify(handoff));
      assert.equal(handoff.verification?.[0]?.exitCode, 0);
      assert.equal(handoff.evidenceLevel, "verified", "handoff must carry real verifier evidence");
      if (handoff.status === "passed") {
        assert.equal(verifyResult, "pass");
        assert.equal(existsSync(join(fx.dir, "src", "result.txt")), true,
          "passed handoff must correspond to a real file change");
      } else {
        assert.equal(verifyResult, "fail", "non-passed status must reflect a failing verifier");
      }
      // exit code must be consistent with the handoff status
      if (handoff.status === "passed") assert.equal(del.code, 0);
      else assert.notEqual(del.code, 0);

      // daemon must still own a live worker after the short-lived CLI exited (AC-04)
      const doc = runCli(["doctor", "--json"], env);
      const docJson = JSON.parse(doc.stdout);
      assert.equal(docJson.daemonRunning, true);
      passed = true;
    } finally {
      const down = runCli(["down", "--json"], env);
      assert.equal(down.code, 0);
    }
  } finally {
    if (passed) {
      fx.cleanup();
      rmSync(home, { recursive: true, force: true });
    } else { t.diagnostic(`Failed smoke evidence retained: ${home}; workspace: ${fx.dir}`); }
  }
});
