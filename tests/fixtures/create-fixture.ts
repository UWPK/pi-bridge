import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Creates a throwaway Git fixture project for integration/smoke tests.
 * Caller must invoke `cleanup()`.
 */
export interface Fixture {
  dir: string;
  cleanup: () => void;
}

export function createFixtureGitProject(name = "fixture"): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `bridge-${name}-`));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.txt"), "v1\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# fixture\n", "utf8");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "bridge@test.local");
  git("config", "user.name", "Bridge Test");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A trivial verifying command that always succeeds. */
export function passCommand(): string[] {
  return [process.execPath, "-e", "process.exit(0)"];
}

/** A trivial verifying command that always fails with a nonzero exit code. */
export function failCommand(): string[] {
  return [process.execPath, "-e", "process.exit(3)"];
}

/** A command that writes a file into cwd (used to prove real side effects). */
export function writeFileCommand(rel: string, content: string): string[] {
  return [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(rel)}, ${JSON.stringify(content)})`];
}

/**
 * A command whose *grandchild* writes a marker file after `delayMs`, while the direct
 * child stays alive for `parentAliveMs`. Used to prove process-TREE termination: if
 * only the parent were killed, the grandchild would still write the marker.
 */
export function treeMarkerCommand(markerAbsPath: string, delayMs: number, parentAliveMs = 60_000): string[] {
  const grandchild = `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(markerAbsPath)}, 'leaked'), ${delayMs})`;
  const parent = [
    "const cp=require('child_process');",
    `cp.spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});`,
    `setTimeout(()=>{}, ${parentAliveMs});`,
  ].join("");
  return [process.execPath, "-e", parent];
}
