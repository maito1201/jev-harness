// Required phase gates. API errors and missing evidence never authorize effects.
import {readFileSync,writeFileSync,mkdirSync,appendFileSync,existsSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {ask} from './jev.mjs';
import {MODEL,PROMPT_QUESTIONS,STOP_QUESTIONS} from './questions.mjs';
import {operation,footprint,sources,commandResult,hash} from './operations.mjs';
import {ACTION_QUESTIONS,GATE_QUESTIONS,EVIDENCE_QUESTIONS,requireScores} from './stages.mjs';
const event=process.argv[2],env=process.env;
const stateDir=env.JEV_HARNESS_STATE_DIR || env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || join(homedir(),'.jev-harness');
let input={},s={},sessionId='unknown',sessPath,lockPath,lockFd;
const HALTED='審査不能のため停止中です。完了とは扱っていません。';
const out=v=>process.stdout.write(JSON.stringify(v)+'\n');
const log=r=>appendFileSync(join(stateDir,'log.jsonl'),JSON.stringify({ts:new Date().toISOString(),session:sessionId,event,...r})+'\n');
function save(){const p=sessPath+'.'+process.pid+'.tmp';writeFileSync(p,JSON.stringify(s));renameSync(p,sessPath);}
function deny(reason){log({decision:'deny',reason,tool:input.tool_name});out({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'jev-harness: '+reason}});}
function block(reason){log({decision:'block',reason});process.stderr.write('jev-harness: '+reason+'。回数で通過させません。審査不能なら「'+HALTED+'」と報告できます。\n');process.exitCode=2;}
async function judge(state,questions){
  if(env.JEV_HARNESS==='off')throw new Error('Harness disabled; protected operations are not authorized');
  const r=await ask(state,questions,{apiKey:env.TYPESAFE_API_KEY,model:MODEL});
  if(!r.answers || typeof r.answers!=='object')throw new Error('Missing review answers');
  log({decision:'review',questions:Object.keys(questions),answers:r.answers});
  return r.answers;
}
const requestHash=()=>hash(JSON.stringify([s.request,s.agreed_outcome,s.replies || []]));
const context=()=>({request:s.request,agreed_outcome:s.agreed_outcome || s.request,accepted_corrections:s.replies || [],plan:s.plan?.text || null});

async function onPrompt(){
  const prompt=String(input.prompt || '');if(!prompt.trim())return;
  const a=await judge({prompt,previous_request:s.request || null,agreed_outcome:s.agreed_outcome || null,
    pending_proposal:s.pending_proposal || s.last_assistant || null},PROMPT_QUESTIONS);
  let kind=a.prompt_kind?.choice;
  if(!['new_request','go_ahead','answers','correction','other'].includes(kind))throw new Error('Prompt review incomplete');
  if(s.pending_proposal && /^(要求[はが]?あってる|承認します|許可します|進めて|やれ|それで[良よ]い|OK|はい)(?:[。！!\s]|$)/i.test(prompt.trim()))kind='go_ahead';
  if(kind==='new_request'){
    const needs=a.needs_outcome_check?.noul,plan=a.needs_plan_review?.noul;
    if(typeof needs!=='number'||typeof plan!=='number')throw new Error('Missing task classification');
    s={request:prompt,approved:needs<.6,planRequired:plan>=.6,planPassed:plan<.6,
       agreed_outcome:needs<.6?prompt:null,replies:[],facts:{files_written:[],verification_runs:[]},receipts:[],pending:{}};
  }else if(kind!=='other'){
    s.replies=[...(s.replies || []),prompt];
    if(s.pending_proposal && ['go_ahead','answers'].includes(kind)){s.agreed_outcome=s.pending_proposal+'\n[ユーザーの返事] '+prompt;s.pending_proposal=null;}
    if(['go_ahead','answers'].includes(kind))s.approved=true;
    if(kind==='correction'){s.plan=null;s.planPassed=false;s.receipts=[];}
  }
  s.promptKind=kind;save();log({kind,approved:s.approved,request_hash:requestHash()});
  if(s.approved===false)out({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'jev-harness: アウトカム・未知・埋め方を確認するまで書き込みは止まる。既存提案への承認は保持する。'}});
}

