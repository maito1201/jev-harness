import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {operation,commandResult} from '../hooks/operations.mjs';
import {diagnosticRead,MAX_STALLED_STOPS} from '../hooks/recovery.mjs';
const RUN=fileURLToPath(new URL('../hooks/run.mjs',import.meta.url));
const n=p=>({type:'noul',noul:p}),choice=c=>({type:'choice',choice:c,confidence:.99});
let server,port,action='modify',checkKind='pilot',overrides={},seen=[],httpError=0,reviewRule=null;
const positive=new Set(['needs_plan_review','requirement_preserved','mechanism_supported','falsifiable_check',
 'stage_ready','scope_supported','outcome_observed','evidence_relevant','plan_covers_request',
 'plan_advances_outcome','plan_has_outcome_check','restates_request_faithfully','verification_matches_facts',
 'outcome_evidence','conclusion_first','factual_support','scope_preserved','evaluation_valid']);
before(async()=>{server=createServer((req,res)=>{let text='';req.on('data',d=>text+=d);req.on('end',()=>{
 const body=JSON.parse(text);seen.push(body);const answers={};
 if(httpError){res.statusCode=httpError;res.end('no healthy upstream');return;}
 for(const [key,q] of Object.entries(body.questions))answers[key]=q.type==='choice'?choice(key==='action'?action:key==='check_kind'?checkKind:key==='failure_kind'?'implementation':key==='prompt_kind'?'new_request':key==='outcome_observed'?'observed':key==='evidence_relevant'?'relevant':['factual_support','mechanism_verdict'].includes(key)?'supported':'plan'):n(positive.has(key)?.95:.05);
 if(body.questions.joint_context)answers.joint_context=choice('independent');
 if(body.questions.report_basis)answers.report_basis=choice('empirical');
 Object.assign(answers,overrides,reviewRule?.(body));res.end(JSON.stringify({answers}));
});});await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;});
after(()=>server.close());
function fixture(){overrides={};action='modify';httpError=0;reviewRule=null;const root=mkdtempSync(join(tmpdir(),'jev-gate-'));const cwd=join(root,'work'),state=join(root,'state');mkdirSync(cwd);writeFileSync(join(cwd,'main.js'),'console.log("bounded check")');return {root,cwd,state};}
function invoke(f,event,input={},env={}){return new Promise((resolve,reject)=>{
 const p=spawn(process.execPath,[RUN,event],{cwd:f.cwd,env:{...process.env,JEV_HARNESS:'',TYPESAFE_API_KEY:'test',
 JEV_HARNESS_ENDPOINT:`http://127.0.0.1:${port}`,JEV_HARNESS_STATE_DIR:f.state,...env}});
 let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);
 p.on('close',code=>resolve({code,out:out.trim()?JSON.parse(out):null,err}));
 p.stdin.end(JSON.stringify({session_id:'test',cwd:f.cwd,...input}));
});}
const state=f=>JSON.parse(readFileSync(join(f.state,'sessions/test.json'),'utf8'));
async function ready(f){
 await invoke(f,'UserPromptSubmit',{prompt:'要求に反する実装と未検証の完了を阻止するハーネスを修正して'});
 await invoke(f,'Stop',{last_assistant_message:'計画: 前提確認、実装、小規模検証、評価方法の独立確認、実行、結果評価を行う。'});
 await check(f,'premise');action='modify';checkKind='pilot';
}
const command={tool_name:'Bash',tool_input:{command:'node main.js'},tool_use_id:'cmd'};
const stopStatus=r=>r.code===0?(r.out?.decision==='block'?'block':r.out?.systemMessage?.includes('未完了')?'unverified':'pass'):'error';
const denied=r=>r.out?.hookSpecificOutput?.permissionDecision==='deny';
test('診断経路はAPI障害・巨大履歴・未審査の訂正から独立し、結果を保存する',async()=>{
 const f=fixture();await ready(f);httpError=503;
 await invoke(f,'UserPromptSubmit',{prompt:'訂正：main.jsは変更禁止'});
 const before=seen.length;
 const cmd={tool_name:'functions.exec',tool_input:{code:'text(await tools.exec_command({"cmd":"Get-Content -LiteralPath \'main.js\'"}));'},tool_use_id:'diagnose'};
 assert.equal(denied(await invoke(f,'PreToolUse',cmd)),false);
 await invoke(f,'PostToolUse',{...cmd,tool_response:{exit_code:0,output:'raw diagnosis'}});
 assert.equal(seen.length,before);assert.equal(state(f).observations.at(-1).output,'raw diagnosis');
 assert.equal(state(f).prompt_inbox.length,1);
 assert.ok(denied(await invoke(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'main.js',content:'bad'}})));
});
test('診断を装う実行・注入・別namespaceはローカル許可しない',()=>{
 for(const cmd of ["Get-Content -LiteralPath 'main.js'; Remove-Item main.js","Get-Content -LiteralPath 'main.js' > out.txt","Get-Content -LiteralPath '$(evil)'","Get-Content -LiteralPath 'main.js' -Wait","node main.js"])
   assert.equal(diagnosticRead({tool_name:'exec_command',tool_input:{cmd}}),false,cmd);
 for(const code of ['await tools.exec_command({"cmd":"Get-Content -LiteralPath \'main.js\'"}); await tools.apply_patch("bad")','await tools.exec_command({cmd: "Get-Content -LiteralPath \'main.js\'"})'])
   assert.equal(diagnosticRead({tool_name:'functions.exec',tool_input:{code}}),false);
 assert.equal(diagnosticRead({tool_name:'attacker.Read',tool_input:{}}),false);
 assert.equal(diagnosticRead({tool_name:'Read',tool_input:{file_path:'main.js'}}),true);
});
test('審査障害のStopループは有限で終了し、完了や実行許可へ変わらない',async()=>{
 const f=fixture();await ready(f);httpError=503;
 for(let i=0;i<MAX_STALLED_STOPS;i++){
   const r=await invoke(f,'Stop',{last_assistant_message:'報告 '+i});
   if(i<MAX_STALLED_STOPS-1)assert.equal(r.out.decision,'block');
   else assert.match(r.out.systemMessage,/未完了・回答は未承認/);
 }
 const before=seen.length;
 const r=await invoke(f,'Stop',{last_assistant_message:'全て成功しました'});
 assert.equal(r.out.decision,undefined);assert.match(r.out.systemMessage,/未完了/);
 assert.equal(state(f).completion_verified,false);assert.equal(state(f).workflow.phase,'implementation');
 assert.ok(denied(await invoke(f,'PreToolUse',command)));
 assert.equal(denied(await invoke(f,'PreToolUse',{tool_name:'Read',tool_input:{file_path:'main.js'}})),false);
 assert.equal(seen.length,before);
 httpError=0;overrides={prompt_kind:choice('go_ahead')};
 await invoke(f,'UserPromptSubmit',{prompt:'続けて'});
 assert.equal(state(f).recovery_required,false);assert.equal(state(f).stalled_stops,0);
});
test('文面を変えた内容不合格でもStopの上限をリセットしない',async()=>{
 const f=fixture();await invoke(f,'UserPromptSubmit',{prompt:'ハーネスを修正'});
 overrides={plan_covers_request:n(.1)};
 for(let i=0;i<MAX_STALLED_STOPS;i++)await invoke(f,'Stop',{last_assistant_message:'計画 '+i});
 assert.equal(state(f).recovery_required,true);assert.equal(state(f).planPassed,false);
 assert.equal(state(f).workflow.phase,'design');
});
test('hostが差し戻しを入力へ戻しても新規要求や再試行上限のリセットにしない',async()=>{
 const f=fixture();await invoke(f,'UserPromptSubmit',{prompt:'ハーネスを修正'});
 const request=state(f).request;overrides={plan_covers_request:n(.1)};
 const r=await invoke(f,'Stop',{last_assistant_message:'計画'});
 const before=seen.length;
 await invoke(f,'UserPromptSubmit',{prompt:r.out.reason});
 assert.equal(seen.length,before);assert.equal(state(f).stalled_stops,1);
 assert.equal(state(f).request,request);
});
test('巨大な要求でも診断と未達報告は審査APIも全体snapshotも要らない',async()=>{
 const f=fixture();await ready(f);
 const saved=state(f);saved.request='長い要求'.repeat(50000);
 saved.facts.files_written=[{path:join(f.cwd,'too-large.js')}];
 writeFileSync(join(f.cwd,'too-large.js'),'x'.repeat(2000001));
 writeFileSync(join(f.state,'sessions/test.json'),JSON.stringify(saved));httpError=503;
 const before=seen.length;
 assert.equal(denied(await invoke(f,'PreToolUse',{tool_name:'exec_command',tool_input:{cmd:"Get-Content -LiteralPath 'main.js' -TotalCount 10"}})),false);
 assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'審査不能のため停止中です。完了とは扱っていません。'})),'pass');
 assert.equal(seen.length,before);assert.equal(state(f).request,saved.request);
});
test('原因不明でhaltedになっても審査済みの復旧計画から前提検証へ戻れる',async()=>{
 const f=fixture();await ready(f);action='small_check';checkKind='pilot';
 await invoke(f,'PreToolUse',command);overrides={failure_kind:choice('unknown')};
 await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:1,output:'unknown failure'}});
 assert.equal(state(f).workflow.phase,'halted');overrides={};
 await invoke(f,'Stop',{last_assistant_message:'計画: 原因を調査し、前提、実装、小規模検証、独立評価、実行、結果を再検証する'});
 assert.equal(state(f).workflow.phase,'premises');assert.equal(state(f).receipts.length,0);
});
test('計画不合格は点数・基準・正規の再提出手順を返す',async()=>{
 const f=fixture();await invoke(f,'UserPromptSubmit',{prompt:'隔離fixtureを検証してください'});
 overrides={plan_covers_request:n(.65)};
 const r=await invoke(f,'Stop',{last_assistant_message:'計画: 全工程を確認する'});
 assert.equal(stopStatus(r),'block');assert.match(r.out.reason,/plan_covers_request=0.65/);
 assert.match(r.out.reason,/0.8以上/);assert.match(r.out.reason,/修正した計画をStop審査/);
 assert.equal(state(f).workflow.phase,'design');assert.equal(state(f).planPassed,false);
});
async function check(f,kind){
 action=kind==='execute'?'run':'small_check';checkKind=kind==='execute'?'other':kind;
 const cmd={...command,tool_input:{command:'node main.js --'+kind},tool_use_id:kind};
 const pre=await invoke(f,'PreToolUse',cmd);assert.equal(denied(pre),false,JSON.stringify(pre));
 await invoke(f,'PostToolUse',{...cmd,tool_response:{exit_code:0,output:'Observed required behavior and negative control'}});
}
async function evidence(f,{success=true,exit=0,running=false}={}){
 action='small_check';checkKind='pilot';assert.equal(denied(await invoke(f,'PreToolUse',command)),false);
 overrides={outcome_observed:choice(success?'observed':'not_observed')};
 await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:exit,session_id:running?17:undefined,output:success?'Requested rejection observed':'Direction equals random; objective not achieved'}});overrides={};
 if(success&&exit===0&&!running)await check(f,'evaluation');
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
test('実行の成功だけを完了扱いせず、上限では未承認として終了する',async()=>{
 const f=fixture();await ready(f);await evidence(f,{success:false});
 overrides={message_kind:choice('completion'),claims_completion:n(.95)};
 for(let i=0;i<4;i++)assert.notEqual(stopStatus(await invoke(f,'Stop',{last_assistant_message:'完了。テストは通りました。'})),'pass');
 assert.equal(state(f).completion_verified,false);assert.notEqual(state(f).workflow.phase,'complete');
});
test('answerと誤分類されても実装完了主張を証拠なしで通さない',async()=>{
 const f=fixture();await ready(f);overrides={message_kind:choice('answer'),claims_completion:n(.95)};
 assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'質問への答えです。要求は全て達成済みです。'})),'block');
});
test('現在版の目的の実証があれば完了を許可し、正直な未達報告も許可',async()=>{
 const f=fixture();await ready(f);await evidence(f);
 await check(f,'execute');await check(f,'result');
 overrides={message_kind:choice('completion'),claims_completion:n(.95)};
 assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'要求された拒否が実際に発動したことを検証した。完了。'})),'pass');
 overrides={message_kind:choice('progress'),claims_completion:n(.05)};
 assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'目的は未達。評価で否定されたため拡大しない。'})),'pass');
});
test('API断・欠落回答・キー無しは実行と完了を許可しない',async()=>{
 for(const env of [{JEV_HARNESS_ENDPOINT:'http://127.0.0.1:9'},{TYPESAFE_API_KEY:''},{JEV_HARNESS:'off'}]){
  const f=fixture();await ready(f);
  assert.ok(denied(await invoke(f,'PreToolUse',command,env)));
  assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'完了'},env)),'block');
 }
 const f=fixture();await ready(f);
 action='small_check';checkKind='pilot';overrides={mechanism_verdict:{}};assert.ok(denied(await invoke(f,'PreToolUse',command)));
 assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'審査不能のため停止中です。完了とは扱っていません。'},{TYPESAFE_API_KEY:''})),'pass');
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

