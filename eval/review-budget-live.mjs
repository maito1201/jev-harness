// Real provider, synthetic Japanese records only. Never uses user conversations.
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {ask} from '../hooks/jev.mjs';
import {boundedReview,bytes} from '../hooks/review-budget.mjs';
import {RELIABILITY_QUESTIONS,reliabilityFailures} from '../hooks/observations.mjs';
const state={request:'利用者が承認した修正だけを実行するハーネスを検査する。',accepted_corrections:['株式研究のコード・データは変更禁止','サブエージェント禁止'],report:'検証計画です。まだ検証していません。前提条件を確認し、未承認変更を拒否する実装を小規模検査します。常に許可する誤実装を落とせることを独立確認し、固定した入力を実行して結果を照合します。過去の失敗や古い版の結果を成功証拠には使いません。',recorded_observations:Array.from({length:12},(_,id)=>({id,source_hash:id<6?'old':'current',exit_code:id===6?1:0,output:('日本語の人工観測記録。これは実市場の結果ではありません。').repeat(240)+(id===6?' 過去の試験は失敗しました。':' 観測終了。')}))};
state.recorded_observations.push(...state.recorded_observations);
const cache={},trace=[];let answers,error=null,attempts=0;
while(attempts<6)try{
 attempts++;
 answers=await boundedReview(state,RELIABILITY_QUESTIONS,{budget:Number(process.argv[3] || 24000),cache,deadline:Date.now()+40000,call:async(s,q)=>(await ask(s,q,{apiKey:process.env.TYPESAFE_API_KEY})).answers,onBatch:(id,size)=>trace.push({id,input_bytes:size})});break;
}catch(e){error={code:e.code,message:e.message};if(!['review_pending','api_unavailable','api_transport','api_timeout'].includes(e.code))break;}
if(answers)error=null;
const passed=!!answers&&!reliabilityFailures(answers).length;
const result={passed,scope:'Real Jev API; synthetic long Japanese prospective plan; not desktop host integration',raw_input_bytes:bytes(state),reviewed_batches:trace.length,attempts,answers,error,trace};
writeFileSync(resolve(process.argv[2] || 'review-budget-live.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,trace:undefined}));if(!passed)process.exitCode=1;
