import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  TaskRecord,
  RunRecord,
  HandoffRecord,
  ArtifactRecord,
  PolicyRecord,
  ModelUsageRecord,
  MigrationRecord,
  TaskStatus,
  ExecutionStatus,
  HandoffStatus,
} from "./types.js";
import { MIGRATIONS, LATEST_VERSION } from "./migrations.js";

/**
 * Persistence with two interchangeable backends sharing one logical schema
 * (需求文档 §3.2, §7.3, §11):
 *   - SqliteStore: Node 24 built-in `node:sqlite` (no native third-party compile).
 *   - JsonStore:   atomic JSON file fallback when node:sqlite is unavailable.
 *
 * The generation-guarded status write is the anti-late-write primitive (§7.2).
 */
export interface Store {
  readonly backend: "sqlite" | "json";
  migrate(): MigrationRecord[];
  appliedVersions(): number[];

  insertTask(rec: TaskRecord): void;
  /** Returns a defensive copy so callers cannot mutate stored state by reference. */
  getTask(id: string): TaskRecord | null;
  listTasks(): TaskRecord[];
  /**
   * Atomically claim a task for a new run, guarded by the expected previous
   * generation AND an eligible status set. On success the task is set to
   * `running` and pointed at `activeRunId` in the same update (§7.2).
   */
  claimRun(
    id: string,
    activeRunId: string,
    generation: number,
    expectedGeneration: number,
    eligibleStatuses: TaskStatus[],
    updatedAt: string,
  ): boolean;
  /**
   * Atomically supersede a task's generation (bump it), clear `activeRunId` and set
   * a new status — used by cancel/interrupt so any late write from the old run fails
   * its guard. Guarded by the expected previous generation.
   */
  supersedeTask(
    id: string,
    generation: number,
    expectedGeneration: number,
    status: TaskStatus,
    updatedAt: string,
  ): boolean;
  updateTaskStatusGuarded(
    id: string,
    status: TaskStatus,
    activeRunId: string | null,
    generation: number,
    updatedAt: string,
  ): boolean;

  insertRun(rec: RunRecord): void;
  getRun(id: string): RunRecord | null;
  listRuns(taskId: string): RunRecord[];
  updateRun(rec: RunRecord): void;

  insertHandoff(rec: HandoffRecord): void;
  getHandoffForRun(runId: string): HandoffRecord | null;
  listHandoffs(taskId: string): HandoffRecord[];

  insertArtifact(rec: Omit<ArtifactRecord, "id">): void;
  listArtifacts(runId: string): ArtifactRecord[];

  setPolicy(key: string, valueJson: string, updatedAt: string): void;
  getPolicy(key: string): PolicyRecord | null;
  listPolicies(): PolicyRecord[];

  insertModelUsage(rec: Omit<ModelUsageRecord, "id">): void;
  listModelUsage(runId: string): ModelUsageRecord[];

  close(): void;
}

export function artifactKey(text: string): string {
  return randomUUID();
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

/* ------------------------------------------------------------------ */
/* SQLite backend                                                      */
/* ------------------------------------------------------------------ */

interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
}

interface StatementSyncLike {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export class SqliteStore implements Store {
  readonly backend = "sqlite" as const;
  private db: DatabaseSyncLike;