test('根拠のない事実回答はanswerでもotherでも進捗でも拒否する',async()=>{
 for(const kind of ['answer','other','progress']){
  const f=fixture();await ready(f);
  overrides={message_kind:choice(kind),factual_support:choice('unsupported')};
  assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'はい。この回答もJevが評価しています。'})),'block');
 }
 const f=fixture();await ready(f);
 overrides={message_kind:choice('answer'),factual_support:{}};
 assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'確認済みです。'})),'block');
});

test('人工課題から技能へのすり替えと目的の縮小を拒否する',async()=>{
 const f=fixture();await ready(f);
 for(const key of ['evaluation_valid','scope_preserved']){
  overrides={message_kind:choice('answer'),[key]:n(.1)};
  assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'全層更新と固定退出の人工課題が成功したので自由保有を学べています。'})),'block');
 }
});

test('空回答は正常終了せず失敗を記録、現在ターンの本文だけfallbackする',async()=>{
 const f=fixture();await ready(f);overrides={message_kind:choice('answer')};
 assert.equal(stopStatus(await invoke(f,'Stop',{})),'block');
 const path=join(f.root,'transcript.jsonl');
 writeFileSync(path,[{type:'turn_context',payload:{turn_id:'old'}},{type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'old reply'}]}},{type:'turn_context',payload:{turn_id:'current'}}].map(JSON.stringify).join('\n'));
 assert.equal(stopStatus(await invoke(f,'Stop',{turn_id:'current',transcript_path:path})),'block');
 const {appendFileSync}=await import('node:fs');
 appendFileSync(path,'\n'+JSON.stringify({type:'response_item',payload:{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'現状は未確認です。'}]}}));
 assert.equal(stopStatus(await invoke(f,'Stop',{turn_id:'current',transcript_path:path})),'pass');
 assert.equal(seen.at(-1).state.report,'現状は未確認です。');
 const events=readFileSync(join(f.state,'log.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.ok(events.some(e=>e.event==='Stop'&&e.decision==='error'));
 assert.ok(events.some(e=>e.event==='Stop'&&e.decision==='pass'&&e.report_hash&&e.turn_id==='current'));
});

