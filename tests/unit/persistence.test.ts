import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, SqliteStore, JsonStore, newId, artifactKey, type Store } from "../../src/persistence.js";
import { LATEST_VERSION } from "../../src/migrations.js";
import { PolicyStore } from "../../src/policies.js";
import type { TaskRecord, RunRecord } from "../../src/types.js";

function makeTask(over: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: over.id ?? newId("task"),
    workspace: over.workspace ?? "E:\\tmp\\proj",
    status: over.status ?? "pending",
    activeRunId: over.activeRunId ?? null,
    generation: over.generation ?? 0,
    requestJson: over.requestJson ?? "{}",
    createdAt: now,
    updatedAt: now,
  };
}

// Probe node:sqlite availability once (top-level await in ESM).
let DatabaseSyncCtor: (new (p: string) => unknown) | null = null;
try {
  const mod = (await import("node:sqlite")) as unknown as { DatabaseSync?: new (p: string) => unknown };
  DatabaseSyncCtor = mod.DatabaseSync ?? null;
} catch {
  DatabaseSyncCtor = null;
}

function wrapClose<T extends Store>(store: T, dir: string): T {
  const orig = store.close.bind(store);
  store.close = () => {
    orig();
    rmSync(dir, { recursive: true, force: true });
  };
  return store;
}

function sqliteStore(): Store {
  if (!DatabaseSyncCtor) throw new Error("node:sqlite unavailable");
  const dir = mkdtempSync(join(tmpdir(), "bridge-sql-"));
  return wrapClose(new SqliteStore(join(dir, "db.sqlite"), DatabaseSyncCtor as never), dir);
}

function jsonStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bridge-json-"));
  return wrapClose(new JsonStore(join(dir, "db.json")), dir);
}

