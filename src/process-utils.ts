import { spawn, type ChildProcess } from "node:child_process";

/**
 * Bounded, cross-platform process-tree termination.
 *
 * A "stop" that only signals the direct child is not enough: pi/bash/verify
 * commands spawn grandchildren (node -> node, npm -> node, python -> workers).
 * Leaving those alive lets a cancelled/timed-out run keep mutating the workspace
 * after the Bridge declared it stopped. So we always try to kill the whole tree
 * and, crucially, we WAIT (bounded) for it to actually be gone before returning.
 *
 * Termination is *provable* as follows:
 *   1. Windows: `taskkill /pid <pid> /T /F` exited 0 — the tree was found (by parent
 *      pid) and killed. This only works while the PARENT is still alive. On Windows
 *      the stdio `close` event fires as soon as the direct child exits regardless of
 *      orphaned grandchildren, so it is NOT used as a tree signal.
 *   2. POSIX: the detached process group (`kill(-pid)`) is gone AND our pipes closed.
 *
 * If confirmation cannot be produced we return FALSE (fail-closed) rather than claim
 * success. In particular, if the parent has already exited, Windows cannot enumerate
 * the (now reparented) descendants, so we report failure. This is host process
 * management, NOT a sandbox, and we do not claim otherwise.
 *
 *   - Windows: `taskkill /T /F` is run BEFORE the parent can exit on its own (see
 *     PiRpcProcess.stop, which no longer ends stdin first), while the tree is still
 *     walkable by parent pid.
 *   - POSIX:   the child is spawned `detached` so it leads a process group; we kill
 *     the whole group even when the parent has already exited.
 *
 * Nothing here spawns through a shell (`shell:false`), and we do not assume any
 * shell shim (e.g. `npm.cmd`) is directly spawnable.
 */

/** Spawn options that put the child in its own killable group on POSIX. */
export function groupedSpawnOptions(): { detached: boolean; windowsHide: boolean; shell: false } {
  return { detached: process.platform !== "win32", windowsHide: true, shell: false };
}

/**
 * Resolve true once all of the child's stdio pipes are closed (or it has none).
 * `close` fires only after `exit` AND every stdio stream is closed, which is why it
 * detects a descendant that inherited (and still holds) our pipes.
 */
export function waitClosed(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  const streams = [child.stdout, child.stderr].filter(
    (s): s is NonNullable<ChildProcess["stdout"]> => !!s,
  );
  const open = streams.filter((s) => !(s as unknown as { destroyed?: boolean }).destroyed);
  if (open.length === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let remaining = open.length;
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    for (const s of open) {
      s.once("close", () => {
        remaining -= 1;
        if (remaining <= 0) finish(true);
      });
    }
  });
}

export interface KillResult {
  attempted: boolean;
  /** taskkill exit code on Windows; 0 on POSIX when the group signal was delivered. */
  exitCode: number | null;
}

/** Kill the child's whole process tree. Awaits taskkill (Windows); bounded. */
export async function killTree(child: ChildProcess, killWaitMs = 10_000): Promise<KillResult> {
  const pid = child.pid;
  if (!pid) return { attempted: false, exitCode: null };
  if (process.platform === "win32") {
    return await new Promise<KillResult>((resolve) => {
      let done = false;
      const finish = (exitCode: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ attempted: true, exitCode });
      };
      const timer = setTimeout(() => finish(null), killWaitMs);
      let killer: ChildProcess;
      try {
        killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          shell: false,
          stdio: "ignore",
        });
      } catch {
        finish(null);
        return;
      }
      killer.on("exit", (code) => finish(code));
      killer.on("error", () => finish(null));
    });
  }
  // POSIX: kill the process group led by the detached child.
  let delivered = true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    delivered = false;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  return { attempted: true, exitCode: delivered ? 0 : null };
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm the child tree is gone. Returns true only when termination is provable
 * (see module docs). `killWaitMs` bounds both the kill and the confirmation wait.
 */
export async function terminateTree(child: ChildProcess, killWaitMs = 10_000): Promise<boolean> {
  const pid = child.pid;
  const alreadyExited = child.exitCode !== null || child.signalCode !== null;

  if (process.platform === "win32") {
    // taskkill /T walks the tree by parent pid; once the parent is gone the
    // descendants are reparented and cannot be enumerated -> unconfirmable.
    if (!pid || alreadyExited) return false;
    const kill = await killTree(child, killWaitMs);
    // Best-effort drain of the pipes (does not affect the confirmation decision).
    await waitClosed(child, Math.min(killWaitMs, 1000));
    return kill.exitCode === 0;
  }

  // POSIX: kill the group (works even if the parent already exited) and verify both
  // that the group is gone and our pipes are closed.
  if (!pid) return false;
  await killTree(child, killWaitMs);
  const closed = await waitClosed(child, killWaitMs);
  return closed && !groupAlive(pid);
}
