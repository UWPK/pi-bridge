import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolvePiCli, configuredModel, defaultConfig } from '../../dist/src/config.js';
import { identity } from '../../bin/common.mjs';
const root = process.env.PI_BRIDGE_PACKAGE_ROOT || resolve(import.meta.dirname, '../..');
const launcher = join(root, 'bin/pi-bridge.mjs');
const temp = mkdtempSync(join(tmpdir(), 'pi-bridge-portable-'));
const pi = join(temp, 'fake-pi.cjs');
const send = String.raw`
const fs=require('node:fs');
if(process.argv.includes('--help')){console.log('--no-extensions --no-mcp --no-skills --no-prompt-templates --extension --skill --prompt-template --thinking');process.exit(0);}
if(process.env.PI_BRIDGE_WORKER_PROFILE==='minimal'){
 for(const flag of ['--no-extensions','--no-mcp','--no-skills','--no-prompt-templates','--extension']) if(!process.argv.includes(flag)) throw new Error('Missing worker flag '+flag);
}
if(process.argv.includes('--provider') || process.argv.includes('--model')) throw new Error('Unexpected override of Pi defaults');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line); const emit=o=>process.stdout.write(JSON.stringify(o)+'\n');
 const reply=data=>emit({id:c.id,type:'response',command:c.type,success:true,data});
 switch(c.type){
 case 'get_state':reply({model:{provider:'fixture',id:'model'},isStreaming:false});break;
 case 'new_session':reply({cancelled:false});break;
 case 'get_available_models':reply({models:[{provider:'fixture',id:'model'}]});break;
 case 'get_last_assistant_text':reply({text:'Created hello.txt'});break;
 case 'get_session_stats':reply({tokens:{input:1,output:1,total:2},cost:0});break;
 case 'prompt':reply({disposition:'started'});emit({type:'agent_start'});emit({type:'agent_end'});setTimeout(()=>{fs.writeFileSync('hello.txt','hello\n');emit({type:'agent_settled',aborted:false});},500);break;
 default:reply({});
 }
});`;
writeFileSync(pi, send);
const env = { ...process.env, BRIDGE_PI_CLI: pi, PI_BRIDGE_STATE_ROOT: join(temp, 'state') };
for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
function cli(args, extra = {}) { return spawnSync(process.execPath, [launcher, ...args], { env: { ...env, ...extra }, encoding:'utf8', timeout:30000 }); }
test('Pi resolver honours explicit paths and rejects a broken override', () => {
 assert.equal(resolvePiCli(pi), pi);
 assert.throws(() => resolvePiCli(join(temp, 'missing.cjs')), /not found/);
 const cfg=defaultConfig(); cfg.pi.provider='';cfg.pi.model=''; assert.equal(configuredModel(cfg),'default');
 cfg.pi.provider='provider';cfg.pi.model='model';assert.equal(configuredModel(cfg),'provider/model');
 cfg.pi.model='other/model';assert.equal(configuredModel(cfg),'other/model');
});
test('instances remain separate and reject traversal', () => {
 const a=identity(['status','--instance','chat-one','--state-root',temp]);
 const b=identity(['status','--instance','chat-two','--state-root',temp]);
 assert.notEqual(a.home,b.home);assert.deepEqual(a.args,['status']);
 assert.throws(()=>identity(['status','--instance','../escape']), /Invalid instance/);
});
test('portable installer preserves existing skill and emits valid MCP paths', () => {
 const destination=join(temp,'skills with spaces','pi-bridge');
 const first=cli(['install-skill','--destination',destination,'--apply']);assert.equal(first.status,0,first.stderr);
 assert.ok(existsSync(join(destination,'SKILL.md')));
 const original=readFileSync(join(destination,'SKILL.md'),'utf8');
 assert.equal(cli(['install-skill','--destination',destination,'--apply']).status,2);
 assert.equal(readFileSync(join(destination,'SKILL.md'),'utf8'),original);
 const config=cli(['mcp-config']);assert.equal(config.status,0);assert.match(config.stdout,/mcp_servers.pi_bridge/);
 assert.equal(cli(['up','--instance','test']).status,2);
 const check=cli(['check-local']);assert.equal(check.status,0);assert.equal(JSON.parse(check.stdout).modelRequestMade,false);
});
test('MCP handshake, validation, isolated daemon, fake Pi task and real verifier', { timeout:60000 }, async () => {
 const workspace=join(temp,'workspace');
 const { mkdirSync }=await import('node:fs');mkdirSync(workspace);
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:workspace,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 git('init','-q');git('config','user.name','Bridge Test');git('config','user.email','test@example.invalid');
 writeFileSync(join(workspace,'README.md'),'fixture\n');git('add','.');git('commit','-qm','initial');
 const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'bin/pi-bridge-mcp.mjs')],env:{...env,PI_BRIDGE_WORKER_PROFILE:'minimal',PI_BRIDGE_PI_ARGS:JSON.stringify(['--extension',pi])},stderr:'pipe'});
 const client=new Client({name:'portable-test',version:'1.0.0'});
 let diagnostics='';transport.stderr?.on('data',d=>diagnostics+=d);
 await client.connect(transport);
 const call=(action,args={})=>client.callTool({name:`pi_bridge_${action}`,arguments:{instance:'chat-portable-test',...args}});
 try {
  const list=await client.listTools();assert.equal(list.tools.length,11);
  assert.equal((await call('check')).isError,false);
  assert.equal((await call('up',{apply:false})).isError,true);
  assert.equal((await call('status',{instance:'../escape'})).isError,true);
  const up=await call('up',{apply:true});assert.equal(up.isError,false,JSON.stringify(up));
  const other=await call('status',{instance:'chat-other'});assert.equal(other.isError,true);
  const doctor=await call('doctor');assert.equal(doctor.isError,false,JSON.stringify(doctor));assert.match(doctor.content[0].text,/minimal/);
  assert.equal((await call('authorize',{directory:workspace,apply:true})).isError,false);
  const task={schemaVersion:'2.0',title:'fixture task',workspace,objective:'Create hello.txt',mode:'standard',policy:{allowWrite:true,allowNetwork:true},acceptance:[{kind:'command',command:[process.execPath,'-e',"process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hello'?0:1)"]}]};
  const submitted=await call('delegate',{task,apply:true});assert.equal(submitted.isError,false,JSON.stringify(submitted));
  const id=JSON.parse(submitted.content[0].text).taskId;assert.ok(id);
  let status;
  const deadline=Date.now()+20000;
  do { const r=await call('status',{taskId:id});assert.equal(r.isError,false);status=JSON.parse(r.content[0].text);if(!['pending','running'].includes(status.task?.status || status.status))break;await new Promise(r=>setTimeout(r,100)); } while(Date.now()<deadline);
  assert.equal(readFileSync(join(workspace,'hello.txt'),'utf8').trim(),'hello');
  assert.match(JSON.stringify(status),/passed/);
  assert.match(JSON.stringify(status),/verified/);
 } finally {
  try { await call('down',{apply:true}); } finally { await client.close(); }
 }
});

test('MCP config preserves worker selection without exporting unrelated secrets', () => {
 const args=JSON.stringify(['--extension',pi]);
 const result=cli(['mcp-config'],{PI_BRIDGE_WORKER_PROFILE:'minimal',PI_BRIDGE_PI_ARGS:args,UNRELATED_API_KEY:'do-not-export-this'});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/\[mcp_servers\.pi_bridge\.env\]/);
 assert.match(result.stdout,/PI_BRIDGE_WORKER_PROFILE = "minimal"/);
 assert.match(result.stdout,/BRIDGE_PI_CLI = /);
 assert.match(result.stdout,/PI_BRIDGE_PI_ARGS = /);
 assert.ok(!result.stdout.includes('do-not-export-this'));
});