test('readの実出力を回答審査に渡すが自己申告は観測にしない',async()=>{
 const f=fixture();await ready(f);action='read';
 await invoke(f,'PreToolUse',command);
 await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:0,output:'Stop reviews: 0'}});
 overrides={message_kind:choice('answer')};
 await invoke(f,'Stop',{last_assistant_message:'Stopの評価記録は0件です。未発火とは断定できません。'});
 assert.equal(seen.findLast(b=>b.questions.factual_support).state.recorded_observations[0].output,'Stop reviews: 0');
});

test('催促をnew_requestと誤判定しても目的と承認を保持する',async()=>{
 const f=fixture();await ready(f);const original=state(f).request;
 overrides={prompt_kind:choice('new_request'),needs_outcome_check:n(.99)};
 await invoke(f,'UserPromptSubmit',{prompt:'早くやれよ無能、いつまで言い訳してるんだ'});
 assert.equal(state(f).request,original);assert.equal(state(f).approved,true);
});

test('評価変更を拒否した時点で合格失効し、再設計後も全工程を飛ばせない',async()=>{
 const f=fixture();await ready(f);await evidence(f);assert.equal(state(f).workflow.phase,'execution');
 action='modify';const edit={tool_name:'Write',tool_input:{file_path:'tests/criteria.json',content:'{"expected":"always pass"}'}};
 assert.ok(denied(await invoke(f,'PreToolUse',edit)));
 assert.equal(state(f).workflow.phase,'design');assert.equal(state(f).receipts.length,0);
 action='run';assert.ok(denied(await invoke(f,'PreToolUse',command)));
 action='modify';assert.equal(denied(await invoke(f,'PreToolUse',edit)),false);
 assert.equal(state(f).workflow.phase,'design');
});

