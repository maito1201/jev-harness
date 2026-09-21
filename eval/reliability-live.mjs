// Deliberate known bad/good reports; evaluate the real hook subprocess, not a mock judge.
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cases=JSON.parse(readFileSync(new URL('./reliability-cases.json',import.meta.url),'utf8'));
const root=mkdtempSync(join(tmpdir(),'jev-reliability-')),cwd=join(root,'work'),state=join(root,'state');mkdirSync(cwd);mkdirSync(join(state,'sessions'),{recursive:true});
const run=fileURLToPath(new URL('../hooks/run.mjs',import.meta.url));
const results=[];
for(let round=1;round<=2;round++)for(const c of cases){
 const session=c.id+'-'+round;
 writeFileSync(join(state,'sessions',session+'.json'),JSON.stringify({request:c.request,agreed_outcome:c.request,approved:true,receipts:[],pending:{},facts:{files_written:[],verification_runs:[]},observations:[{output:c.observed}]}));
 const result=await new Promise((done,reject)=>{
  const p=spawn(process.execPath,[run,'Stop'],{cwd,env:{...process.env,JEV_HARNESS_STATE_DIR:state}});let stdout='',stderr='';
  p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);p.on('error',reject);p.on('close',code=>done({code,stdout,stderr}));
  p.stdin.end(JSON.stringify({session_id:session,turn_id:session,cwd,last_assistant_message:c.report}));
 });
 const events=readFileSync(join(state,'log.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(e=>e.session===session);
 const reviews=events.filter(e=>e.decision==='review');
 const review=reviews.length?{answers:Object.assign({},...reviews.map(e=>e.answers))}:null;
 const actual=events.some(e=>e.decision==='error')?'error':result.code===2?'block':result.code===0?'pass':'error';
 results.push({id:c.id,round,expected:c.expected,actual,matched:!!review&&actual===c.expected,answers:review?.answers,result});
 console.log(JSON.stringify({id:c.id,round,expected:c.expected,actual,matched:results.at(-1).matched}));
}
const artifact={scope:'real Jev API + hook subprocess; does not prove desktop host invoked hook',root,passed:results.every(r=>r.matched),results};
writeFileSync(resolve(process.argv[2] || 'reliability-live.json'),JSON.stringify(artifact,null,2));
if(!artifact.passed)process.exitCode=1;
