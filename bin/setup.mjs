import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageRoot } from './common.mjs';
import { mcpConfig } from './mcp-config.mjs';
import { resolvePiCli } from '../dist/src/config.js';
import { piWorkerArgs, validatePiWorkerSupport } from '../dist/src/worker-profile.js';

function sameFiles(source, target) {
 for (const entry of readdirSync(source, {withFileTypes:true})) {
  const a=join(source,entry.name), b=join(target,entry.name);
  if (!existsSync(b)) return false;
  if (entry.isDirectory()) { if (!sameFiles(a,b)) return false; }
  else if (!readFileSync(a).equals(readFileSync(b))) return false;
 }
 return true;
}
export function setup(argv, env=process.env) {
 const allowed=new Set(['--apply','--destination','--profile','--pi-cli']);
 const options={};
 for(let i=0;i<argv.length;i++) {
  const key=argv[i];
  if(!allowed.has(key)) throw new Error(`Unknown setup option: ${key}`);
  if(key==='--apply') {options.apply=true;continue;}
  const value=argv[++i];
  if(!value || value.startsWith('--')) throw new Error(`${key} needs a value`);
  options[key.slice(2)]=value;
 }
 if(!options.apply) throw new Error('setup requires --apply');
 if(env.BRIDGE_BACKEND && env.BRIDGE_BACKEND!=='pi') throw new Error('setup currently checks Pi; use the DSH setup reference for a DSH backend');
 if(!['win32','darwin','linux'].includes(process.platform)) throw new Error('Unsupported host platform');
 const git=spawnSync('git',['--version'],{encoding:'utf8',timeout:10000,windowsHide:true});
 if(git.status!==0) throw new Error('Git is required; install Git and retry setup');
 const profile=options.profile || env.PI_BRIDGE_WORKER_PROFILE || 'inherit';
 const cliPath=resolvePiCli(options['pi-cli'] || env.BRIDGE_PI_CLI);
 let extra;
 try { extra=JSON.parse(env.PI_BRIDGE_PI_ARGS || '[]'); } catch {throw new Error('PI_BRIDGE_PI_ARGS must be a JSON array');}
 const pi={cliPath,nodePath:process.execPath,profile,args:extra};
 const args=piWorkerArgs(pi);
 validatePiWorkerSupport(pi,args);
 // Even inherit must be executable. This check makes no model request.
 if(!args.length) {
  const js=/\.[cm]?js$/i.test(cliPath);
  const help=spawnSync(js?process.execPath:cliPath,[...(js?[cliPath]:[]),'--help'],{encoding:'utf8',timeout:15000,windowsHide:true});
  if(help.status!==0) throw new Error('Pi --help failed; check the executable and its host permissions');
 }
 const destination=resolve(options.destination || join(homedir(),'.agents/skills/pi-bridge'));
 const source=join(packageRoot,'skills/pi-bridge');
 let reused=false;
 if(existsSync(destination)) {
  if(!sameFiles(source,destination)) throw new Error('Existing skill differs; choose --destination or review the update manually');
  reused=true;
 } else {
  mkdirSync(resolve(destination,'..'),{recursive:true});
  cpSync(source,destination,{recursive:true,errorOnExist:true});
 }
 const selected={...env,BRIDGE_PI_CLI:cliPath,PI_BRIDGE_WORKER_PROFILE:profile,PI_BRIDGE_PI_ARGS:JSON.stringify(extra)};
 return {ok:true,platform:process.platform,architecture:process.arch,node:process.version,pi:cliPath,profile,skill:destination,reused,
  modelRequestMade:false,mcpConfig:mcpConfig(selected),nextAction:'Register the complete MCP snippet, then run a bounded real task with independent acceptance. Model authentication belongs to Pi.'};
}