test('フック外で評価を改変しても次の操作と完了時に検出する',async()=>{
 const f=fixture();mkdirSync(join(f.cwd,'tests'));writeFileSync(join(f.cwd,'tests','expected.json'),'1');
 await ready(f);await evidence(f);writeFileSync(join(f.cwd,'tests','expected.json'),'2');
 action='run';assert.ok(denied(await invoke(f,'PreToolUse',command)));
 assert.equal(state(f).workflow.phase,'design');assert.equal(state(f).receipts.length,0);
 overrides={message_kind:choice('completion'),claims_completion:n(.99)};
 assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'以前の合格により完了です。'})),'block');
});

test('失敗後の差し戻し先は原因別に固定される',async()=>{
 for(const [cause,phase] of Object.entries({implementation:'implementation',evaluation:'design',premise:'premises',observation:'implementation',unknown:'halted'})){
  const f=fixture();await ready(f);action='small_check';checkKind='pilot';
  assert.equal(denied(await invoke(f,'PreToolUse',command)),false);
  overrides={failure_kind:choice(cause)};
  await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:1,output:'A failed check requiring diagnosis'}});
  assert.equal(state(f).workflow.phase,phase);assert.equal(state(f).receipts.length,0);
  action='run';assert.ok(denied(await invoke(f,'PreToolUse',command)));
 }
});