  constructor(file: string, DatabaseCtor: new (path: string) => DatabaseSyncLike) {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseCtor(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  migrate(): MigrationRecord[] {
    const applied: MigrationRecord[] = [];
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
    );
    const done = new Set(
      (this.db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      this.db.exec("BEGIN");
      try {
        for (const stmt of m.sqlite) this.db.exec(stmt);
        this.db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(m.version, m.name, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
      applied.push({ version: m.version, appliedAt: new Date().toISOString() });
    }
    return applied;
  }

  appliedVersions(): number[] {
    const rows = this.db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
    }>;
    return rows.map((r) => r.version);
  }

  insertTask(r: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, workspace, status, active_run_id, generation, request_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.workspace, r.status, r.activeRunId, r.generation, r.requestJson, r.createdAt, r.updatedAt);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, workspace, status, active_run_id AS activeRunId, generation, request_json AS requestJson, created_at AS createdAt, updated_at AS updatedAt
         FROM tasks WHERE id = ?`,
      )
      .get(id);
    return (row as TaskRecord | undefined) ?? null;
  }

  listTasks(): TaskRecord[] {
    return this.db
      .prepare(
        `SELECT id, workspace, status, active_run_id AS activeRunId, generation, request_json AS requestJson, created_at AS createdAt, updated_at AS updatedAt
         FROM tasks ORDER BY created_at DESC`,
      )
      .all() as TaskRecord[];
  }

  claimRun(
    id: string,
    activeRunId: string,
    generation: number,
    expectedGeneration: number,
    eligibleStatuses: TaskStatus[],
    updatedAt: string,
  ): boolean {
    if (eligibleStatuses.length === 0) return false;
    const placeholders = eligibleStatuses.map(() => "?").join(", ");
    const res = this.db
      .prepare(
        `UPDATE tasks SET active_run_id = ?, generation = ?, status = 'running', updated_at = ?
         WHERE id = ? AND generation = ? AND status IN (${placeholders})`,
      )
      .run(activeRunId, generation, updatedAt, id, expectedGeneration, ...eligibleStatuses) as { changes?: number };
    return (res?.changes ?? 0) > 0;
  }

  supersedeTask(
    id: string,
    generation: number,
    expectedGeneration: number,
    status: TaskStatus,
    updatedAt: string,
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks SET active_run_id = NULL, generation = ?, status = ?, updated_at = ?
         WHERE id = ? AND generation = ?`,
      )
      .run(generation, status, updatedAt, id, expectedGeneration) as { changes?: number };
    return (res?.changes ?? 0) > 0;
  }

  updateTaskStatusGuarded(
    id: string,
    status: TaskStatus,
    activeRunId: string | null,
    generation: number,
    updatedAt: string,
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE tasks
         SET status = ?, updated_at = ?
         WHERE id = ? AND active_run_id IS ? AND generation = ?`,
      )
      .run(status, updatedAt, id, activeRunId, generation) as { changes?: number };
    return (res?.changes ?? 0) > 0;
  }

  insertRun(r: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, generation, status, model, pi_session_path, started_at, finished_at, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.taskId, r.generation, r.status, r.model, r.piSessionPath, r.startedAt, r.finishedAt, r.errorCode);
  }

  getRun(id: string): RunRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id AS taskId, generation, status, model, pi_session_path AS piSessionPath, started_at AS startedAt, finished_at AS finishedAt, error_code AS errorCode
         FROM runs WHERE id = ?`,
      )
      .get(id);
    return (row as RunRecord | undefined) ?? null;
  }

  listRuns(taskId: string): RunRecord[] {
    return this.db
      .prepare(
        `SELECT id, task_id AS taskId, generation, status, model, pi_session_path AS piSessionPath, started_at AS startedAt, finished_at AS finishedAt, error_code AS errorCode
         FROM runs WHERE task_id = ? ORDER BY started_at ASC`,
      )
      .all(taskId) as RunRecord[];
  }

  updateRun(r: RunRecord): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, pi_session_path = ?, started_at = ?, finished_at = ?, error_code = ? WHERE id = ?`,
      )
      .run(r.status, r.piSessionPath, r.startedAt, r.finishedAt, r.errorCode, r.id);
  }

  insertHandoff(r: HandoffRecord): void {
    this.db
      .prepare(
        `INSERT INTO handoffs (id, run_id, task_id, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.runId, r.taskId, r.status, r.payloadJson, r.createdAt);
  }

