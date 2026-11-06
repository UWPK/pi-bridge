/**
 * Process exit codes (see 需求文档 §5.1) and a typed error that carries one.
 *
 *   0  success
 *   1  task execution / verification failed
 *   2  argument or JSON schema error
 *   3  local bridge limit / queue limit
 *   4  model, pi process or RPC unavailable
 *   5  directory not authorized / path out of bounds
 *   6  cancelled, timed out, or human intervention required
 */
export const ExitCode = {
  OK: 0,
  TASK_FAILED: 1,
  BAD_REQUEST: 2,
  LIMIT: 3,
  UNAVAILABLE: 4,
  UNAUTHORIZED: 5,
  ABORTED: 6,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class BridgeError extends Error {
  readonly code: ExitCodeValue;
  readonly details: unknown;

  constructor(code: ExitCodeValue, message: string, details?: unknown) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

export function isBridgeError(value: unknown): value is BridgeError {
  return value instanceof BridgeError;
}
