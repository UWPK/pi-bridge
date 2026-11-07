import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "../../src/config.js";
import { MINIMAL_PI_ARGS, piWorkerArgs, validatePiWorkerSupport } from "../../src/worker-profile.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("worker profiles preserve inheritance and require explicit minimal selection", () => {
 const pi=defaultConfig().pi;
 pi.profile="inherit";pi.args=[];
 assert.deepEqual(piWorkerArgs(pi),[]);
 pi.profile="minimal";
 assert.deepEqual(piWorkerArgs(pi),MINIMAL_PI_ARGS);
 pi.args=["--thinking","high"];
 assert.deepEqual(piWorkerArgs(pi),[...MINIMAL_PI_ARGS,"--thinking","high"]);
});

test("worker controls reject RPC replacement, missing policy files and malformed config", () => {
 const pi=defaultConfig().pi;
 for(const args of [["--mode","text"],["--session-dir","elsewhere"],["--api-key","secret"],["--extension"],["--extension","relative-policy.ts"],["--extension","--help"]]){
  pi.args=args;assert.throws(()=>piWorkerArgs(pi));
 }
 pi.args=[];pi.profile="invalid" as "minimal";assert.throws(()=>piWorkerArgs(pi),/profile/);
 pi.profile="inherit";pi.args="--no-skills" as unknown as string[];assert.throws(()=>piWorkerArgs(pi),/array/);
});

test("preflight rejects unsupported Pi flags before starting an RPC worker", () => {
 const dir=mkdtempSync(join(tmpdir(),"bridge-profile-"));
 try {
  const entry=join(dir,"old-pi.cjs");writeFileSync(entry,"console.log('--no-extensions --skill --extension')");
  const pi={...defaultConfig().pi,cliPath:entry,nodePath:process.execPath,profile:"minimal" as const,args:[] as string[]};
  assert.throws(()=>validatePiWorkerSupport(pi,piWorkerArgs(pi)),/does not advertise --no-mcp/);
  writeFileSync(entry,`console.log(${JSON.stringify(MINIMAL_PI_ARGS.join(" "))})`);
  assert.doesNotThrow(()=>validatePiWorkerSupport(pi,piWorkerArgs(pi)));
  pi.args=["--extension",entry];assert.ok(piWorkerArgs(pi).includes(entry));
 } finally {rmSync(dir,{recursive:true,force:true});}
});
