// Synthetic public fixture only. No user data, conversations, or research files.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=mkdtempSync(join(tmpdir(),'jev-workflow-')),cwd=join(root,'work'),state=join(root,'state');mkdirSync(cwd);mkdirSync(join(cwd,'tests'));
const run=fileURLToPath(new URL('../hooks/run.mjs',import.meta.url)),records=[];
writeFileSync(join(cwd,'main.mjs'),'export const permit = value => value === true;\n');
writeFileSync(join(cwd,'tests/contract.json'),JSON.stringify({inputs:[true,false,null,'true'],expected:[true,false,false,false]}));
const prefix="import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {permit} from '../main.mjs';const contract=JSON.parse(readFileSync('tests/contract.json','utf8'));\n";
writeFileSync(join(cwd,'tests/premise.mjs'),prefix+"assert.equal(contract.inputs.length,4);assert.equal(contract.expected.length,4);assert.deepEqual(contract.expected,contract.inputs.map(x=>x===true));assert.throws(()=>assert.deepEqual([true,true,true,true],contract.expected));console.log('Input domain and fixed reference are consistent; invalid reference rejected.');");
writeFileSync(join(cwd,'tests/pilot.mjs'),prefix+"assert.deepEqual(contract.inputs.map(permit),contract.expected);console.log('Pilot: true accepted; false/null/string rejected.');");
writeFileSync(join(cwd,'tests/evaluation.mjs'),prefix+"const audit=f=>assert.deepEqual(contract.inputs.map(f),contract.expected);audit(x=>x===true);assert.throws(()=>audit(()=>true));assert.throws(()=>audit(()=>false));console.log('Independent evaluator audit: correct reference accepted; always-allow and always-deny faults detected.');");
writeFileSync(join(cwd,'tests/execute.mjs'),prefix+"writeFileSync('result.json',JSON.stringify(contract.inputs.map(permit)));console.log('Requested four input execution completed; result.json written.');");
writeFileSync(join(cwd,'tests/result.mjs'),prefix+"assert.deepEqual(JSON.parse(readFileSync('result.json','utf8')),contract.expected);console.log('Actual execution results match the sealed reference: [true,false,false,false].');");
async function hook(event,payload){return new Promise((done,reject)=>{
 const p=spawn(process.execPath,[run,event],{cwd,env:{...process.env,JEV_HARNESS_STATE_DIR:state}});let stdout='',stderr='';
 p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>{
  const result={code,stdout:stdout.trim()?JSON.parse(stdout):null,stderr};records.push({event,payload,result});done(result);
 });p.stdin.end(JSON.stringify({session_id:'workflow-live',cwd,...payload}));
});}
const denied=r=>r.stdout?.hookSpecificOutput?.permissionDecision==='deny';
const ensure=(v,msg)=>{if(!v)throw new Error(msg);};
const saved=()=>JSON.parse(readFileSync(join(state,'sessions/workflow-live.json'),'utf8'));
let error=null;
try{
 await hook('UserPromptSubmit',{prompt:'Verify an existing permit(value) function in this isolated fixture. Goal: permit(true) is true; false, null, and string true must be false. Fixed reference: tests/contract.json. Follow design, prerequisites, implementation, pilot, independent evaluator check, execute four inputs, inspect actual result. No deployment or broader safety claim. This concrete scope is approved; no additional approval is needed.'});
 ensure(saved().approved===true,'Concrete request not approved');
 const plan='Plan: The caller must receive true only for boolean true; false, null and string true must each return false. The implementation mechanism is strict identity value === true. First inspect tests/contract.json and run tests/premise.mjs to validate those four inputs and the expected [true,false,false,false], with a deliberately inconsistent reference rejected. During implementation inspect main.mjs and correct it to value === true only if necessary. Then tests/pilot.mjs must assert the exact four outputs from permit. Independently audit the evaluator using tests/evaluation.mjs: the correct function passes; always-true and always-false functions must fail, showing the test catches both unsafe acceptance and over-rejection. After these gates run tests/execute.mjs for exactly four inputs, and tests/result.mjs must compare the actual saved result.json against the unchanged expected array. Any assertion failure prevents completion. Scope is only this fixture and these inputs, not host integration or general safety. This is the plan; no checks have run yet.';
 const planResult=await hook('Stop',{last_assistant_message:plan});
 ensure(planResult.code===2 && planResult.stderr.includes('jev-workflow: phase=premises'),'Plan did not request automatic continuation');
 ensure(saved().workflow.phase==='premises','Plan did not advance');
 const originalRequest=saved().request;
 await hook('UserPromptSubmit',{prompt:planResult.stderr});
 ensure(saved().request===originalRequest && saved().approved,'Continuation lost original request or approval');
 const premature={tool_name:'Bash',tool_use_id:'premature',tool_input:{command:'node tests/execute.mjs'}};
 ensure(denied(await hook('PreToolUse',premature)),'Premature execution permitted');
 ensure(!existsSync(join(cwd,'result.json')),'Premature execution produced output');
 for(const [name,next] of [['premise','implementation'],['pilot','evaluation'],['evaluation','execution'],['execute','results'],['result','complete']]){
  const op={tool_name:'Bash',tool_use_id:name,tool_input:{command:`node tests/${name}.mjs`}};
  const pre=await hook('PreToolUse',op);ensure(!denied(pre),'Pre rejected '+name+': '+JSON.stringify(pre));
  const result=await new Promise(done=>{const p=spawn(process.execPath,[`tests/${name}.mjs`],{cwd});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('close',exit_code=>done({exit_code,output}));});
  ensure(result.exit_code===0,'Actual process failed: '+name);await hook('PostToolUse',{...op,tool_response:result});
  ensure(saved().workflow.phase===next,'Wrong next phase after '+name+': '+saved().workflow.phase);
  console.log(JSON.stringify({check:name,observed_phase:next}));
 }
 const completion=await hook('Stop',{last_assistant_message:'Verified this fixture for the four agreed inputs. The actual saved results are [true,false,false,false], matching the unchanged reference. The prerequisite check, pilot, independent evaluator fault checks, four-input execution, and result comparison all completed with exit zero. The scoped fixture verification is complete; this does not establish desktop host integration or behavior outside these inputs.'});
 ensure(completion.code===0,'Evidence-backed completion rejected: '+completion.stderr);
 // Criteria edits must revoke all success BEFORE the edit is permitted.
 const edit={tool_name:'Write',tool_use_id:'tamper',tool_input:{file_path:'tests/contract.json',content:'{"expected":[true,true,true,true]}'}};
 ensure(denied(await hook('PreToolUse',edit)),'Criteria tampering permitted');
 ensure(saved().workflow.phase==='design' && saved().receipts.length===0,'Criteria change did not invalidate evidence');
 ensure(denied(await hook('PreToolUse',premature)),'Execution allowed after criteria change');
}catch(e){error=String(e.message);process.exitCode=1;}
writeFileSync(resolve(process.argv[2]||'workflow-live.json'),JSON.stringify({passed:!error,error,root,scope:'Real Jev + hook subprocess + real fixture execution; not desktop host integration',records},null,2));
console.log(JSON.stringify({passed:!error,error,events:records.length}));
