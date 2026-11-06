/**
 * Local, dependency-free mirror of pi's JSON session-event shapes
 * (docs/json.md). We intentionally do NOT import the pi package's types at
 * runtime so the bridge keeps a minimal dependency surface; the wire contract is
 * documented and stable, and integration/smoke tests exercise the real process.
 *
 * Only the record families the bridge consumes are modelled; unknown event types
 * are tolerated (forward-compatible) rather than rejected.
 */

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

export interface AssistantMessageEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
  content?: string;
  reason?: string;
  error?: string;
}

export interface MessageUpdateEvent {
  type: "message_update";
  usage?: Usage;
  assistantMessageEvent: AssistantMessageEvent;
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args?: unknown;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
}

export interface AgentSettledEvent {
  type: "agent_settled";
  aborted: boolean;
}

export interface AgentEndEvent {
  type: "agent_end";
  messages?: unknown[];
  willRetry?: boolean;
}

export interface MessageStartEvent {
  type: "message_start";
  message?: Record<string, unknown>;
}

export interface MessageEndEvent {
  type: "message_end";
  message?: Record<string, unknown>;
}

export interface TurnStartEvent {
  type: "turn_start";
}
export interface TurnEndEvent {
  type: "turn_end";
  message?: Record<string, unknown>;
  toolResults?: unknown[];
}

export interface BashExecutionUpdateEvent {
  type: "bash_execution_update";
  id?: string;
  delta: string;
}

export interface AutoRetryStartEvent {
  type: "auto_retry_start";
  attempt: number;
  maxAttempts: number;
  errorMessage?: string;
}

export interface AutoRetryEndEvent {
  type: "auto_retry_end";
  success: boolean;
  attempt: number;
  finalError?: string;
}

export interface CompactionStartEvent {
  type: "compaction_start";
  reason: string;
}
export interface CompactionEndEvent {
  type: "compaction_end";
  reason: string;
  aborted?: boolean;
  willRetry?: boolean;
  errorMessage?: string;
}

export interface ExtensionErrorEvent {
  type: "extension_error";
  extensionPath: string;
  event: string;
  error: string;
}

/** Union of the documented event shapes we interact with, plus a permissive fallback. */
export type JsonAgentSessionEvent =
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionEndEvent
  | AgentSettledEvent
  | AgentEndEvent
  | MessageStartEvent
  | MessageEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | BashExecutionUpdateEvent
  | AutoRetryStartEvent
  | AutoRetryEndEvent
  | CompactionStartEvent
  | CompactionEndEvent
  | ExtensionErrorEvent
  | { type: string; [k: string]: unknown };
