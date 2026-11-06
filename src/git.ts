import { execFileSync } from "node:child_process";
import type { ChangedFile, DiffSummary } from "./types.js";

/**
 * Git evidence collection (需求文档 §6.2 step 7, §10.1 AC-03).
 * All git calls use argv arrays (no shell), an explicit cwd, and tolerate no-repo.
 */

export interface GitStatus {
  isRepo: boolean;
  clean: boolean;
  porcelain: string;
}

export function isGitRepo(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, windowsHide: true, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function gitStatus(cwd: string): GitStatus {
  if (!isGitRepo(cwd)) return { isRepo: false, clean: false, porcelain: "" };
  try {
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd, windowsHide: true, encoding: "utf8" });
    return { isRepo: true, clean: porcelain.trim() === "", porcelain };
  } catch {
    return { isRepo: true, clean: false, porcelain: "" };
  }
}

export interface GitDiff {
  changedFiles: ChangedFile[];
  summary: DiffSummary;
  patch: string;
}

/** Collect working-tree changes vs HEAD, including untracked files. */
export function gitDiff(cwd: string, maxPatchChars = 200_000): GitDiff {
  if (!isGitRepo(cwd)) {
    return { changedFiles: [], summary: { files: 0, insertions: 0, deletions: 0 }, patch: "" };
  }
  const changedFiles: ChangedFile[] = [];
  try {
    const nameStatus = execFileSync("git", ["status", "--porcelain"], { cwd, windowsHide: true, encoding: "utf8" });
    for (const line of nameStatus.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const code = line.slice(0, 2);
      let path = line.slice(3).trim();
      if (path.includes(" -> ")) path = path.split(" -> ")[1].trim();
      path = path.replace(/^"(.*)"$/, "$1");
      changedFiles.push({ path, change: classify(code) });
    }
  } catch {
    /* ignore */
  }

  let insertions = 0;
  let deletions = 0;
  try {
    const numstat = execFileSync("git", ["diff", "--numstat", "HEAD"], { cwd, windowsHide: true, encoding: "utf8" });
    for (const line of numstat.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [ins, del] = line.split("\t");
      if (ins !== "-") insertions += Number(ins) || 0;
      if (del !== "-") deletions += Number(del) || 0;
    }
  } catch {
    /* no HEAD yet, or no diff */
  }

  let patch = "";
  try {
    patch = execFileSync("git", ["diff", "HEAD"], { cwd, windowsHide: true, encoding: "utf8" }).slice(0, maxPatchChars);
  } catch {
    /* ignore */
  }

  return {
    changedFiles,
    summary: { files: changedFiles.length, insertions, deletions },
    patch,
  };
}

function classify(code: string): ChangedFile["change"] {
  if (code.includes("A") || code === "??") return "added";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  return "modified";
}
