import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function identity(argv = [], allowGenerated = false) {
  const args = [...argv];
  const extract = name => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
    const value = args[i + 1]; args.splice(i, 2); return value;
  };
  const backend = extract('--backend') || process.env.BRIDGE_BACKEND || 'pi';
  if (!['pi','dsh'].includes(backend)) throw new Error('backend must be pi or dsh');
  const instance = extract('--instance') || process.env.PI_BRIDGE_INSTANCE || (process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID ? `chat-${process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID}` : allowGenerated ? `mcp-${randomUUID()}` : undefined);
  const root = extract('--state-root') || process.env.PI_BRIDGE_STATE_ROOT || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'pi-bridge') : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'pi-bridge') : join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-bridge'));
  if (instance && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(instance)) throw new Error('Invalid instance name');
  return { instance, backend, root: resolve(root), home: instance ? join(resolve(root), ...(backend === "dsh" ? ["dsh"] : []), instance) : undefined, args };
}
export function runCli(home, args, input, backend = "pi") {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(packageRoot, 'dist/src/cli.js'), ...args], { env: { ...process.env, BRIDGE_HOME: home, BRIDGE_BACKEND: backend }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdout = '', stderr = '', tooLarge = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('Bridge CLI timed out; inspect task status before retrying')); }, 90000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.stdout.on('data', data => { stdout += data; if (stdout.length > 2_000_000) { tooLarge = true; child.kill(); } });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('close', code => {
      clearTimeout(timer);
      if (tooLarge) return reject(new Error('Bridge response exceeded limit; use task status'));
      try { resolveResult({ code: code ?? 1, data: JSON.parse(stdout) }); }
      catch { reject(new Error(`Bridge returned no valid JSON (exit ${code}); ${stderr.slice(-1000)}`)); }
    });
  });
}