  getHandoffForRun(runId: string): HandoffRecord | null {
    const row = this.db
      .prepare(
        `SELECT id, run_id AS runId, task_id AS taskId, status, payload_json AS payloadJson, created_at AS createdAt
         FROM handoffs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(runId);
    return (row as HandoffRecord | undefined) ?? null;
  }

  listHandoffs(taskId: string): HandoffRecord[] {
    return this.db
      .prepare(
        `SELECT id, run_id AS runId, task_id AS taskId, status, payload_json AS payloadJson, created_at AS createdAt
         FROM handoffs WHERE task_id = ? ORDER BY created_at ASC`,
      )
      .all(taskId) as HandoffRecord[];
  }

  insertArtifact(r: Omit<ArtifactRecord, "id">): void {
    this.db
      .prepare(`INSERT INTO artifacts (run_id, kind, path, artifactKey, size_bytes) VALUES (?, ?, ?, ?, ?)`)
      .run(r.runId, r.kind, r.path, r.artifactKey, r.sizeBytes);
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return this.db
      .prepare(`SELECT id, run_id AS runId, kind, path, artifactKey, size_bytes AS sizeBytes FROM artifacts WHERE run_id = ? ORDER BY id ASC`)
      .all(runId) as ArtifactRecord[];
  }

  setPolicy(key: string, valueJson: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO policies (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(key, valueJson, updatedAt);
  }

  getPolicy(key: string): PolicyRecord | null {
    const row = this.db
      .prepare(`SELECT key, value_json AS valueJson, updated_at AS updatedAt FROM policies WHERE key = ?`)
      .get(key);
    return (row as PolicyRecord | undefined) ?? null;
  }

  listPolicies(): PolicyRecord[] {
    return this.db
      .prepare(`SELECT key, value_json AS valueJson, updated_at AS updatedAt FROM policies ORDER BY key`)
      .all() as PolicyRecord[];
  }

  insertModelUsage(r: Omit<ModelUsageRecord, "id">): void {
    this.db
      .prepare(
        `INSERT INTO model_usage (run_id, source, input_tokens, output_tokens, reported_cost, measurement) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(r.runId, r.source, r.inputTokens, r.outputTokens, r.reportedCost, r.measurement);
  }

  listModelUsage(runId: string): ModelUsageRecord[] {
    return this.db
      .prepare(
        `SELECT id, run_id AS runId, source, input_tokens AS inputTokens, output_tokens AS outputTokens, reported_cost AS reportedCost, measurement
         FROM model_usage WHERE run_id = ? ORDER BY id ASC`,
      )
      .all(runId) as ModelUsageRecord[];
  }

  close(): void {
    this.db.close();
  }
}

/* ------------------------------------------------------------------ */
/* JSON fallback backend                                               */
/* ------------------------------------------------------------------ */

interface JsonShape {
  schema_migrations: MigrationRecord[];
  tasks: TaskRecord[];
  runs: RunRecord[];
  handoffs: HandoffRecord[];
  artifacts: Array<ArtifactRecord>;
  policies: PolicyRecord[];
  model_usage: Array<ModelUsageRecord>;
}

function emptyJson(): JsonShape {
  return {
    schema_migrations: [],
    tasks: [],
    runs: [],
    handoffs: [],
    artifacts: [],
    policies: [],
    model_usage: [],
  };
}

export class JsonStore implements Store {
  readonly backend = "json" as const;
  private file: string;
  private data: JsonShape;

