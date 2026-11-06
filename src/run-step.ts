import { spawn } from "node:child_process";

/**
 * Run a child process for `bridge check`.
 *
 * The child writes to stdout/stderr. When `inherit` is true its stdio is shared with
 * ours (interactive). When false we MUST consume the pipes: a child that fills the OS
 * pipe buffer (~64KB) would otherwise block forever waiting for a reader, deadlocking
 * `check --json`. Flow the streams to discard (bounded memory), and resolve with the
 * exit code.
 */
export function runStep(cmd: string[], cwd: string, inherit: boolean): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd[0], cmd.slice(1), {
        cwd,
        stdio: inherit ? "inherit" : "pipe",
        windowsHide: true,
      });
    } catch {
      resolve(1);
      return;
    }
    if (!inherit) {
      // Flowing without a 'data' listener discards the data and prevents backpressure.
      child.stdout?.resume();
      child.stderr?.resume();
    }
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}
