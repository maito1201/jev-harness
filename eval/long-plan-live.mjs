// Real Jev + real hook subprocess with a large synthetic transcript. Not a host test.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=mkdtempSync(join(tmpdir(),'jev-long-plan-')),cwd=join(root,'work'),state=join(root,'state');mkdirSync(cwd);
const path=join(root,'transcript.jsonl'),records=[{type:'turn_context',payload:{turn_id:'plan'}}];
for(let i=0;i<12;i++){
 records.push({payload:{role:'assistant',content:'日本語の調査記録です。実証済みとは扱いません。'.repeat(120)}});
 const output={payload:{type:'function_call_output',call_id:'r'+i,output:JSON.stringify({source_hash:i<6?'old':'current',exit_code:i===6?1:0,output:'日本語の人工観測記録。これは実市場の結果ではありません。'.repeat(240)+(i===6?' MIDDLE_FAILURE':'')})}};
 records.push(output,output);
}
writeFileSync(path,records.map(JSON.stringify).join('\n'));
const run=fileURLToPath(new URL('../hooks/run.mjs',import.meta.url)),events=[];
async function hook(event,fields){return new Promise((done,reject)=>{
 const child=spawn(process.execPath,[run,event],{cwd,env:{...process.env,JEV_HARNESS_STATE_DIR:state},windowsHide:true});let output='',error='';
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('close',code=>{const r={code,output:output?JSON.parse(output):null,error};events.push({event,...r});done(r);});
 child.stdin.end(JSON.stringify({session_id:'long-plan',cwd,turn_id:'plan',...fields}));
});}
await hook('UserPromptSubmit',{prompt:'隔離したpermit(value)のfixtureを検証してください。目標はpermit(true)がtrue、false・null・文字列trueではfalseとなることです。固定参照は入力[true,false,null,"true"]と出力[true,false,false,false]です。前提検査、厳密比較による実装、小規模検査、誤実装を落とす独立評価、ちょうど4入力の実行、実際の保存結果と固定参照の照合の順で進めてください。この具体的範囲を承認します。株式コード・データ変更とサブエージェントは禁止し、一般的能力は主張しないでください。'});
await hook('UserPromptSubmit',{prompt:'承認します'});
const report='計画です。目標はpermit(true)のみtrueを返し、false・null・文字列trueはfalseとすることです。入力[true,false,null,"true"]と期待値[true,false,false,false]を固定します。まず前提検査で4入力と参照値の対応をassertし、不整合な参照値が拒否されることを確認します。実装はvalue === trueの厳密比較とし、小規模検査で実関数の4出力を固定期待値と照合します。独立した評価検査では正しい関数を通し、常にtrueを返す誤実装と常にfalseを返す誤実装の両方を落とします。その後ちょうど4入力を実行して結果JSONを保存し、実際の保存結果を変更しない期待値と照合します。各工程は別コマンドで実行し、失敗時は完了にしません。株式研究コード・データは変更せず、サブエージェントは使いません。結論はこのfixtureに限定し、一般的能力を主張しません。以上は将来の手順です。';
for(let attempt=0;attempt<4;attempt++){
 const r=await hook('Stop',{transcript_path:path,last_assistant_message:report});
 const saved=JSON.parse(readFileSync(join(state,'sessions/long-plan.json'),'utf8'));
 if(saved.workflow?.phase==='premises' || !/api_|review_pending|input_budget/.test(r.output?.reason || ''))break;
}
const saved=JSON.parse(readFileSync(join(state,'sessions/long-plan.json'),'utf8'));
const result={passed:saved.approved===true&&saved.planPassed===true&&saved.workflow?.phase==='premises',scope:'Real Jev + hook subprocess; synthetic long Japanese transcript, not desktop host',transcript_bytes:Buffer.byteLength(readFileSync(path)),root,phase:saved.workflow?.phase,events};
writeFileSync(resolve(process.argv[2] || 'long-plan-live.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,events:events.length}));if(!result.passed)process.exitCode=1;
