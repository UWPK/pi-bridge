/** Shared types for the bridge. Kept dependency-free so CLI, daemon and storage reuse one definition. */

export type TaskMode = "economy" | "standard" | "strict";

/** Task lifecycle (需求文档 §7.1). */
export type TaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "needs_review";

/** Execution fact for one run. */
export type ExecutionStatus =
  | "created"
  | "running"
  | "settled"
  | "failed"
  | "cancelled"
  | "timeout"
  | "interrupted";

/** Acceptance fact (independent of what the worker claimed). */
export type AcceptanceStatus = "not_run" | "pass" | "fail" | "blocked";

/** Final outward conclusion attached to a handoff. */
export type HandoffStatus = "passed" | "partial" | "failed" | "blocked";

export interface AcceptanceCommand {
  kind: "command";
  /** argv array; executed with shell:false (需求文档 §8.3). */
  command: string[];
  timeoutSeconds?: number;
}

export interface TaskPolicy {
  allowWrite: boolean;
  allowNetwork: boolean;
  requireCleanDiff: boolean;
  maxWorkerTurns: number;
  timeoutSeconds: number;
}

export interface TaskRequest {
  schemaVersion: string;
  taskId?: string;
  title: string;
  workspace: string;
  mode: TaskMode;
  model?: string;
  objective: string;
  scope?: string[];
  constraints?: string[];
  acceptance?: AcceptanceCommand[];
  stopConditions?: string[];
  policy?: Partial<TaskPolicy>;
}

// The conservative default contract is "offline" (allowNetwork:false) and is kept
// verbatim so we never silently widen permissions. The Bridge cannot *enforce*
// network/write isolation, so a task that still requests `allowNetwork:false` or
// `allowWrite:false` is refused up-front by the enforceability gate at run time
// (see policy-enforcement.ts). A trusted host must therefore opt IN explicitly by
// setting BOTH `allowWrite:true` and `allowNetwork:true` for a whole-workspace run.
export const DEFAULT_POLICY: TaskPolicy = {
  allowWrite: true,
  allowNetwork: false,
  requireCleanDiff: true,
  maxWorkerTurns: 24,
  timeoutSeconds: 900,
};

export interface TaskRecord {
  id: string;
  workspace: string;
  status: TaskStatus;
  activeRunId: string | null;
  generation: number;
  requestJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  taskId: string;
  generation: number;
  status: ExecutionStatus;
  model: string;
  piSessionPath: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
}

export interface ChangedFile {
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
}

export interface VerificationResult {
  command: string[];
  exitCode: number | null;
  result: AcceptanceStatus;
  logRef: string | null;
  timedOut: boolean;
}

export interface DiffSummary {
  files: number;
  insertions: number;
  deletions: number;
}

export interface Handoff {
  schemaVersion: string;
  taskId: string;
  runId: string;
  status: HandoffStatus;
  workerModel: string;
  summary: string;
  changedFiles: ChangedFile[];
  verification: VerificationResult[];
  diffSummary: DiffSummary;
  risks: string[];
  nextAction: string;
  rawLogRef: string | null;
  evidenceLevel: "verified" | "worker_claim_only" | "none";
}

export interface HandoffRecord {
  id: string;
  runId: string;
  taskId: string;
  status: HandoffStatus;
  payloadJson: string;
  createdAt: string;
}

export interface ArtifactRecord {
  id: number;
  runId: string;
  kind: string;
  path: string;
  artifactKey: string;
  sizeBytes: number;
}

export interface PolicyRecord {
  key: string;
  valueJson: string;
  updatedAt: string;
}

export interface ModelUsageRecord {
  id: number;
  runId: string;
  source: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedCost: number | null;
  measurement: string;
}

export interface MigrationRecord {
  version: number;
  appliedAt: string;
}

/** High level runtime config (see src/config.ts for loading/merging). */
export interface BridgeConfig {
  home: string;
  ipc: {
    host: string;
  };
  pi: {
    cliPath: string;
    nodePath: string;
    provider: string;
    model: string;
  };
  worker: {
    transport: "auto" | "jsonl" | "rpc-client";
    startupTimeoutMs: number;
    turnTimeoutMs: number;
    abortGraceMs: number;
  };
  limits: {
    maxWorkerTurns: number;
    verifyTimeoutSeconds: number;
    runTimeoutSeconds: number;
    summaryMaxTokens: number;
    summaryMaxChars: number;
    maxRunLogBytes: number;
    /** Bounded wait to confirm a verifier process tree terminated before failing closed. */
    verifyTerminateWaitMs: number;
  };
}
