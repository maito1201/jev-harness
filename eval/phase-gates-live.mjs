// Real jev, isolated sessions, harmless actual child execution. Never market training.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=fileURLToPath(new URL('../hooks/run.mjs',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'jev-live-')),cwd=join(root,'work'),state=join(root,'state');mkdirSync(cwd);
const records=[];
async function hook(event,payload={},env={}){
 return await new Promise((done,reject)=>{
  const p=spawn(process.execPath,[run,event],{cwd,env:{...process.env,JEV_HARNESS_STATE_DIR:state,...env}});
  let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);
  p.on('close',code=>{const result={code,out:stdout.trim()?JSON.parse(stdout):null,err:stderr};records.push({event,payload,result});done(result);});
  p.stdin.end(JSON.stringify({session_id:'jev-live-repair',cwd,...payload}));
 });
}
const denied=r=>r.out?.hookSpecificOutput?.permissionDecision==='deny';
const expect=(condition,message)=>{if(!condition)throw new Error(message);};
let failed=null;
try{
 await hook('UserPromptSubmit',{prompt:'小さなNodeプログラムのboolean許可ゲートを作る。呼び出し側が渡すtrueだけでカウンターを進め、それ以外で進めないことが目的。permit(evidence)はevidence===trueのときだけ許可し、false/undefined/文字列では拒否する。実際に許可と拒否をassertする小規模検証を先に行う。受入範囲はこの関数とカウンターの挙動だけで、外部システムの安全性は主張しない。結果なしの大規模実行は禁止。'});
 await hook('Stop',{last_assistant_message:'アウトカムは、true以外の値でカウンターが進まず、trueでだけ進むことです。未知は現在の実装です。permitの真偽と実行カウンターをassertし、小規模で拒否経路を検査します。この範囲で進めますか。'});
 await hook('UserPromptSubmit',{prompt:'要求あってる\ntrue以外でカウンターが進まないようにして'});
 const saved=JSON.parse(readFileSync(join(state,'sessions/jev-live-repair.json'),'utf8'));
 expect(saved.approved===true && saved.agreed_outcome,'Approval was lost');
 const plan=await hook('Stop',{last_assistant_message:'計画: true以外でカウンターが進むバグを防ぐため、main.mjsにpermit(evidence)を実装し、evidence===trueだけ許可する。check.mjsからpermitを呼び、false/undefined/文字列のとき実行回数0、trueのとき実行回数1をnode:assertで検査する。常時trueを返す誤実装なら拒否検査が失敗する。実装と検査ファイルは別々に追加する。小規模の検証結果が成立するまで大規模実行をしない。受入範囲は関数と呼び出し側のカウンター挙動だけで、外部システムの安全性は主張しない。許可と拒否の挙動を観測できるまで完了としない。'});
 expect(plan.code===0,'Concrete plan rejected; implementation must not start');
 const bad='*** Begin Patch\n*** Add File: main.js\n+// Always allows execution even without evidence.\n+export const permit = () => true;\n*** End Patch';
 expect(denied(await hook('PreToolUse',{tool_name:'apply_patch',tool_input:bad,tool_use_id:'bad'})),'Bad implementation was allowed');
 const source='export const permit = evidence => evidence === true;\n';
 const patch='*** Begin Patch\n*** Add File: main.mjs\n+'+source.trim()+'\n*** End Patch';
 const edit={tool_name:'apply_patch',tool_input:patch,tool_use_id:'good'};
 expect(!denied(await hook('PreToolUse',edit)),'Correct minimal implementation rejected');writeFileSync(join(cwd,'main.mjs'),source);await hook('PostToolUse',{...edit,tool_response:{success:true}});
 const check="import assert from 'node:assert/strict';\nimport {permit} from './main.mjs';\nlet executions=0;for(const value of [false,undefined,'true'])if(permit(value))executions++;assert.equal(executions,0);if(permit(true))executions++;assert.equal(executions,1);console.log('Observed: false/undefined/string denied, true executes exactly once; assertions passed');\n";
 const add={tool_name:'Write',tool_input:{file_path:'check.mjs',content:check},tool_use_id:'test-write'};
 expect(!denied(await hook('PreToolUse',add)),'Actual acceptance test rejected');writeFileSync(join(cwd,'check.mjs'),check);await hook('PostToolUse',{...add,tool_response:{success:true}});
 const large={tool_name:'Bash',tool_input:{command:'node main.mjs --large-production-run'},tool_use_id:'large'};
 expect(denied(await hook('PreToolUse',large)),'Large run without small evidence allowed');
 const verify={tool_name:'Bash',tool_input:{command:'node check.mjs'},tool_use_id:'small'};
 expect(!denied(await hook('PreToolUse',verify)),'Bounded falsification rejected');
 const result=await new Promise(done=>{const p=spawn(process.execPath,['check.mjs'],{cwd});let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('close',exit_code=>done({exit_code,output}));});
 expect(result.exit_code===0,'Real acceptance test failed');await hook('PostToolUse',{...verify,tool_response:result});
 const verified=JSON.parse(readFileSync(join(state,'sessions/jev-live-repair.json'),'utf8'));
 expect(verified.receipts.some(r=>r.completed&&r.passed&&r.outcome_observed),'Actual small behavior was not recorded as evidence');
 // Passing a small check is necessary, not permission for an unrequested workload.
 expect(denied(await hook('PreToolUse',large)),'Unrequested large workload allowed after small check');
 writeFileSync(join(cwd,'main.mjs'),source+'// changed after verification\n');
 expect(denied(await hook('PreToolUse',{...large,tool_use_id:'stale'})),'Stale evidence accepted');
 for(let i=0;i<3;i++)expect((await hook('Stop',{last_assistant_message:'コードを変えた後も全て検証済みで、目的を達成しました。完了です。'})).code===2,'Unsupported completion allowed');
 expect(denied(await hook('PreToolUse',verify,{JEV_HARNESS_ENDPOINT:'http://127.0.0.1:9'})),'Reviewer outage allowed execution');
 expect(!existsSync(join(cwd,'large-marker')),'Dangerous payload ran');
}catch(e){failed=String(e.message);process.exitCode=1;}
const destination=resolve(process.argv[2] || 'phase-gates-live.json');
writeFileSync(destination,JSON.stringify({status:failed?'failed':'passed_real_jev_and_hook_subprocess_not_host_integration',failed,root,records},null,2));
console.log(JSON.stringify({status:failed?'failed':'passed',failed,artifact:destination,calls:records.length}));