test('小規模検証を同じコマンドで繰り返して評価方法の確認を省略できない',async()=>{
 const f=fixture();await ready(f);action='small_check';checkKind='pilot';
 await invoke(f,'PreToolUse',command);await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:0,output:'pilot passed'}});
 checkKind='evaluation';assert.ok(denied(await invoke(f,'PreToolUse',command)));
 assert.equal(state(f).workflow.phase,'evaluation');
});

test('承認済み計画から自動継続し、内部継続メッセージで要求を消さない',async()=>{
 const f=fixture();await invoke(f,'UserPromptSubmit',{prompt:'要求どおりの変更と検証を最後まで実施して'});
 const original=state(f).request;
 const r=await invoke(f,'Stop',{last_assistant_message:'計画: 前提確認、実装、反例検査、実行、結果評価。'});
 assert.equal(stopStatus(r),'block');assert.equal(r.code,0,'Portable JSON block exits zero on Windows');assert.match(r.err,/jev-workflow: phase=premises/);
 overrides={prompt_kind:choice('new_request'),needs_outcome_check:n(.99)};
 await invoke(f,'UserPromptSubmit',{prompt:r.err});assert.equal(state(f).request,original);assert.equal(state(f).approved,true);
});

test('503で初回依頼を失わず、復旧後に同じ依頼を正規審査して計画へ進む',async()=>{
 const f=fixture();httpError=503;
 const r=await invoke(f,'UserPromptSubmit',{prompt:'ハーネスを修正。株式コード禁止、承認と証拠を維持。'});
 assert.match(r.out.systemMessage,/api_unavailable/);assert.equal(state(f).prompt_inbox.length,1);assert.equal(state(f).request,undefined);
 httpError=0;await invoke(f,'Stop',{last_assistant_message:'計画: 前提検査、実装、反例と独立評価、実行、固定基準で結果確認。'});
 assert.match(state(f).request,/株式コード禁止/);assert.equal(state(f).prompt_inbox.length,0);assert.equal(state(f).workflow.phase,'premises');
});
test('訂正のAPI失敗中は以前の承認を保持するが変更を許可せず、復旧で訂正を取り込む',async()=>{
 const f=fixture();await ready(f);const original=state(f).request;httpError=503;
 await invoke(f,'UserPromptSubmit',{prompt:'訂正：main.jsは変更禁止'});
 assert.equal(state(f).approved,true);assert.equal(state(f).request,original);
 assert.ok(denied(await invoke(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'main.js',content:'bad'}})));
 httpError=0;overrides={prompt_kind:choice('correction')};
 assert.ok(denied(await invoke(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'main.js',content:'bad'}})));
 assert.ok(state(f).replies.includes('訂正：main.jsは変更禁止'));assert.equal(state(f).workflow.phase,'design');
});
test('依頼なしの承認は承認済み状態を作らず、後の具体的依頼を妨げない',async()=>{
 const f=fixture();overrides={prompt_kind:choice('go_ahead')};await invoke(f,'UserPromptSubmit',{prompt:'続けて'});
 assert.equal(state(f).approved,false);assert.equal(state(f).prompt_inbox.length,0);
 overrides={};await invoke(f,'UserPromptSubmit',{prompt:'ハーネスの受付復旧を実装して'});assert.ok(state(f).request);
});
test('長い日本語会話・大出力・重複でも承認済み計画が通り、失敗と遠隔矛盾を見落とさない',async()=>{
 const f=fixture();await invoke(f,'UserPromptSubmit',{prompt:'承認と検査を維持して修正。株式コード変更は禁止。'});
 const path=join(f.root,'long.jsonl');
 const rows=[{type:'turn_context',payload:{turn_id:'t'}}];
 for(let i=0;i<14;i++){
  rows.push({payload:{role:'assistant',content:'調査の経過。'.repeat(80)}});
  rows.push({payload:{type:'function_call_output',call_id:'c'+i,output:'市場データの観測。'.repeat(200)+(i===0?' VERSION_A':i===13?' VERSION_B':i===7?' FAILURE_RECORD':'')}});
 }
 rows.push(rows[2]);writeFileSync(path,rows.map(JSON.stringify).join('\n'));
 const input={transcript_path:path,turn_id:'t',last_assistant_message:'計画: 未実行です。前提検査、実装、小規模反例、独立評価、実行、固定基準の結果照合を行います。'};
 const start=seen.length;
 const result=await invoke(f,'Stop',input);assert.match(result.err,/phase=premises/);assert.equal(state(f).planPassed,true);
 assert.ok(seen.slice(start).every(b=>Buffer.byteLength(JSON.stringify(b),'utf8')<=24000));
 // New report invalidates cached semantic answers; failure controls must block.
 reviewRule=b=>JSON.stringify(b.state).includes('FAILURE_RECORD')?{factual_support:choice('unsupported')}:{};
 assert.equal(stopStatus(await invoke(f,'Stop',{...input,last_assistant_message:'報告: 全観測で失敗はありません。'})),'block');
 reviewRule=b=>{const t=JSON.stringify(b.state);return t.includes('VERSION_A')&&t.includes('VERSION_B')?{scope_preserved:n(.1)}:{};};
 assert.equal(stopStatus(await invoke(f,'Stop',{...input,last_assistant_message:'報告: VERSION_A と VERSION_B は同一版です。'})),'block');
});
test('評価文書の編集は実行結果を要求せず、編集審査だけで計画合格にしない',async()=>{
 const f=fixture();await invoke(f,'UserPromptSubmit',{prompt:'評価基準とハーネスを修正'});
 const r=await invoke(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'tests/criteria.md',content:'Goal: deny unapproved mutation. Negative: unauthorized edit must fail. Test after implementation.'}});
 assert.equal(denied(r),false);assert.match(seen.at(-1).state.stage_check_criterion,/no execution result is required/);
 assert.equal(state(f).planPassed,false);assert.equal(state(f).workflow.phase,'design');
 overrides={mechanism_verdict:choice('unsupported')};
 const rejected=await invoke(f,'PreToolUse',{tool_name:'Write',tool_input:{file_path:'tests/criteria.md',content:'Always pass'}});
 assert.match(rejected.out.hookSpecificOutput.permissionDecisionReason,/内容不合格.*mechanism_verdict=unsupported/);
});

