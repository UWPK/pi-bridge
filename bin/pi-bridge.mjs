#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageRoot, identity } from './common.mjs';
const help = `pi-bridge: portable Codex -> Pi bridge
Commands: check-local, install-skill, mcp-config, up, doctor, models, authorize,
          delegate, status, logs, cancel, resume, down, config
Use --instance NAME or a Codex thread identity. --state-root PATH is optional.
Mutating commands require --apply. Delegate trusted host tasks with a schema-2.0
JSON task file (or --task-file - on stdin). Model/provider inherit Pi by default.
install-skill --destination DIR defaults to ~/.agents/skills/pi-bridge.
mcp-config prints a Codex TOML snippet; it does not edit Codex configuration.`;
try {
  const original = process.argv.slice(2);
  const action = original[0] || 'help';
  if (['help', '--help', '-h'].includes(action)) { console.log(help); process.exit(0); }
  if (action === 'mcp-config') {
    console.log(`[mcp_servers.pi_bridge]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(packageRoot, 'bin/pi-bridge-mcp.mjs'))}]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120`);
    process.exit(0);
  }
  if (action === 'install-skill') {
    if (!original.includes('--apply')) throw new Error('install-skill requires --apply');
    const index = original.indexOf('--destination');
    if (index >= 0 && !original[index + 1]) throw new Error('--destination needs a directory');
    const destination = resolve(index >= 0 ? original[index + 1] : join(homedir(), '.agents/skills/pi-bridge'));
    if (existsSync(destination)) throw new Error(`Skill destination already exists: ${destination}; choose another destination or manage the existing skill explicitly`);
    mkdirSync(resolve(destination, '..'), { recursive: true });
    cpSync(join(packageRoot, 'skills/pi-bridge'), destination, { recursive: true, errorOnExist: true });
    console.log(JSON.stringify({ installed: destination, runtimeCommand: join(packageRoot, 'bin/pi-bridge.mjs') }));
    process.exit(0);
  }
  if (action === 'check-local') {
    const { resolvePiCli } = await import('../dist/src/config.js');
    let pi; let error;
    try { pi = resolvePiCli(); } catch (err) { error = err.message; }
    console.log(JSON.stringify({ ok: !!pi, node: process.version, platform: process.platform, architecture: process.arch, pi, error, model: process.env.BRIDGE_PI_MODEL || 'Pi default', modelRequestMade: false }));
    process.exit(pi ? 0 : 4);
  }
  const context = identity(original);
  if (!context.home) throw new Error('Supply --instance NAME or run inside an identified Codex chat');
  const mutations = ['up', 'down', 'authorize', 'delegate', 'cancel', 'resume', 'check'];
  if (mutations.includes(action) && !context.args.includes('--apply')) throw new Error(`${action} requires --apply`);
  const args = context.args.filter(value => value !== '--apply');
  const child = spawn(process.execPath, [join(packageRoot, 'dist/src/cli.js'), ...args], { stdio: 'inherit', env: { ...process.env, BRIDGE_HOME: context.home }, shell: false, windowsHide: true });
  child.on('error', err => { console.error(err.message); process.exitCode = 4; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (err) { console.error(err.message); process.exitCode = 2; }