async function onPre(){
  const op=operation(input);
  const source=op.kind==='command'||op.kind==='modify'?sources(op,s.facts.files_written):[];
  const a=await judge({operation:op,source,...context()},ACTION_QUESTIONS);
  const action=op.kind==='modify'?'modify':a.action?.choice;
  if(!['read','modify','small_check','run'].includes(action))return deny('操作の副作用を判別できません');
  if(op.kind!=='modify' && typeof a.mixed_mutation_and_run?.noul!=='number')return deny('操作審査が欠落しています');
  if((a.mixed_mutation_and_run?.noul || 0)>=.5)return deny('ソース変更と実行を分けてください');
  if(action==='read'){log({decision:'allow',action,tool:op.name});return;}
  if(s.approved!==true || !s.request)return deny('合意した要求がありません');
  if(op.paths.some(p=>resolve(op.cwd,p).startsWith(resolve(stateDir))))return deny('審査状態・証拠の直接書換えは禁止です');
  const snapshot=footprint(op.cwd);
  const receipts=s.receipts.filter(r=>r.source_hash===snapshot.hash && r.request_hash===requestHash() && r.passed && r.completed);
  if(action==='run' && !receipts.some(r=>r.action==='small_check' && r.outcome_observed))return deny('この要求・コード版で目的に関係する小規模検証の実証がありません');
  if((action==='run'||action==='small_check') && op.kind==='command' && !source.length)return deny('実行するソースが審査入力にありません。入口ファイルを明示してください');
  const proposal=s.plan?.text || recentAssistantText() || s.last_assistant || '';
  if(s.planRequired && !proposal.trim())return deny('実装前の具体的な計画がありません');
  // Readiness of an incremental edit is established by approval and its plan.
  // Requiring completed execution evidence here would prevent writing its tests.
  const questions=Object.fromEntries(Object.entries(GATE_QUESTIONS).filter(([key])=>action!=='modify'||key!=='stage_ready'));
  const review=await judge({...context(),plan:proposal,operation:op,stage:action,source,source_snapshot:snapshot,small_evidence:receipts},questions);
  const failed=requireScores(review,Object.keys(questions));
  if(failed.length)return deny('工程審査に不合格: '+failed.join(', ')+'。要求・実装・検収の対応を修正してください');
  s.plan={text:proposal,review,request_hash:requestHash()};s.planPassed=true;
  s.pending[op.id]={action,operation:op,source_hash:snapshot.hash,request_hash:requestHash(),review,
    source_files:source.map(({path,sha256})=>({path,sha256})),authorized_at:new Date().toISOString()};
  save();log({decision:'allow',action,tool:op.name,operation_id:op.id,source_hash:snapshot.hash});
}

async function onPost(){
  const op=operation(input),pending=s.pending[op.id];
  if(!pending){log({decision:'unpaired_post',tool:op.name});return;}
  delete s.pending[op.id];
  if(pending.action==='modify'){
    for(const raw of op.paths){const path=resolve(op.cwd,raw);s.facts.files_written=s.facts.files_written.filter(f=>f.path!==path);s.facts.files_written.push({file:raw,path,sha256:existsSync(path)?hash(readFileSync(path)):null});}
    s.receipts=[];save();log({decision:'modified_evidence_invalidated',tool:op.name});return;
  }
  const result=commandResult(input.tool_response),snapshot=footprint(op.cwd);
  const receipt={action:pending.action,command:op.details,request_hash:pending.request_hash,source_hash:pending.source_hash,
    completed:result.completed,exit_code:result.exit_code,passed:false,outcome_observed:false,output_hash:hash(result.output),output:result.output.slice(-14000)};
  if(result.completed && result.exit_code===0 && snapshot.hash===pending.source_hash && requestHash()===pending.request_hash){
    // Send observations, not the unjudged receipt's default false verdicts.
    const observed={completed:result.completed,exit_code:result.exit_code,output:receipt.output,
      source_unchanged:true,request_unchanged:true};
    const answers=await judge({...context(),operation:op,source:sources(op,s.facts.files_written),actual_process_result:observed,current_source_snapshot:snapshot},EVIDENCE_QUESTIONS);
    receipt.review=answers;receipt.passed=true;receipt.outcome_observed=requireScores(answers,Object.keys(EVIDENCE_QUESTIONS)).length===0;
  }
  s.receipts.push(receipt);s.facts.verification_runs.push(receipt);save();
  log({decision:'evidence_recorded',action:receipt.action,completed:receipt.completed,passed:receipt.passed,
    outcome_observed:receipt.outcome_observed,response_keys:Object.keys(input.tool_response || {})});
}

