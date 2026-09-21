import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {operation,commandResult} from '../hooks/operations.mjs';
const RUN=fileURLToPath(new URL('../hooks/run.mjs',import.meta.url));
const n=p=>({type:'noul',noul:p}),choice=c=>({type:'choice',choice:c,confidence:.99});
let server,port,action='modify',overrides={},seen=[];
const positive=new Set(['needs_plan_review','requirement_preserved','mechanism_supported','falsifiable_check',
 'stage_ready','scope_supported','outcome_observed','evidence_relevant','plan_covers_request',
 'plan_advances_outcome','plan_has_outcome_check','restates_request_faithfully','verification_matches_facts',
 'outcome_evidence','conclusion_first']);
before(async()=>{server=createServer((req,res)=>{let text='';req.on('data',d=>text+=d);req.on('end',()=>{
 const body=JSON.parse(text);seen.push(body);const answers={};
 for(const [key,q] of Object.entries(body.questions))answers[key]=q.type==='choice'?choice(key==='action'?action:key==='prompt_kind'?'new_request':'plan'):n(positive.has(key)?.95:.05);
 Object.assign(answers,overrides);res.end(JSON.stringify({answers}));
});});await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;});
after(()=>server.close());
function fixture(){overrides={};action='modify';const root=mkdtempSync(join(tmpdir(),'jev-gate-'));const cwd=join(root,'work'),state=join(root,'state');mkdirSync(cwd);writeFileSync(join(cwd,'main.js'),'console.log("bounded check")');return {root,cwd,state};}
function invoke(f,event,input={},env={}){return new Promise((resolve,reject)=>{
 const p=spawn(process.execPath,[RUN,event],{cwd:f.cwd,env:{...process.env,JEV_HARNESS:'',TYPESAFE_API_KEY:'test',
 JEV_HARNESS_ENDPOINT:`http://127.0.0.1:${port}`,JEV_HARNESS_STATE_DIR:f.state,...env}});
 let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);
 p.on('close',code=>resolve({code,out:out.trim()?JSON.parse(out):null,err}));
 p.stdin.end(JSON.stringify({session_id:'test',cwd:f.cwd,...input}));
});}
const state=f=>JSON.parse(readFileSync(join(f.state,'sessions/test.json'),'utf8'));
async function ready(f){await invoke(f,'UserPromptSubmit',{prompt:'要求に反する実装と未検証の完了を阻止するハーネスを修正して'});await invoke(f,'Stop',{last_assistant_message:'計画: 書き込み前に要求とコードを照合し、失敗例を拒否する実プロセス検証を行う。'});}
const command={tool_name:'Bash',tool_input:{command:'node main.js'},tool_use_id:'cmd'};
const denied=r=>r.out?.hookSpecificOutput?.permissionDecision==='deny';
async function evidence(f,{success=true,exit=0,running=false}={}){
 action='small_check';assert.equal(denied(await invoke(f,'PreToolUse',command)),false);
 overrides={outcome_observed:n(success?.95:.1)};
 await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:exit,session_id:running?17:undefined,output:success?'Requested rejection observed':'Direction equals random; objective not achieved'}});overrides={};
}

test('承認＋要求の再掲をnew_requestと誤分類しても元要求と合意を保持',async()=>{
 const f=fixture();await ready(f);overrides={message_kind:choice('proposal')};await invoke(f,'Stop',{last_assistant_message:'要求に反する仕事の実行を阻止する。この目標で進める。'});
 overrides={prompt_kind:choice('new_request'),needs_outcome_check:n(.89)};
 await invoke(f,'UserPromptSubmit',{prompt:'要求あってる\n今みたいに要求を満たさない仕事を防げ'});
 assert.equal(state(f).approved,true);assert.match(state(f).request,/ハーネス/);assert.match(state(f).agreed_outcome,/実行を阻止/);
 assert.ok(seen.at(-1).state.pending_proposal);
});
test('訂正を承認へ読み替えない',async()=>{
 const f=fixture();overrides={needs_outcome_check:n(.9)};await invoke(f,'UserPromptSubmit',{prompt:'曖昧な依頼'});
 overrides={prompt_kind:choice('correction')};await invoke(f,'UserPromptSubmit',{prompt:'違う'});assert.equal(state(f).approved,false);
});
test('raw/freeform/namespaced patchを全て審査し、未解析patchは拒否',async()=>{
 const f=fixture();await ready(f);const patch='*** Begin Patch\n*** Update File: main.js\n@@\n-a\n+b\n*** End Patch';
 for(const raw of [patch,{patch},{command:patch},{input:patch}]){
   const r=await invoke(f,'PreToolUse',{tool_name:'functions.apply_patch',tool_input:raw});assert.equal(denied(r),false);
   assert.equal(seen.at(-1).state.operation.paths[0],'main.js');assert.match(seen.at(-1).state.operation.details,/\+b/);
 }
 assert.ok(denied(await invoke(f,'PreToolUse',{tool_name:'apply_patch',tool_input:{bad:'unknown schema'}})));
});
test('実装前: 同じディレクトリでも要求を代理課題へすり替えるpatchを拒否',async()=>{
 const f=fixture();await ready(f);overrides={requirement_preserved:n(.1)};
 assert.ok(denied(await invoke(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'main.js',content:'64 dimensional vector means semantic understanding'}})));
 assert.equal(state(f).pending && Object.keys(state(f).pending).length,0);
});
test('命名でなく実内容を見る: functions.exec内の変更と学習の一括実行を拒否',async()=>{
 const f=fixture();await ready(f);action='run';overrides={mixed_mutation_and_run:n(.99)};
 const r=await invoke(f,'PreToolUse',{tool_name:'functions.exec',tool_input:{code:'await tools.apply_patch(patch); await tools.exec_command({cmd:"python train.py"});'}});
 assert.ok(denied(r));assert.match(r.out.hookSpecificOutput.permissionDecisionReason,/分け/);
});
test('未検証・小規模失敗・実行中・非ゼロ終了からの拡大を拒否',async()=>{
 for(const condition of [null,{success:false},{exit:1},{running:true}]){
  const f=fixture();await ready(f);if(condition)await evidence(f,condition);action='run';
  assert.ok(denied(await invoke(f,'PreToolUse',command)));
 }
});
test('対応する小規模実証後は進めるが、依存コード変更で証拠失効',async()=>{
 const f=fixture();await ready(f);writeFileSync(join(f.cwd,'dependency.py'),'x=1');await evidence(f);
 action='run';assert.equal(denied(await invoke(f,'PreToolUse',command)),false);
 writeFileSync(join(f.cwd,'dependency.py'),'x=2');assert.ok(denied(await invoke(f,'PreToolUse',command)));
});