function runSuite(name: string, make: () => Store) {
  test(`[${name}] migrate records the latest schema version (idempotent)`, () => {
    const store = make();
    const applied = store.migrate();
    assert.ok(applied.length >= 1);
    assert.equal(store.appliedVersions().includes(LATEST_VERSION), true);
    assert.equal(store.migrate().length, 0);
    store.close();
  });

  test(`[${name}] insert + read a task, and generation-guarded update`, () => {
    const store = make();
    store.migrate();
    const t = makeTask();
    store.insertTask(t);
    assert.equal(store.getTask(t.id)?.status, "pending");
    // stale write (wrong generation) must be rejected
    assert.equal(store.updateTaskStatusGuarded(t.id, "succeeded", null, 99, new Date().toISOString()), false);
    assert.equal(store.getTask(t.id)?.status, "pending");
    // correct write succeeds
    assert.equal(store.updateTaskStatusGuarded(t.id, "succeeded", null, 0, new Date().toISOString()), true);
    assert.equal(store.getTask(t.id)?.status, "succeeded");
    store.close();
  });

  test(`[${name}] claimRun flips to running atomically and is guarded by generation + status`, () => {
    const store = make();
    store.migrate();
    const t = makeTask(); // generation 0, status pending
    store.insertTask(t);
    assert.equal(store.claimRun(t.id, "run_1", 1, 0, ["pending"], new Date().toISOString()), true);
    const read = store.getTask(t.id);
    assert.equal(read?.activeRunId, "run_1");
    assert.equal(read?.generation, 1);
    assert.equal(read?.status, "running", "claim flips the task to running");
    // A stale/second claim (wrong expected generation OR ineligible status) is rejected.
    assert.equal(store.claimRun(t.id, "run_2", 2, 0, ["pending"], new Date().toISOString()), false);
    assert.equal(store.claimRun(t.id, "run_2", 2, 1, ["pending"], new Date().toISOString()), false, "status is running, not pending");
    assert.equal(store.getTask(t.id)?.activeRunId, "run_1");
    // Supersede path used by cancel: clear activeRunId, bump generation, set status.
    assert.equal(store.supersedeTask(t.id, 2, 1, "cancelled", new Date().toISOString()), true);
    assert.equal(store.getTask(t.id)?.activeRunId, null);
    assert.equal(store.getTask(t.id)?.generation, 2);
    assert.equal(store.getTask(t.id)?.status, "cancelled");
    // late guarded write from the superseded run/generation is rejected
    assert.equal(store.updateTaskStatusGuarded(t.id, "succeeded", "run_1", 1, new Date().toISOString()), false);
    store.close();
  });

  test(`[${name}] getTask returns a copy so external mutation cannot drift stored state`, () => {
    const store = make();
    store.migrate();
    const t = makeTask();
    store.insertTask(t);
    const a = store.getTask(t.id)!;
    a.generation = 999;
    a.status = "succeeded";
    const b = store.getTask(t.id)!;
    assert.equal(b.generation, 0, "stored generation is unchanged by mutating the returned copy");
    assert.equal(b.status, "pending");
    store.close();
  });

  test(`[${name}] runs, handoffs, artifacts, policies and usage persist`, () => {
    const store = make();
    store.migrate();
    const taskId = newId("task");
    store.insertTask(makeTask({ id: taskId }));
    const run: RunRecord = {
      id: newId("run"),
      taskId,
      generation: 1,
      status: "running",
      model: "fixture-provider/fixture-model",
      piSessionPath: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      errorCode: null,
    };
    store.insertRun(run);
    assert.equal(store.getRun(run.id)?.status, "running");
    run.status = "settled";
    run.finishedAt = new Date().toISOString();
    store.updateRun(run);
    assert.equal(store.getRun(run.id)?.status, "settled");
    assert.equal(store.listRuns(taskId).length, 1);

    store.insertHandoff({ id: newId("handoff"), runId: run.id, taskId, status: "passed", payloadJson: "{}", createdAt: new Date().toISOString() });
    assert.equal(store.getHandoffForRun(run.id)?.status, "passed");
    assert.equal(store.listHandoffs(taskId).length, 1);

    store.insertArtifact({ runId: run.id, kind: "verify_log", path: "x.log", artifactKey: artifactKey("x"), sizeBytes: 3 });
    assert.equal(store.listArtifacts(run.id).length, 1);

    store.setPolicy("k", JSON.stringify({ a: 1 }), new Date().toISOString());
    assert.equal(store.getPolicy("k")?.valueJson, JSON.stringify({ a: 1 }));
    store.setPolicy("k", JSON.stringify({ a: 2 }), new Date().toISOString());
    assert.equal(store.getPolicy("k")?.valueJson, JSON.stringify({ a: 2 }));

    store.insertModelUsage({ runId: run.id, source: "pi_rpc", inputTokens: 10, outputTokens: 5, reportedCost: 0.01, measurement: "provider_reported" });
    assert.equal(store.listModelUsage(run.id).length, 1);
    store.close();
  });
}

if (DatabaseSyncCtor) {
  runSuite("sqlite", sqliteStore);
} else {
  test("[sqlite] node:sqlite unavailable — fallback tested via json backend", () => {
    assert.equal(DatabaseSyncCtor, null);
  });
}
runSuite("json", jsonStore);

test("openStore returns a working backend and persists across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-open-"));
  const sqliteFile = join(dir, "db.sqlite");
  const jsonFile = join(dir, "db.json");
  const store = await openStore(sqliteFile, jsonFile);
  store.migrate();
  store.insertTask(makeTask({ id: "persist_task" }));
  const backend = store.backend;
  store.close();

  const reopened = await openStore(sqliteFile, jsonFile);
  reopened.migrate();
  assert.equal(reopened.getTask("persist_task")?.id, "persist_task", `backend=${backend}`);
  reopened.close();
  assert.ok(existsSync(sqliteFile) || existsSync(jsonFile));
  rmSync(dir, { recursive: true, force: true });
});

test("PolicyStore authorize/revoke round-trips through the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-pol-"));
  const store = await openStore(join(dir, "db.sqlite"), join(dir, "db.json"));
  store.migrate();
  const policies = new PolicyStore(store);
  const roots = policies.authorizeRoot(dir);
  assert.ok(roots.length >= 1);
  assert.equal(policies.isAuthorized(dir), true);
  const after = policies.revokeRoot(dir);
  assert.equal(after.length, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