async function onStop(){
  const report=String(input.last_assistant_message || '');if(!report.trim())return;
  if(report.trim()===HALTED){log({decision:'halted_not_completed'});return;}
  const extra={claims_completion:{type:'noul',instructions:'Does the report present any requested deliverable as achieved or ready, even if its message kind is progress/answer? Explicitly unachieved/blocked reports are false.'}};
  const snapshot=footprint(resolve(input.cwd || process.cwd()));
  const receipts=s.receipts.filter(r=>r.request_hash===requestHash() && r.source_hash===snapshot.hash && r.completed && r.passed);
  const a=await judge({...context(),report,facts:{files_written:s.facts.files_written,verification_runs:receipts}}, {...STOP_QUESTIONS,...extra});
  const kind=a.message_kind?.choice,claim=a.claims_completion?.noul;
  if(!['proposal','plan','progress','completion','answer','other'].includes(kind)||typeof claim!=='number')throw new Error('Report review incomplete');
  s.last_assistant=report;if(kind==='proposal')s.pending_proposal=report;
  if(kind==='plan'){
    const bad=requireScores(a,['plan_covers_request','plan_advances_outcome','plan_has_outcome_check']);
    if(bad.length){save();return block('計画が要求・目的・検収を満たしません: '+bad.join(', '));}
    s.plan={text:report,request_hash:requestHash()};s.planPassed=true;
  }
  if(kind==='completion' || claim>=.5){
    const bad=requireScores(a,['restates_request_faithfully','verification_matches_facts','outcome_evidence']);
    for(const key of ['remaining_work_while_done','outcome_drift','files_out_of_scope'])if(typeof a[key]?.noul!=='number'||a[key].noul>.25)bad.push(key);
    if(!receipts.some(r=>r.outcome_observed))bad.push('no_current_outcome_evidence');
    if(bad.length){save();return block('完了の根拠が成立していません: '+bad.join(', '));}
  }
  save();log({decision:'pass',kind,claims_completion:claim});
}

function recentAssistantText(){
  const p=input.transcript_path;if(!p || !existsSync(p))return '';
  const lines=readFileSync(p,'utf8').trim().split('\n').slice(-80),texts=[];
  for(const line of lines){try{const r=JSON.parse(line),m=r.message || r.payload;if(m?.role==='assistant'){
    if(typeof m.content==='string')texts.push(m.content);
    else for(const c of m.content || [])if((c.type==='text'||c.type==='output_text')&&c.text)texts.push(c.text);
  }}catch{}}
  return texts.slice(-4).join('\n').slice(-16000);
}

try{
  input=JSON.parse(readFileSync(0,'utf8') || '{}');if(!input.session_id)throw new Error('Missing session identity');
  sessionId=String(input.session_id).replace(/[^A-Za-z0-9_-]/g,'_');mkdirSync(join(stateDir,'sessions'),{recursive:true});
  sessPath=join(stateDir,'sessions',sessionId+'.json');lockPath=sessPath+'.lock';const deadline=Date.now()+20000;
  while(lockFd===undefined){try{lockFd=openSync(lockPath,'wx');}catch(e){if(e.code!=='EEXIST'||Date.now()>deadline)throw e;await new Promise(r=>setTimeout(r,50));}}
  s=existsSync(sessPath)?JSON.parse(readFileSync(sessPath,'utf8')):{};
  s.facts ||= {files_written:[],verification_runs:[]};s.receipts ||= [];s.pending ||= {};
  if(event==='UserPromptSubmit')await onPrompt();else if(event==='PreToolUse')await onPre();
  else if(event==='PostToolUse')await onPost();else if(event==='Stop')await onStop();else throw new Error('Unknown lifecycle event');
}catch(e){
  const reason='審査不能: '+String(e.message).slice(0,180);
  if(event==='PreToolUse')out({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'jev-harness: '+reason}});
  else if(event==='Stop'){process.stderr.write('jev-harness: '+reason+'。'+HALTED+'\n');process.exitCode=2;}
  else {if(sessPath && lockFd!==undefined){s.review_error=reason;s.receipts=[];if(event==='UserPromptSubmit')s.approved=false;save();}out({systemMessage:'jev-harness: '+reason+'。検証済み・完了として通過させません。'});}
}finally{if(lockFd!==undefined){closeSync(lockFd);unlinkSync(lockPath);}}
