#!/usr/bin/env node
import { runDaemonMain } from "./daemon.js";
import { BridgeError } from "./errors.js";
import { redactText } from "./redact.js";

/**
 * Detached daemon entrypoint. Spawned by `bridge up`; not intended for direct use.
 */
runDaemonMain().catch((err) => {
  const msg = err instanceof BridgeError ? `[daemon] 启动失败(${err.code}): ${err.message}` : `[daemon] ${(err as Error).stack ?? String(err)}`;
  process.stderr.write(redactText(msg) + "\n");
  process.exit(err instanceof BridgeError ? err.code : 1);
});
