// Replay a COPY of an incident session, offline. Never modify production state.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const original=process.argv[2];
if(!original)throw new Error('usage: node eval/recovery-replay.mjs INCIDENT_SESSION_JSON [PLUGIN_ROOT]');
const root=mkdtempSync(join(tmpdir(),'jev-recovery-replay-'));
const stateDir=join(root,'state'),cwd=join(root,'work');
mkdirSync(join(stateDir,'sessions'),{recursive:true});mkdirSync(cwd);
const originalBytes=readFileSync(original),session=JSON.parse(originalBytes);
writeFileSync(join(stateDir,'sessions','replay.json'),originalBytes);
writeFileSync(join(cwd,'diagnosis.txt'),'diagnostic fixture');
const run=process.argv[3]?resolve(process.argv[3],'hooks/run.mjs'):fileURLToPath(new URL('../hooks/run.mjs',import.meta.url));
function invoke(event,extra){
 const r=spawnSync(process.execPath,[run,event],{cwd,encoding:'utf8',timeout:10000,
  env:{...process.env,TYPESAFE_API_KEY:'',JEV_HARNESS_ENDPOINT:'http://127.0.0.1:9',JEV_HARNESS_STATE_DIR:stateDir},
  input:JSON.stringify({session_id:'replay',cwd,...extra})});
 assert.equal(r.status,0,r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):null;
}
const diagnostic={tool_name:'exec_command',tool_input:{cmd:"Get-Content -LiteralPath 'diagnosis.txt'"},tool_use_id:'offline-read'};
assert.equal(invoke('PreToolUse',diagnostic)?.hookSpecificOutput?.permissionDecision,undefined);
invoke('PostToolUse',{...diagnostic,tool_response:{exit_code:0,output:'diagnostic fixture'}});
const stops=[];
for(let i=0;i<3;i++)stops.push(invoke('Stop',{last_assistant_message:'未完了の調査報告 '+i}));
assert.match(stops.at(-1).systemMessage,/未完了・回答は未承認/);
assert.equal(invoke('PreToolUse',{tool_name:'Write',tool_input:{file_path:'main.js',content:'bad'}}).hookSpecificOutput.permissionDecision,'deny');
const after=JSON.parse(readFileSync(join(stateDir,'sessions/replay.json')));
assert.equal(after.request,session.request);assert.deepEqual(after.prompt_inbox,session.prompt_inbox);
assert.equal(after.completion_verified,false);assert.deepEqual(readFileSync(original),originalBytes);
console.log(JSON.stringify({incident:resolve(original),copied_state:root,offline_diagnosis:true,bounded_stop:true,mutation_denied:true,request_and_queue_preserved:true,production_unchanged:true}));
