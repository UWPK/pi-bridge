import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AcceptanceCommand, VerificationResult, AcceptanceStatus } from "./types.js";
import { redactText } from "./redact.js";
import { groupedSpawnOptions, terminateTree, waitClosed } from "./process-utils.js";
import { BridgeError, ExitCode } from "./errors.js";

/**
 * Real verification runner (需求文档 §8.3, §10.1 AC-06).
 *
 * Commands come from the (user-authorized) task `acceptance` array, run as an argv
 * array with `shell:false`, an explicit cwd, and a per-command timeout. We record the
 * actual exit code and a redacted log file; we never upgrade a worker-suggested command
 * into a privileged verifier command.
 *
 * Termination discipline (P0):
 *   - A caller AbortSignal (run cancel/timeout) stops verification immediately: the
 *     in-flight command's whole process tree is killed and no further command runs.
 *   - On timeout we kill the process TREE, not just the direct child, so a verifier
 *     that spawns helpers cannot keep mutating the workspace after the deadline.
 *   - We never fabricate a pass: an aborted/timed-out command is recorded as `fail`.
 */

export interface VerifierOptions {
  workspace: string;
  logDir: string;
  defaultTimeoutSeconds: number;
  maxLogBytes: number;
  env?: NodeJS.ProcessEnv;
  /** Abort verification (and its process tree) when the parent run is cancelled/timed out. */
  signal?: AbortSignal;
  /** Bounded wait to confirm a killed command's process tree is gone (default 8000ms). */
  terminateWaitMs?: number;
}

export interface VerificationBundle {
  results: VerificationResult[];
  acceptance: AcceptanceStatus;
}

export async function runVerifier(
  commands: AcceptanceCommand[],
  opts: VerifierOptions,
): Promise<VerificationBundle> {
  if (commands.length === 0) {
    return { results: [], acceptance: "not_run" };
  }
  if (!existsSync(opts.logDir)) mkdirSync(opts.logDir, { recursive: true });

  const results: VerificationResult[] = [];
  let anyFail = false;
  let aborted = false;

  for (let i = 0; i < commands.length; i++) {
    // Stop before starting another command once the run has been aborted.
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    const cmd = commands[i];
    const timeoutMs = (cmd.timeoutSeconds ?? opts.defaultTimeoutSeconds) * 1000;
    const logName = `verify-${i + 1}-${randomUUID().slice(0, 8)}.log`;
    const logPath = join(opts.logDir, logName);
    const outcome = await runOne(cmd.command, opts.workspace, timeoutMs, opts.maxLogBytes, opts.env, opts.signal, opts.terminateWaitMs ?? 8000);

    // A command whose process tree could not be proven terminated must fail closed:
    // we refuse to report a result and tell the engine to block further work.
    if (outcome.terminationFailed) {
      throw new BridgeError(
        ExitCode.UNAVAILABLE,
        `verifier 命令进程树未能确认终止（pid=${outcome.pid ?? "?"}）；为避免残留副作用，已阻止后续运行。`,
      );
    }

    let logRef: string | null = null;
    if (outcome.ok) {
      const header =
        `$ ${cmd.command.join(" ")}\n` +
        `exitCode=${outcome.exitCode} timedOut=${outcome.timedOut} aborted=${outcome.aborted}\n` +
        `--- stdout ---\n`;
      const body = `${header}${outcome.stdout}\n--- stderr ---\n${outcome.stderr}\n`;
      writeFileSync(logPath, redactText(body).slice(0, opts.maxLogBytes * 2), "utf8");
      logRef = logPath;
    }

    const failed = !outcome.ok || outcome.timedOut || outcome.aborted || outcome.exitCode !== 0;
    if (failed) anyFail = true;
    const result: AcceptanceStatus = failed ? "fail" : "pass";

    results.push({
      command: cmd.command,
      exitCode: outcome.ok ? outcome.exitCode : null,
      result,
      logRef,
      timedOut: outcome.ok ? outcome.timedOut || outcome.aborted : false,
    });

    if (outcome.aborted) {
      aborted = true;
      break;
    }
  }

  if (aborted) anyFail = true;
  return { results, acceptance: anyFail ? "fail" : "pass" };
}

interface Outcome {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  terminationFailed: boolean;
  pid: number | null;
  stdout: string;
  stderr: string;
}

function runOne(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  maxBytes: number,
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal | undefined,
  terminateWaitMs: number,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let spawnFailed = false;
    let terminationFailed = false;
    let terminating = false;
    let termination: Promise<void> | null = null;

    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        ...groupedSpawnOptions(),
      });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        aborted: false,
        terminationFailed: false,
        pid: null,
        stdout: "",
        stderr: (err as Error).message,
      });
      return;
    }
    const pid = child.pid ?? null;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok: !spawnFailed, exitCode: code ?? null, timedOut, aborted, terminationFailed, pid, stdout, stderr });
    };

    // On timeout/abort we MUST await provable termination before resolving; if the
    // tree cannot be confirmed gone, flag it so the caller fails closed. A single
    // in-flight termination is shared by the timer and the abort signal.
    const beginTermination = (): Promise<void> => {
      if (termination) return termination;
      terminating = true;
      termination = (async () => {
        const confirmed = await terminateTree(child, terminateWaitMs);
        await waitClosed(child, terminateWaitMs);
        if (!confirmed) terminationFailed = true;
        finish(child.exitCode);
      })();
      return termination;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      void beginTermination();
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      void beginTermination();
    };
    if (signal) {
      if (signal.aborted) {
        aborted = true;
        void beginTermination();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < maxBytes) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < maxBytes) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      spawnFailed = true;
      stderr += (stderr ? "\n" : "") + err.message;
      finish(null);
    });
    // A natural close (all pipes closed) only resolves the command if we are NOT in
    // the middle of a termination; when terminating, beginTermination owns the result.
    child.on("close", (code) => {
      if (terminating) return;
      finish(code);
    });
  });
}
