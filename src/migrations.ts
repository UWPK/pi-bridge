/**
 * Database migrations (需求文档 §7.3).
 *
 * One array of ordered, idempotent DDL steps. Every statement uses named columns
 * (never `INSERT INTO x VALUES (...)` positional form) to avoid the V1.0 placeholder bug.
 * A JSON fallback store shares the same logical schema and applies the same versions.
 */

export interface Migration {
  version: number;
  name: string;
  sqlite: string[];
  json: string[]; // collections to initialize for the JSON fallback
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init_core_tables",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version INTEGER PRIMARY KEY,
         name TEXT NOT NULL,
         applied_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS tasks (
         id TEXT PRIMARY KEY,
         workspace TEXT NOT NULL,
         status TEXT NOT NULL,
         active_run_id TEXT,
         generation INTEGER NOT NULL DEFAULT 0,
         request_json TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS runs (
         id TEXT PRIMARY KEY,
         task_id TEXT NOT NULL,
         generation INTEGER NOT NULL,
         status TEXT NOT NULL,
         model TEXT NOT NULL,
         pi_session_path TEXT,
         started_at TEXT,
         finished_at TEXT,
         error_code TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS handoffs (
         id TEXT PRIMARY KEY,
         run_id TEXT NOT NULL,
         task_id TEXT NOT NULL,
         status TEXT NOT NULL,
         payload_json TEXT NOT NULL,
         created_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS artifacts (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id TEXT NOT NULL,
         kind TEXT NOT NULL,
         path TEXT NOT NULL,
         artifactKey TEXT NOT NULL,
         size_bytes INTEGER NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS policies (
         key TEXT PRIMARY KEY,
         value_json TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS model_usage (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run_id TEXT NOT NULL,
         source TEXT NOT NULL,
         input_tokens INTEGER,
         output_tokens INTEGER,
         reported_cost REAL,
         measurement TEXT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id)`,
      `CREATE INDEX IF NOT EXISTS idx_handoffs_run ON handoffs(run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id)`,
    ],
    json: ["schema_migrations", "tasks", "runs", "handoffs", "artifacts", "policies", "model_usage"],
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
