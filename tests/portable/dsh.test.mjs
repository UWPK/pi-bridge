import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root=process.env.PI_BRIDGE_PACKAGE_ROOT || resolve(import.meta.dirname,'../..');
const temporary=mkdtempSync(join(tmpdir(),'bridge-dsh-'));
const fake=join(temporary,'fake-dsh.cjs');
writeFileSync(fake,String.raw`
const fs=require('node:fs');
const {spawn}=require('node:child_process');
if(process.argv[2]!=='--profile'||process.argv[3]!=='headless')throw new Error('Bad DSH profile arguments');
const prompt=process.argv[4];
if(prompt.includes('DSH_FIXTURE_FAIL'))process.exit(7);
if(prompt.includes('DSH_FIXTURE_HANG')){
 spawn(process.execPath,['-e',"setTimeout(()=>require('node:fs').writeFileSync('cancel-leak.txt','leaked'),5000)"],{stdio:'ignore'});
 setInterval(()=>{},10000);
}else{fs.writeFileSync('dsh-result.txt','ok');console.log('Created dsh-result.txt');}
`);
const environment={...process.env,BRIDGE_DSH_CLI:fake,BRIDGE_PI_CLI:join(temporary,'missing-pi.cjs'),PI_BRIDGE_STATE_ROOT:join(temporary,'state')};
for(const k of Object.keys(environment))if(environment[k]===undefined)delete environment[k];
test('DSH headless: MCP success, exit failure and full-tree cancellation without Pi', {timeout:90000},async()=>{
 const workspace=join(temporary,'workspace');mkdirSync(workspace);
 const git=(...args)=>{const r=spawnSync('git',args,{cwd:workspace,encoding:'utf8'});assert.equal(r.status,0,r.stderr);};
 git('init','-q');git('config','user.name','Bridge Test');git('config','user.email','test@example.invalid');
 writeFileSync(join(workspace,'README.md'),'fixture\n');git('add','.');git('commit','-qm','initial');
 const client=new Client({name:'dsh-test',version:'1.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:[join(root,'bin/pi-bridge-mcp.mjs')],env:environment,stderr:'pipe'});
 await client.connect(transport);
 const call=(action,args={})=>client.callTool({name:`pi_bridge_${action}`,arguments:{instance:'dsh-test',backend:'dsh',...args}});
 const json=r=>JSON.parse(r.content[0].text);
 const task=objective=>({schemaVersion:'2.0',title:'DSH fixture',workspace,objective,mode:'standard',policy:{allowWrite:true,allowNetwork:true,requireCleanDiff:false,timeoutSeconds:30},acceptance:[{kind:'command',command:[process.execPath,'-e',"process.exit(require('fs').readFileSync('dsh-result.txt','utf8')==='ok'?0:1)"]}]});
 async function wait(id){const deadline=Date.now()+15000;let result;do{result=json(await call('status',{taskId:id}));if(!['pending','running'].includes(result.task.status))return result;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);throw new Error('Task timed out');}
 try{
  assert.equal((await call('check')).isError,false);
  assert.equal((await call('up',{apply:true})).isError,false);
  assert.equal((await call('authorize',{directory:workspace,apply:true})).isError,false);
  const submitted=await call('delegate',{task:task('Create dsh-result.txt'),apply:true});assert.equal(submitted.isError,false,JSON.stringify(submitted));
  let result=await wait(json(submitted).taskId);assert.equal(result.task.status,'succeeded');assert.match(result.latestHandoff.payloadJson,/passed/);assert.match(result.latestHandoff.payloadJson,/headless/);
  assert.equal(readFileSync(join(workspace,'dsh-result.txt'),'utf8'),'ok');
  const override=await call('delegate',{task:{...task('x'),model:'unsupported/model'},apply:true});assert.equal(override.isError,true);
  const failed=await call('delegate',{task:task('DSH_FIXTURE_FAIL'),apply:true});assert.equal(failed.isError,false);
  result=await wait(json(failed).taskId);assert.equal(result.task.status,'failed');assert.match(result.latestHandoff.payloadJson,/backend_failed/);
  const hanging=await call('delegate',{task:task('DSH_FIXTURE_HANG'),apply:true});assert.equal(hanging.isError,false);
  const id=json(hanging).taskId;await new Promise(r=>setTimeout(r,1200));
  assert.equal((await call('cancel',{taskId:id,apply:true})).isError,false);
  result=await wait(id);assert.equal(result.task.status,'cancelled');
  await new Promise(r=>setTimeout(r,5500));assert.equal(existsSync(join(workspace,'cancel-leak.txt')),false);
  const models=await call('models');assert.equal(json(models).supported,false);
  assert.equal((await call('status',{backend:'pi'})).isError,true);
 }finally{try{await call('down',{apply:true});}finally{await client.close();}}
});
