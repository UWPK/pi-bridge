import { join, resolve } from 'node:path';
import { packageRoot } from './common.mjs';
import { resolvePiCli, resolveDshCli } from '../dist/src/config.js';

// Copy only runtime selection settings. Credentials and unrelated environment stay private.
export function mcpConfig(env = process.env) {
 const selected = {};
 for (const key of ['BRIDGE_PI_CLI','BRIDGE_DSH_CLI','BRIDGE_BACKEND','BRIDGE_PI_PROVIDER','BRIDGE_PI_MODEL','PI_BRIDGE_WORKER_PROFILE','PI_BRIDGE_PI_ARGS','PI_BRIDGE_STATE_ROOT']) {
  if (env[key]) selected[key] = env[key];
 }
 for (const key of ['BRIDGE_PI_CLI','BRIDGE_DSH_CLI','PI_BRIDGE_STATE_ROOT']) if (selected[key]) selected[key] = resolve(selected[key]);
 const backend = selected.BRIDGE_BACKEND || 'pi';
 const cliKey = backend === 'dsh' ? 'BRIDGE_DSH_CLI' : 'BRIDGE_PI_CLI';
 if (!selected[cliKey]) {
  try { selected[cliKey] = backend === 'dsh' ? resolveDshCli() : resolvePiCli(); } catch { /* Can be filled after backend installation. */ }
 }
 let result = `[mcp_servers.pi_bridge]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(packageRoot, 'bin/pi-bridge-mcp.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120`;
 if (Object.keys(selected).length) result += '\n\n[mcp_servers.pi_bridge.env]\n' + Object.entries(selected).map(([key,value]) => `${key} = ${JSON.stringify(value)}`).join('\n');
 return result;
}
