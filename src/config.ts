import { piWorkerArgs } from "./worker-profile.js";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, isAbsolute, resolve, dirname, delimiter } from "node:path";
import { existsSync, realpathSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { BridgeConfig } from "./types.js";
import { BridgeError, ExitCode } from "./errors.js";

/**
 * Locate the real, absolute pi CLI entrypoint.
 *
 * We must NOT assume a bare `pi` command resolves, nor a default relative path
 * (需求文档 §1.2, §6.1). Resolution order:
 *   1. explicit BRIDGE_PI_CLI / config pi.cliPath
 *   2. `npm root -g` + @earendil-works/pi-coding-agent/dist/bundle/cli.js
 *   3. `where pi` shim + sibling node_modules path
 */
export function resolvePiCli(explicit?: string): string {
  return resolveAgentCli("pi", ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"], explicit || process.env.BRIDGE_PI_CLI);
}

function resolveAgentCli(name: string, packages: string[], supplied?: string): string {

  if (supplied) {
    const value = resolve(supplied);
    if (existsSync(value)) return value;
    throw new BridgeError(ExitCode.UNAVAILABLE, `${name} entrypoint not found: ${value}`);
  }

  const roots = new Set<string>();
  for (const dir of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const binName of process.platform === "win32" ? [`${name}.exe`] : [name]) {
      const command = join(dir, binName);
      if (existsSync(command)) {
        const actual = realpathSync(command);
        // npm Unix symlinks point directly at a JS entrypoint; native Pi is also supported.
        if (!actual.endsWith(".cmd") && !actual.endsWith(".ps1")) return actual;
      }
    }
    roots.add(join(dir, "node_modules"));
    roots.add(resolve(dir, "..", "lib", "node_modules"));
  }
  roots.add(join(homedir(), ".npm-global", "lib", "node_modules"));
  if (process.env.APPDATA) roots.add(join(process.env.APPDATA, "npm", "node_modules"));
  try {
    const npmCli = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find(existsSync);
    const output = npmCli
      ? execFileSync(process.execPath, [npmCli, "root", "-g"], { encoding: "utf8", timeout: 10000, windowsHide: true })
      : process.platform !== "win32" ? execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10000 }) : "";
    if (output.trim()) roots.add(output.trim());
  } catch { /* PATH and prefix candidates remain available. */ }
  for (const base of roots) for (const pkg of packages) {
    const manifest = join(base, pkg, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const data = JSON.parse(readFileSync(manifest, "utf8"));
      const entry = typeof data.bin === "string" ? data.bin : data.bin?.[name];
      if (entry && existsSync(join(base, pkg, entry))) return realpathSync(join(base, pkg, entry));
    } catch { /* An unrelated or incomplete installation is not usable. */ }
  }
  throw new BridgeError(ExitCode.UNAVAILABLE, `${name} not found. Put ${name} on PATH or set BRIDGE_${name.toUpperCase()}_CLI to its JS entrypoint or native executable.`);
}

export function configuredModel(cfg: BridgeConfig): string {
  if (!cfg.pi.model) return "default";
  return cfg.pi.model.includes("/") || !cfg.pi.provider ? cfg.pi.model : `${cfg.pi.provider}/${cfg.pi.model}`;
}
export function defaultHome(): string {
  if (process.env.BRIDGE_HOME) return resolve(process.env.BRIDGE_HOME);
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "codex-pi-bridge");
  return join(homedir(), ".codex-pi-bridge");
}

export function defaultConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const home = overrides.home ?? defaultHome();
  const base: BridgeConfig = {
    home,
    backend: "pi",
    ipc: { host: "127.0.0.1" },
    pi: {
      cliPath: "",
      nodePath: process.execPath,
      profile: (process.env.PI_BRIDGE_WORKER_PROFILE || "inherit") as "inherit" | "minimal",
      args: parsePiArgsEnv(),
      provider: process.env.BRIDGE_PI_PROVIDER || "",
      model: process.env.BRIDGE_PI_MODEL || "",
    },
    worker: {
      transport: "auto",
      startupTimeoutMs: 60_000,
      turnTimeoutMs: 900_000,
      abortGraceMs: 10_000,
    },
    limits: {
      maxWorkerTurns: 24,
      verifyTimeoutSeconds: 180,
      runTimeoutSeconds: 900,
      summaryMaxTokens: 800,
      summaryMaxChars: 4000,
      maxRunLogBytes: 20 * 1024 * 1024,
      verifyTerminateWaitMs: 8000,
    },
  };
  return deepMerge(base, overrides);
}

export function configPath(home: string): string {
  return join(home, "bridge.config.json");
}

export function loadConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  const home = overrides.home ?? defaultHome();
  let fileCfg: Partial<BridgeConfig> = {};
  const p = configPath(home);
  if (existsSync(p)) {
    try {
      fileCfg = JSON.parse(readFileSync(p, "utf8")) as Partial<BridgeConfig>;
    } catch (err) {
      throw new BridgeError(ExitCode.BAD_REQUEST, `配置文件解析失败: ${p}: ${(err as Error).message}`);
    }
  }
  const merged = defaultConfig(deepMerge(fileCfg as Record<string, unknown>, overrides as Record<string, unknown>) as Partial<BridgeConfig>);
  if (merged.backend !== undefined && merged.backend !== "pi") throw new BridgeError(ExitCode.BAD_REQUEST, "Only Pi is supported");
  if (!merged.pi.cliPath) merged.pi.cliPath = resolvePiCli();
  piWorkerArgs(merged.pi);
  return merged;
}

export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveConfigFile(cfg: BridgeConfig): void {
  ensureDir(cfg.home);
  writeFileSync(configPath(cfg.home), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

/** Paths derived from home; created lazily. */
export function runtimePaths(home: string) {
  return {
    home,
    dbFile: join(home, "bridge.sqlite"),
    jsonDbFile: join(home, "bridge-db.json"),
    pidFile: join(home, "daemon.pid"),
    tokenFile: join(home, "daemon.token"),
    portFile: join(home, "daemon.port"),
    logsDir: join(home, "logs"),
    sessionsDir: join(home, "sessions"),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined) continue;
    const existing = out[k];
    if (isPlainObject(existing) && isPlainObject(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export { isAbsolute };

function parsePiArgsEnv(): string[] {
  if (!process.env.PI_BRIDGE_PI_ARGS) return [];
  try {
    const args = JSON.parse(process.env.PI_BRIDGE_PI_ARGS);
    if (!Array.isArray(args) || args.some(arg => typeof arg !== "string")) throw new Error();
    return args;
  } catch { throw new BridgeError(ExitCode.BAD_REQUEST, "PI_BRIDGE_PI_ARGS must be a JSON string array"); }
}