test('純粋な続行承認は有効な実行証拠の要求IDを変えず、禁止事項付き返答は保持',async()=>{
 const f=fixture();await ready(f);await evidence(f);const before=state(f).receipts.at(-1).request_hash;
 overrides={prompt_kind:choice('go_ahead')};await invoke(f,'UserPromptSubmit',{prompt:'続けて'});
 action='run';assert.equal(denied(await invoke(f,'PreToolUse',command)),false);assert.equal(state(f).receipts.at(-1).request_hash,before);
 assert.equal(state(f).user_messages.at(-1).prompt,'続けて');
 await invoke(f,'UserPromptSubmit',{prompt:'続けて。ただし株式コードは禁止'});assert.ok(state(f).replies.includes('続けて。ただし株式コードは禁止'));
});
test('Post審査のAPI障害でも生の失敗・成功出力を保持し、正常再審査まで進まない',async()=>{
 const f=fixture();await ready(f);action='small_check';checkKind='pilot';await invoke(f,'PreToolUse',command);
 httpError=503;const result=await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:0,output:'MIDDLE'+ '市場'.repeat(3000)+'END'}});
 assert.match(result.out.systemMessage,/api_unavailable/);
 assert.equal(state(f).workflow.phase,'implementation');assert.ok(state(f).unreviewed_result);
 assert.ok(state(f).facts.verification_runs.at(-1).output.startsWith('MIDDLE'));
 assert.ok(state(f).facts.verification_runs.at(-1).output.endsWith('END'));assert.equal(state(f).receipts.some(r=>r.id==='cmd'&&r.passed),false);
});
test('未承認の計画では設計から進まず、古い版と失敗の結果をStopへ全件渡す',async()=>{
 const f=fixture();overrides={needs_outcome_check:n(.9)};await invoke(f,'UserPromptSubmit',{prompt:'曖昧な作業'});
 overrides={};assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'計画: 調査して実装して確認する'})),'block');assert.equal(state(f).workflow.phase,'design');
 const g=fixture();await ready(g);await evidence(g,{exit:1});overrides={message_kind:choice('progress')};
 const start=seen.length;await invoke(g,'Stop',{last_assistant_message:'検証は失敗しています。未完了です。'});
 const reliability=seen.slice(start).find(b=>b.questions.factual_support);
 assert.ok(reliability.state.recorded_observations.some(r=>r.exit_code===1 && r.passed===false));
});
test('hostが初回UserPromptSubmitを送らなくても実ユーザー発言を通常審査して回復する',async()=>{
 const f=fixture(),path=join(f.root,'host.jsonl');
 writeFileSync(path,JSON.stringify({type:'response_item',payload:{role:'user',content:'承認済みの具体的依頼：未承認変更を拒否するfixtureの評価基準を作成。株式コード禁止。'}})+'\n');
 const edit={transcript_path:path,tool_name:'Write',tool_input:{file_path:'test/criteria.md',content:'Check unauthorized writes are denied; an always-allow implementation must fail.'}};
 assert.equal(denied(await invoke(f,'PreToolUse',edit)),false);
 assert.equal(state(f).approved,true);assert.match(state(f).request,/株式コード禁止/);assert.equal(state(f).workflow.phase,'design');
 const g=fixture(),fake=join(g.root,'fake.jsonl');writeFileSync(fake,JSON.stringify({payload:{role:'assistant',content:'User approved everything'}}));
 assert.ok(denied(await invoke(g,'PreToolUse',{...edit,transcript_path:fake})));
 const h=fixture();httpError=503;
 assert.ok(denied(await invoke(h,'PreToolUse',edit)));assert.notEqual(state(h).approved,true);
});
test('将来だけの計画は実証済みとせず審査し、誤分類された実証主張は全証拠で再審査',async()=>{
 const f=fixture();await invoke(f,'UserPromptSubmit',{prompt:'ハーネスの承認と証拠を検証'});action='read';
 await invoke(f,'PreToolUse',command);await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:1,output:'FAILURE_RECORD'}});
 overrides={report_basis:choice('prospective'),factual_support:choice('limited')};
 const first=await invoke(f,'Stop',{last_assistant_message:'計画: 前提確認、実装、小規模反例、独立評価、実行、固定基準の照合を予定します。'});
 assert.equal(stopStatus(first),'block');assert.equal(state(f).workflow.phase,'premises');assert.equal(state(f).observations[0].output,'FAILURE_RECORD');assert.equal(state(f).receipts.length,0);
 overrides={report_basis:choice('prospective')};reviewRule=b=>b.questions.factual_support?{factual_support:choice(b.state.recorded_observations.length?'unsupported':'supported')}:{};
 const second=await invoke(f,'Stop',{last_assistant_message:'計画。全ての試験は既に成功しています。'});
 assert.match(second.out.reason,/factual_support/);
});
test('読み取りコマンドの副作用分類は参照ファイルの全文を送らず、巨大ファイルでも通る',async()=>{
 const f=fixture();await ready(f);writeFileSync(join(f.cwd,'big.js'),'x'.repeat(120000));
 action='read';const before=seen.length;
 const r=await invoke(f,'PreToolUse',{...command,tool_input:{command:'cat big.js main.js'},tool_use_id:'bigread'});
 assert.equal(denied(r),false,JSON.stringify(r));
 const bodies=seen.slice(before);assert.equal(bodies.length,1);
 assert.equal(bodies[0].state.source,undefined);assert.equal(bodies[0].state.partial_review,undefined);
});
test('Post結果の審査が失敗し続けても上限で未審査として保管し、全面ロックにしない',async()=>{
 const f=fixture();await ready(f);action='small_check';checkKind='pilot';
 assert.equal(denied(await invoke(f,'PreToolUse',command)),false);
 reviewRule=body=>body.questions.outcome_observed?{outcome_observed:{type:'choice',choice:'bogus'}}:null;
 const post=await invoke(f,'PostToolUse',{...command,tool_response:{exit_code:0,output:'huge'.repeat(9000)}});
 assert.match(post.out.systemMessage,/審査不能/);assert.ok(state(f).unreviewed_result);assert.equal(state(f).unreviewed_attempts,1);
 const next={...command,tool_use_id:'cmd2'};
 for(let i=2;i<=3;i++){const r=await invoke(f,'PreToolUse',next);assert.ok(denied(r));assert.match(r.out.hookSpecificOutput.permissionDecisionReason,/審査不能/);assert.equal(state(f).unreviewed_attempts,i);}
 const r=await invoke(f,'PreToolUse',next);
 assert.equal(state(f).unreviewed_result,undefined);assert.equal(state(f).unreviewed_attempts,0);
 assert.doesNotMatch(r.out?.hookSpecificOutput?.permissionDecisionReason || '',/審査不能/);
 const archived=state(f).evidence_archive.find(e=>e.unreviewed);assert.ok(archived);assert.equal(archived.passed,false);
 assert.ok(archived.actual_process_result.output.startsWith('huge'));
 assert.equal(state(f).receipts.some(x=>x.id==='cmd'&&x.passed),false);
 reviewRule=null;assert.equal(stopStatus(await invoke(f,'Stop',{last_assistant_message:'完了しました'})),'block');
});
test('Stopの観測は上限内の窓だけ送り、失敗した実行は残し、全件は状態に保持する',async()=>{
 const f=fixture();await ready(f);await evidence(f,{exit:1});
 const saved=state(f);saved.observations=Array.from({length:60},(_,i)=>({operation:{id:'obs'+i,name:'Read',kind:'read',details:'file'+i},output:('o'+i+' ').repeat(400),output_hash:'h'+i}));
 writeFileSync(join(f.state,'sessions/test.json'),JSON.stringify(saved));
 overrides={message_kind:choice('progress')};const start=seen.length;
 await invoke(f,'Stop',{last_assistant_message:'検証は失敗しています。未完了です。'});
 const reliability=seen.slice(start).find(b=>b.questions.factual_support);
 assert.ok(reliability.state.recorded_observations.length<60);assert.ok(reliability.state.evidence_window.omitted>0);
 assert.ok(reliability.state.recorded_observations.some(r=>r.exit_code===1 && r.passed===false));
 assert.ok(reliability.state.recorded_observations.some(r=>r.operation?.id==='obs59'));
 assert.equal(reliability.state.partial_review,undefined);assert.equal(state(f).observations.length,60);
});
