#!/usr/bin/env node
// Internal adapter: Pi-shaped control frames -> documented DSH headless launches.
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { resolveDshCli } from '../dist/src/config.js';
const executable = resolveDshCli();
const emit = object => process.stdout.write(JSON.stringify(object) + '\n');
const reply = (request, data = {}, success = true, error) => emit({ type:'response', id:request.id, command:request.type, success, data, ...(error ? {error} : {}) });
let child, lastText = '', buffer = '', cancelled = false;
function handle(request) {
 switch (request.type) {
 case 'get_state': return reply(request, { isStreaming: !!child });
 case 'new_session': if (child) return reply(request, {}, false, 'DSH is busy'); lastText='';return reply(request, {cancelled:false});
 case 'switch_session': return reply(request, {}, false, 'DSH headless resume starts a fresh task session');
 case 'get_last_assistant_text': return reply(request, {text:lastText});
 case 'get_session_stats': return reply(request, {});
 case 'get_available_models': return reply(request, {models:[], capability:'DSH headless uses its configured model; model enumeration is unavailable'});
 case 'set_model': return reply(request, {}, false, 'Configure the model in DSH; this adapter does not override it');
 case 'clear_queue': return reply(request, {steering:[],followUp:[]});
 case 'abort': case 'abort_bash': cancelled=true;return reply(request);
 case 'prompt': {
  if (child) return reply(request, {}, false, 'DSH is busy');
  if (typeof request.message !== 'string' || request.message.length > 20000) return reply(request, {}, false, 'Headless prompt must be a string under 20000 characters');
  const useNode=/\.[cm]?js$/i.test(executable);
  const args=[...(useNode?[executable]:[]),'--profile','headless',request.message];
  cancelled=false;lastText='';
  const decoder=new StringDecoder('utf8');
  let output='', done=false;
  const finish=(code,error)=>{
   if(done)return;done=true;child=undefined;output+=decoder.end();lastText=output.trim().slice(-32000);
   if(error || code!==0) emit({type:'bridge_worker_error',message:error ? `DSH launch failed: ${error.code || 'spawn error'}` : `DSH headless exit ${code}`});
   if(lastText)emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text:lastText}]}});
   emit({type:'agent_settled',aborted:cancelled});
  };
  try {
   child=spawn(useNode?process.execPath:executable,args,{cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,detached:false});
   reply(request,{disposition:'started'});emit({type:'agent_start'});
   child.stdout.on('data',chunk=>{ output=(output+decoder.write(chunk)).slice(-64000); });
   // DSH may send provider reasoning on stderr. Drain it without relaying reasoning.
   child.stderr.resume();
   child.once('error',error=>finish(null,error));child.once('close',code=>finish(code));
  }catch(error){finish(null,error);}
  return;
 }
 default:return reply(request,{},false,`Unsupported command: ${request.type}`);
 }
}
const decoder=new StringDecoder('utf8');
process.stdin.on('data',chunk=>{
 buffer+=decoder.write(chunk);let index;
 while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;try{handle(JSON.parse(line));}catch{emit({type:'protocol_error',message:'Invalid control frame'});}}
 if(buffer.length>200000){process.stderr.write('Control input exceeded limit\n');process.exit(2);}
});
process.stdout.on('error',()=>process.exit(0));
// During cancellation keep the DSH parent alive until Bridge retires this adapter's
// complete process tree; killing only DSH first could orphan its descendants.
