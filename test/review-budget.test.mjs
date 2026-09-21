import {test} from 'node:test';
import assert from 'node:assert/strict';
import {partitionEvidence,fragmentEvidence,canonical,boundedReview,bytes,ReviewError,mergeAnswers} from '../hooks/review-budget.mjs';
import {ask} from '../hooks/jev.mjs';
const choice=choice=>({choice}),n=noul=>({noul});
const questions={scope_preserved:{type:'noul',instructions:'Retain the scope.'},factual_support:{type:'choice',criteria:{supported:{},limited:{},unsupported:{},unclear:{}}}};
const ok=()=>({scope_preserved:n(.95),factual_support:choice('supported'),joint_context:choice('independent')});
const context={request:'承認と検査を維持',accepted_corrections:['株式コード禁止','サブエージェント禁止'],report:'計画。実行結果はまだ未確認。'};

test('atomic batches retain unique records and full context; oversized atomic/context fails closed',()=>{
 const items=Array.from({length:24},(_,i)=>({id:i,output:'市場'.repeat(2000)}));
 const batches=partitionEvidence(context,[...items,...items],20000);
 assert.ok(batches.length>1);for(const b of batches){assert.deepEqual(b.context,context);assert.ok(bytes(b)<=20000);}
 assert.deepEqual(batches.flatMap(b=>b.evidence),items);
 assert.throws(()=>partitionEvidence({request:'x'.repeat(25000)},[],20000),/budget/);
 assert.throws(()=>partitionEvidence(context,[{output:'x'.repeat(25000)}],20000),/budget/);
 assert.deepEqual(partitionEvidence(context,[],20000),[{context,evidence:[]}]);
});
test('huge Japanese output reconstructs exactly, including middle failure and unicode',()=>{
 const record={id:'run',source_hash:'old',exit_code:1,output:'市場😀'.repeat(20000)+'MIDDLE_FAILURE'+'株式'.repeat(20000)};
 const fragments=fragmentEvidence([record,record],4000);
 assert.ok(fragments.length>10);assert.ok(fragments.every(f=>bytes(f)<=4000));
 assert.deepEqual(JSON.parse(fragments.map(f=>f.json_fragment).join('')),canonical(record));
 for(let i=1;i<fragments.length;i++)assert.equal(fragments[i-1].end,fragments[i].start);
});
test('different source versions and exit statuses are not deduplicated',()=>{
 const items=[{output:'same',source_hash:'old',exit_code:0},{output:'same',source_hash:'new',exit_code:1}];
 assert.equal(partitionEvidence(context,items,20000)[0].evidence.length,2);
});
test('every raw fragment reaches review; distant contradictions and middle failures survive reduction',async()=>{
 const observations=Array.from({length:12},(_,i)=>({id:i,output:'調査'.repeat(600)+(i===0?' VERSION_A':i===11?' VERSION_B':i===6?' FAILURE_RECORD':'')}));
 const seen=[];
 const result=await boundedReview({...context,recorded_observations:[...observations,...observations]},questions,{budget:14000,call:async(s,q)=>{
  assert.ok(bytes({state:s,questions:q,model:'jev-latest'})<=14000);
  assert.equal(s.request,context.request);assert.deepEqual(s.accepted_corrections,context.accepted_corrections);
  const text=JSON.stringify(s.evidence);seen.push(text);const a=ok();
  if(text.includes('FAILURE_RECORD'))a.factual_support=choice('unsupported');
  if(text.includes('VERSION_A')&&text.includes('VERSION_B'))a.scope_preserved=n(.1);
  return a;
 }});
 assert.equal(result.factual_support.choice,'unsupported');assert.equal(result.scope_preserved.noul,.1);
 for(let i=0;i<12;i++)assert.ok(seen.some(t=>t.includes(`"id":${i}`)));
});
test('missing answers, joint context and disagreements are never positive votes',async()=>{
 const state={...context,recorded_observations:[{output:'語'.repeat(8000)}]};
 await assert.rejects(boundedReview(state,questions,{budget:9000,call:async()=>({...ok(),joint_context:choice('required')})}),{code:'joint_context_required'});
 await assert.rejects(boundedReview(state,questions,{budget:9000,call:async()=>({})}),{code:'invalid_response'});
 assert.throws(()=>mergeAnswers({action:choice('read')},{action:choice('modify')},{action:{type:'choice',criteria:{read:{},modify:{}}}}),{code:'review_conflict'});
});
test('interrupted review resumes cached exact inputs; changing evidence invalidates affected inputs',async()=>{
 const state={...context,recorded_observations:Array.from({length:5},(_,id)=>({id,output:'語'.repeat(1600)}))};
 const cache={};let calls=0;
 await assert.rejects(boundedReview(state,questions,{budget:12000,cache,call:async()=>{if(++calls>=3)throw new ReviewError('api_unavailable','503');return ok();}}),{code:'api_unavailable'});
 assert.equal(Object.keys(cache).length,2);
 const sent=[];await boundedReview(state,questions,{budget:12000,cache,call:async(s)=>{sent.push(s);return ok();}});
 assert.ok(sent.length>0);const completed=Object.keys(cache).length;
 await boundedReview(state,questions,{budget:12000,cache,call:async()=>assert.fail('already reviewed')});
 state.recorded_observations[2].output+=' changed';
 await boundedReview(state,questions,{budget:12000,cache,call:async()=>ok()});assert.ok(Object.keys(cache).length>completed);
 await assert.rejects(boundedReview({...state,request:'x'.repeat(40000)},questions,{call:async()=>assert.fail()}),{code:'input_budget'});
});
test('provider limits, 503, network and timeouts are distinct from content failures',async()=>{
 for(const [status,detail,code] of [[400,'max_tokens_exceeded','input_budget'],[503,'no healthy upstream','api_unavailable']]){
  await assert.rejects(ask({},questions,{apiKey:'fake',fetchImpl:async()=>({ok:false,status,text:async()=>detail})}),{code});
 }
 await assert.rejects(ask({},questions,{apiKey:'fake',fetchImpl:async()=>{throw new TypeError('network');}}),{code:'api_transport'});
 await assert.rejects(ask({},questions,{apiKey:'fake',fetchImpl:async()=>{throw Object.assign(new Error('timeout'),{name:'AbortError'});}}),{code:'api_timeout'});
});
test('provider fan-out failure retries identical evidence with individual questions; a missing answer still blocks',async()=>{
 const seen=[];
 const a=await boundedReview(context,questions,{call:async(s,q)=>{seen.push({s,q});if(Object.keys(q).length>1)throw new ReviewError('api_unavailable','529');return ok();}});
 assert.equal(a.scope_preserved.noul,.95);assert.equal(seen.length,3);assert.ok(seen.every(x=>JSON.stringify(x.s)===JSON.stringify(context)));
 await assert.rejects(boundedReview(context,questions,{call:async(s,q)=>{if(Object.keys(q).length>1)throw new ReviewError('api_unavailable','503');return {};}}),{code:'invalid_response'});
});
test('absence is not a positive vote: require a complete witness and still reject any later contradiction',async()=>{
 const state={...context,recorded_observations:Array.from({length:5},(_,i)=>({id:i,output:'語'.repeat(1000)}))};
 const run=call=>boundedReview(state,questions,{budget:9000,call});
 const absent=()=>({...ok(),factual_support:choice('absent')});
 assert.equal((await run(async()=>absent())).factual_support.choice,'unclear');
 let calls=0;assert.equal((await run(async()=>++calls===2?ok():absent())).factual_support.choice,'supported');
 calls=0;assert.equal((await run(async()=>++calls===2?ok():calls===4?{...ok(),factual_support:choice('unsupported')}:absent())).factual_support.choice,'unsupported');
});