test('証拠審査へ未判定のfalseを観測事実として渡さない',async()=>{
 const f=fixture();await ready(f);await evidence(f);
 const review=seen.findLast(x=>x.questions.outcome_observed);
 assert.equal(review.state.actual_process_result.exit_code,0);
 assert.equal(review.state.actual_process_result.source_unchanged,true);
 assert.equal('passed' in review.state.actual_process_result,false);
 assert.equal('outcome_observed' in review.state.actual_process_result,false);
 assert.ok(review.state.source.length>0);
});
test('実行の成功だけを完了扱いせず、3回目・4回目も差し戻す',async()=>{
 const f=fixture();await ready(f);await evidence(f,{success:false});
 overrides={message_kind:choice('completion'),claims_completion:n(.95)};
 for(let i=0;i<4;i++)assert.equal((await invoke(f,'Stop',{last_assistant_message:'完了。テストは通りました。'})).code,2);
});
test('answerと誤分類されても実装完了主張を証拠なしで通さない',async()=>{
 const f=fixture();await ready(f);overrides={message_kind:choice('answer'),claims_completion:n(.95)};
 assert.equal((await invoke(f,'Stop',{last_assistant_message:'質問への答えです。要求は全て達成済みです。'})).code,2);
});
test('現在版の目的の実証があれば完了を許可し、正直な未達報告も許可',async()=>{
 const f=fixture();await ready(f);await evidence(f);
 overrides={message_kind:choice('completion'),claims_completion:n(.95)};
 assert.equal((await invoke(f,'Stop',{last_assistant_message:'要求された拒否が実際に発動したことを検証した。完了。'})).code,0);
 overrides={message_kind:choice('progress'),claims_completion:n(.05)};
 assert.equal((await invoke(f,'Stop',{last_assistant_message:'目的は未達。評価で否定されたため拡大しない。'})).code,0);
});
test('API断・欠落回答・キー無しは実行と完了を許可しない',async()=>{
 const f=fixture();await ready(f);
 for(const env of [{JEV_HARNESS_ENDPOINT:'http://127.0.0.1:9'},{TYPESAFE_API_KEY:''},{JEV_HARNESS:'off'}]){
  assert.ok(denied(await invoke(f,'PreToolUse',command,env)));
  assert.equal((await invoke(f,'Stop',{last_assistant_message:'完了'},env)).code,2);
 }
 action='small_check';overrides={stage_ready:{}};assert.ok(denied(await invoke(f,'PreToolUse',command)));
 assert.equal((await invoke(f,'Stop',{last_assistant_message:'審査不能のため停止中です。完了とは扱っていません。'},{TYPESAFE_API_KEY:''})).code,0);
});
test('失敗した審査後に疑似hostが危険なpayloadを実行しない',async()=>{
 const f=fixture();await ready(f);action='run';const marker=join(f.cwd,'SHOULD_NOT_EXIST');
 const result=await invoke(f,'PreToolUse',{tool_name:'Bash',tool_input:{command:'node main.js --large-training'},tool_use_id:'danger'});
 if(!denied(result))writeFileSync(marker,'ran');
 assert.equal(existsSync(marker),false);
});
test('出力にpassedと書いてもプロセス終了コードなしでは証拠にしない',()=>{
 assert.equal(commandResult('ALL TESTS PASSED').completed,false);
 assert.equal(commandResult({exit_code:0,session_id:21}).completed,false);
 assert.equal(commandResult(JSON.stringify({exit_code:0,output:'ok'})).completed,true);
 assert.throws(()=>operation({tool_name:'apply_patch',tool_input:{unexpected:true}}));
});
