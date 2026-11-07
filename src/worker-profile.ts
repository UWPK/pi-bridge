import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import type { BridgeConfig } from "./types.js";
import { BridgeError, ExitCode } from "./errors.js";

export const MINIMAL_PI_ARGS = ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates"];
const switches = new Set(MINIMAL_PI_ARGS);
const values = new Set(["--extension", "-e", "--skill", "--prompt-template", "--thinking"]);

/** Loader controls only: callers cannot replace RPC mode, session routing or credentials. */
export function piWorkerArgs(pi: BridgeConfig["pi"]): string[] {
  const profile = pi.profile ?? "inherit";
  if (!["inherit", "minimal"].includes(profile)) throw new BridgeError(ExitCode.BAD_REQUEST, "pi.profile must be inherit or minimal");
  if (pi.args !== undefined && (!Array.isArray(pi.args) || pi.args.some(arg => typeof arg !== "string" || !arg || arg.includes("\0")))) {
    throw new BridgeError(ExitCode.BAD_REQUEST, "pi.args must be an array of nonempty strings");
  }
  const extra = pi.args ?? [];
  for (let i = 0; i < extra.length; i++) {
    const flag = extra[i]!;
    if (switches.has(flag)) continue;
    if (!values.has(flag)) throw new BridgeError(ExitCode.BAD_REQUEST, `Unsupported Pi worker argument: ${flag}; use loader controls or --thinking`);
    const value = extra[++i];
    if (!value || value.startsWith("-")) throw new BridgeError(ExitCode.BAD_REQUEST, `${flag} requires a value`);
    if (flag !== "--thinking" && (!isAbsolute(value) || !existsSync(value))) throw new BridgeError(ExitCode.BAD_REQUEST, `${flag} requires an existing absolute local path`);
  }
  return [...(profile === "minimal" ? MINIMAL_PI_ARGS : []), ...extra];
}

/** Run only for opted-in loader controls, once per supervisor. No model request. */
export function validatePiWorkerSupport(pi: BridgeConfig["pi"], args: string[]): void {
  if (!args.length) return;
  let help: string;
  try {
    const js = /\.[cm]?js$/i.test(pi.cliPath);
    help = execFileSync(js ? pi.nodePath : pi.cliPath, [...(js ? [pi.cliPath] : []), "--help"], {
      encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new BridgeError(ExitCode.UNAVAILABLE, "Cannot verify Pi worker flags via --help; check the selected Pi executable/version and host process permissions");
  }
  const supported = new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? []);
  for (const arg of args) {
    if ((arg === "-e" && !supported.has("--extension")) || (arg.startsWith("--") && !supported.has(arg))) throw new BridgeError(ExitCode.UNAVAILABLE, `Selected Pi does not advertise ${arg}; update Pi or choose a compatible worker profile`);
  }
}
