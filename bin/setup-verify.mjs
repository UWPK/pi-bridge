import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from './common.mjs';

// Each opt-in verification owns a separate daemon/workspace; never touches a daily instance.
export async function verifySetup(env) {
 const root=mkdtempSync(join(tmpdir(),'pi-bridge-verify-'));
 const workspace=join(root,'workspace');mkdirSync(workspace);
 const home=join(root,'state');
 const selected={...env,BRIDGE_HOME:home,BRIDGE_BACKEND:'pi'};
 const result={ok:false,modelRequestMade:false,evidenceDirectory:root,workspace};
 let started=false;
 const run=(args,timeout=30000)=>{
  const r=spawnSync(process.execPath,[join(packageRoot,'dist/src/cli.js'),...args,'--json'],{env:selected,encoding:'utf8',timeout,maxBuffer:2*1024*1024,windowsHide:true,shell:false});
  let data;try{data=JSON.parse(r.stdout);}catch{}
  return {ok:r.status===0,data};
 };
 try {
  for(const args of [['init','-q'],['-c','commit.gpgsign=false','-c','user.name=Bridge Verification','-c','user.email=verify@example.invalid','commit','--allow-empty','-qm','Verification workspace']]) {
   const r=spawnSync('git',args,{cwd:workspace,env,encoding:'utf8',timeout:15000,windowsHide:true,shell:false});
   if(r.status!==0)throw Error('workspace');
  }
  // Mark as owned before startup, so a partially started daemon is also stopped.
  started=true;
  if(!run(['up']).ok)throw Error('startup');
  if(!run(['authorize','--dir',workspace]).ok)throw Error('workspace-authorization');
  const task={schemaVersion:'2.0',title:'Verify Pi Bridge installation',workspace,mode:'economy',
   objective:'Create hello.txt containing exactly hello followed by a newline. Do not modify any other file. Do not invoke Pi Bridge.',
   constraints:['Modify only hello.txt.'],policy:{allowWrite:true,allowNetwork:true,timeoutSeconds:120,maxWorkerTurns:6},
   acceptance:[{kind:'command',command:[process.execPath,'-e',"process.exit(require('fs').readFileSync('hello.txt','utf8')==='hello\\n'?0:1)"],timeoutSeconds:15}]};
  const file=join(root,'task.json');writeFileSync(file,JSON.stringify(task,null,2));
  // This means a model request was attempted, not that the provider received it.
  result.modelRequestMade=true;
  const delegated=run(['delegate','--task-file',file,'--wait'],160000);
  result.taskId=delegated.data?.taskId;
  const h=delegated.data?.handoff;
  if(!delegated.ok || h?.status!=='passed' || h?.evidenceLevel!=='verified' || h?.verification?.[0]?.exitCode!==0 || readFileSync(join(workspace,'hello.txt'),'utf8')!=='hello\n')throw Error('model-or-acceptance');
  result.ok=true;result.verification={status:h.status,evidenceLevel:h.evidenceLevel,exitCode:h.verification[0].exitCode};
 } catch(error) {
  result.failedStage=error.message;
  result.nextAction='Verification failed. Inspect the retained task/status in evidenceDirectory before retrying; fix the reported dependency, model authentication or host permission. This command never retries a denied action. Rerunning creates a new test and can incur model charges.';
 } finally {
  const stopped=!started || run(['down']).ok;
  result.cleanup=stopped?'stopped':'requires-attention';
  if(!stopped) {result.ok=false;result.nextAction='The verification instance could not be stopped. Inspect its state in evidenceDirectory and stop only that instance before retrying.';}
  if(result.ok) {rmSync(root,{recursive:true,force:true});delete result.evidenceDirectory;delete result.workspace;}
 }
 return result;
}
