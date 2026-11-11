import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { packageRoot, identity } from './common.mjs';
import { mcpConfig } from './mcp-config.mjs';
import { resolvePiCli } from '../dist/src/config.js';
import { piWorkerArgs } from '../dist/src/worker-profile.js';

function sameFiles(source, target) {
 for (const entry of readdirSync(source, {withFileTypes:true})) {
  const a=join(source,entry.name), b=join(target,entry.name);
  if (!existsSync(b)) return false;
  if (entry.isDirectory()) { if (!lstatSync(b).isDirectory() || !sameFiles(a,b)) return false; }
  else if (!lstatSync(b).isFile() || !readFileSync(a).equals(readFileSync(b))) return false;
 }
 return true;
}

// Report only curated diagnostics: child output can contain local secrets.
export async function setup(argv, env=process.env) {
 const options={};
 for(let i=0;i<argv.length;i++) {
  const key=argv[i];
  if(['--apply','--verify'].includes(key)) {options[key.slice(2)]=true;continue;}
  if(!['--destination','--profile','--pi-cli'].includes(key)) throw new Error(`Unknown setup option: ${key}`);
  const value=argv[++i];
  if(!value || value.startsWith('--')) throw new Error(`${key} needs a value`);
  options[key.slice(2)]=value;
 }
 if(!options.apply) throw new Error('setup requires --apply; it starts Pi --help (which may initialize Pi state) and installs the skill. Add --verify only to authorize a real model task in a temporary workspace.');
 const destination=resolve(options.destination || join(homedir(),'.agents/skills/pi-bridge'));
 const piState=resolve(env.PI_CODING_AGENT_DIR || join(homedir(),'.pi/agent'));
 const bridgeState=identity([],true).root;
 const checks=[];
 const report={ok:false,status:'blocked',platform:process.platform,architecture:process.arch,node:process.version,
  checks,skill:destination,modelRequestMade:false,modelVerified:false,
  permissions:{piState,bridgeState,skill:destination,processes:['Git','Pi','Pi Bridge'],network:'Model service only during --verify or normal tasks. Host permissions are granted by the user, never by this command.'}};
 const stage=(id,action,nextAction)=>{
  try {const value=action();checks.push({id,status:'passed'});return value;}
  catch {checks.push({id,status:'blocked',nextAction});report.nextAction=nextAction;return undefined;}
 };
 const runtime=stage('runtime',()=>{
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22 || (major===22 && minor<19) || !['win32','darwin','linux'].includes(process.platform))throw Error();
  return true;
 },'Use Node.js >=22.19 on Windows, macOS or Linux (Node 24 LTS recommended).');
 if(!runtime)return report;
 if(env.BRIDGE_BACKEND && env.BRIDGE_BACKEND!=='pi') {report.nextAction='Only Pi is supported.';return report;}
 const git=stage('git',()=>{const r=spawnSync('git',['--version'],{env,encoding:'utf8',timeout:10000,windowsHide:true,shell:false});if(r.status!==0)throw Error();return true;},'Install Git or allow the Git executable, then rerun the same setup command.');
 if(!git)return report;
 const cliPath=stage('pi-discovery',()=>resolvePiCli(options['pi-cli'] || env.BRIDGE_PI_CLI),'Install Pi or supply --pi-cli with its actual executable/JS entrypoint, then rerun setup.');
 if(!cliPath)return report;
 report.pi=cliPath;
 const profile=options.profile || env.PI_BRIDGE_WORKER_PROFILE || 'inherit';
 const args=stage('worker-profile',()=>piWorkerArgs({cliPath,nodePath:process.execPath,profile,args:JSON.parse(env.PI_BRIDGE_PI_ARGS || '[]')}),'Choose inherit or minimal and valid loader arguments. Existing Pi settings were not changed.');
 if(!args)return report;
 report.profile=profile;
 const startup=stage('pi-startup',()=>{
  const js=/\.[cm]?js$/i.test(cliPath);
  const r=spawnSync(js?process.execPath:cliPath,[...(js?[cliPath]:[]),'--help'],{env,encoding:'utf8',timeout:15000,maxBuffer:1024*1024,windowsHide:true,shell:false});
  if(r.status!==0)throw Error();
  const supported=new Set(r.stdout.match(/--[a-z][a-z0-9-]*/g) || []);
  for(const arg of args) if((arg==='-e'&&!supported.has('--extension')) || (arg.startsWith('--')&&!supported.has(arg)))throw Error();
  return true;
 },`Pi startup or worker flag check failed. Check the selected executable/version. If host diagnostics explicitly identify a denied operation in ${piState}, ask the user to grant only that operation through the host. Stop after an automatic rejection; do not retry via another route. Setup cannot change host approval policy.`);
 if(!startup)return report;
 const installed=stage('skill',()=>{
  const source=join(packageRoot,'skills/pi-bridge');
  if(existsSync(destination)) {if(!sameFiles(source,destination))throw Error();report.reused=true;}
  else {mkdirSync(resolve(destination,'..'),{recursive:true});cpSync(source,destination,{recursive:true,errorOnExist:true});report.reused=false;}
  return true;
 },'Existing skill differs or the destination is not writable. Preserve local changes; review the update or choose a new --destination. Rerun the same command after resolving it.');
 if(!installed)return report;
 const selected={...env,BRIDGE_PI_CLI:cliPath,PI_BRIDGE_WORKER_PROFILE:profile,PI_BRIDGE_PI_ARGS:JSON.stringify(JSON.parse(env.PI_BRIDGE_PI_ARGS || '[]'))};
 report.mcpConfig=mcpConfig(selected);
 report.ok=true;report.status='installed';
 report.nextAction='Register the complete MCP snippet in your host. Run setup --apply --verify with the same options to test a real model task (may incur model charges). Host MCP connectivity requires a separate check.';
 if(options.verify) {
  const {verifySetup}=await import('./setup-verify.mjs');
  const verification=await verifySetup(selected);
  report.verification=verification;
  report.modelRequestMade=verification.modelRequestMade;
  report.modelVerified=verification.ok;
  report.ok=verification.ok;
  report.status=verification.ok?'verified':'verification-failed';
  report.nextAction=verification.ok?'CLI model task and independent acceptance passed. Register the complete MCP snippet and check the host connection; host approval policy is unchanged.':verification.nextAction;
 }
 return report;
}
