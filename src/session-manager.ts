import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Session isolation (需求文档 §3.3, §6.2).
 *
 * Rules:
 *   - Same task + same cwd + same model  -> reuse the persisted session (continue).
 *   - New task, same cwd/model          -> call RPC `new_session`.
 *   - Different cwd or model            -> different process (cwd is fixed at spawn).
 *
 * The supervisor owns *when* a session is (re)created; this class only records the
 * mapping in memory for one daemon lifetime plus a small persisted index.
 */
export interface SessionBinding {
  taskId: string;
  workspace: string;
  model: string;
  sessionPath: string | null;
}

export class SessionManager {
  private byTask = new Map<string, SessionBinding>();
  private readonly sessionsDir: string;

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
  }

  /** Per-workspace session directory so pi groups session files by project. */
  dirFor(workspace: string): string {
    const safe = workspace.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "default";
    const dir = join(this.sessionsDir, safe);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  get(taskId: string): SessionBinding | undefined {
    return this.byTask.get(taskId);
  }

  set(binding: SessionBinding): void {
    this.byTask.set(binding.taskId, binding);
  }

  clear(taskId: string): void {
    this.byTask.delete(taskId);
  }

  /** True when the stored binding can be continued in the same process/workspace/model. */
  canContinue(taskId: string, workspace: string, model: string): boolean {
    const b = this.byTask.get(taskId);
    return !!b && b.workspace === workspace && b.model === model && !!b.sessionPath;
  }
}