  constructor(file: string) {
    this.file = file;
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        this.data = { ...emptyJson(), ...(JSON.parse(readFileSync(file, "utf8")) as JsonShape) };
      } catch {
        this.data = emptyJson();
      }
    } else {
      this.data = emptyJson();
    }
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.file);
  }

  migrate(): MigrationRecord[] {
    const done = new Set(this.data.schema_migrations.map((m) => m.version));
    const applied: MigrationRecord[] = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      for (const coll of m.json) {
        if (!Array.isArray((this.data as unknown as Record<string, unknown>)[coll])) {
          (this.data as unknown as Record<string, unknown[]>)[coll] = [];
        }
      }
      const rec = { version: m.version, appliedAt: new Date().toISOString() };
      this.data.schema_migrations.push(rec);
      applied.push(rec);
    }
    this.persist();
    return applied;
  }

  appliedVersions(): number[] {
    return this.data.schema_migrations.map((m) => m.version).sort((a, b) => a - b);
  }

  insertTask(r: TaskRecord): void {
    this.data.tasks.push({ ...r });
    this.persist();
  }

  getTask(id: string): TaskRecord | null {
    const t = this.data.tasks.find((x) => x.id === id);
    return t ? { ...t } : null;
  }

  listTasks(): TaskRecord[] {
    return [...this.data.tasks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((t) => ({ ...t }));
  }

  claimRun(
    id: string,
    activeRunId: string,
    generation: number,
    expectedGeneration: number,
    eligibleStatuses: TaskStatus[],
    updatedAt: string,
  ): boolean {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (t.generation !== expectedGeneration) return false;
    if (!eligibleStatuses.includes(t.status)) return false;
    t.activeRunId = activeRunId;
    t.generation = generation;
    t.status = "running";
    t.updatedAt = updatedAt;
    this.persist();
    return true;
  }

  supersedeTask(
    id: string,
    generation: number,
    expectedGeneration: number,
    status: TaskStatus,
    updatedAt: string,
  ): boolean {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (t.generation !== expectedGeneration) return false;
    t.activeRunId = null;
    t.generation = generation;
    t.status = status;
    t.updatedAt = updatedAt;
    this.persist();
    return true;
  }

  updateTaskStatusGuarded(
    id: string,
    status: TaskStatus,
    activeRunId: string | null,
    generation: number,
    updatedAt: string,
  ): boolean {
    const t = this.data.tasks.find((x) => x.id === id);
    if (!t) return false;
    if (t.activeRunId !== activeRunId || t.generation !== generation) return false;
    t.status = status;
    t.updatedAt = updatedAt;
    this.persist();
    return true;
  }

  insertRun(r: RunRecord): void {
    this.data.runs.push({ ...r });
    this.persist();
  }

  getRun(id: string): RunRecord | null {
    const r = this.data.runs.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  listRuns(taskId: string): RunRecord[] {
    return this.data.runs
      .filter((r) => r.taskId === taskId)
      .sort((a, b) => ((a.startedAt ?? "") < (b.startedAt ?? "") ? -1 : 1))
      .map((r) => ({ ...r }));
  }

  updateRun(r: RunRecord): void {
    const idx = this.data.runs.findIndex((x) => x.id === r.id);
    if (idx >= 0) this.data.runs[idx] = { ...r };
    this.persist();
  }

  insertHandoff(r: HandoffRecord): void {
    this.data.handoffs.push({ ...r });
    this.persist();
  }

  getHandoffForRun(runId: string): HandoffRecord | null {
    const list = this.data.handoffs.filter((h) => h.runId === runId);
    return list.length ? list[list.length - 1] : null;
  }

  listHandoffs(taskId: string): HandoffRecord[] {
    return this.data.handoffs.filter((h) => h.taskId === taskId);
  }

  insertArtifact(r: Omit<ArtifactRecord, "id">): void {
    const id = this.data.artifacts.length ? Math.max(...this.data.artifacts.map((a) => a.id)) + 1 : 1;
    this.data.artifacts.push({ id, ...r });
    this.persist();
  }

  listArtifacts(runId: string): ArtifactRecord[] {
    return this.data.artifacts.filter((a) => a.runId === runId);
  }

  setPolicy(key: string, valueJson: string, updatedAt: string): void {
    const idx = this.data.policies.findIndex((p) => p.key === key);
    if (idx >= 0) this.data.policies[idx] = { key, valueJson, updatedAt };
    else this.data.policies.push({ key, valueJson, updatedAt });
    this.persist();
  }

  getPolicy(key: string): PolicyRecord | null {
    return this.data.policies.find((p) => p.key === key) ?? null;
  }

  listPolicies(): PolicyRecord[] {
    return [...this.data.policies].sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  insertModelUsage(r: Omit<ModelUsageRecord, "id">): void {
    const id = this.data.model_usage.length ? Math.max(...this.data.model_usage.map((a) => a.id)) + 1 : 1;
    this.data.model_usage.push({ id, ...r });
    this.persist();
  }

  listModelUsage(runId: string): ModelUsageRecord[] {
    return this.data.model_usage.filter((u) => u.runId === runId);
  }

  close(): void {
    this.persist();
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

let sqliteModuleChecked = false;
let sqliteCtor: (new (path: string) => DatabaseSyncLike) | null = null;

async function getSqliteCtor(): Promise<(new (path: string) => DatabaseSyncLike) | null> {
  if (sqliteModuleChecked) return sqliteCtor;
  sqliteModuleChecked = true;
  try {
    const mod = (await import("node:sqlite")) as unknown as { DatabaseSync?: new (path: string) => DatabaseSyncLike };
    if (mod.DatabaseSync) sqliteCtor = mod.DatabaseSync;
  } catch {
    sqliteCtor = null;
  }
  return sqliteCtor;
}

/** Open the best available store. Prefers node:sqlite; falls back to atomic JSON. */
export async function openStore(sqliteFile: string, jsonFile: string): Promise<Store> {
  const ctor = await getSqliteCtor();
  if (ctor) {
    try {
      return new SqliteStore(sqliteFile, ctor);
    } catch {
      // fall through to JSON
    }
  }
  return new JsonStore(jsonFile);
}

export { LATEST_VERSION };
