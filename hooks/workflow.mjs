// This module owns transitions. A model may classify evidence, never choose next.
import {readFileSync,readdirSync,existsSync,lstatSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {hash} from './operations.mjs';
export const POLICY=JSON.parse(readFileSync(new URL('./workflow.json',import.meta.url),'utf8'));
export function createWorkflow(){return {phase:POLICY.initial,revision:0,seal:null,history:[],failures:{},pilot_command:null};}
function move(w,to,reason){
 if(!POLICY.phases[to])throw new Error('Unknown phase: '+to);
 const from=w.phase;w.phase=to;w.history.push({from,to,reason,revision:w.revision});
}
export function transition(w,event){
 const next=POLICY.phases[w.phase]?.on[event];if(!next)throw new Error(`Forbidden transition: ${w.phase} / ${event}`);
 move(w,next,event);
}
export function restart(w,phase,reason){w.revision++;if(phase==='design')w.seal=null;w.pilot_command=null;move(w,phase,reason);}
export function failure(w,cause,fingerprint){
 const key=hash(cause+'\n'+fingerprint),count=(w.failures[key]||0)+1;w.failures[key]=count;
 const route=POLICY.failures[cause];
 const next=count>=POLICY.max_identical_failures?'halted':route==='$current'?w.phase:route || 'halted';
 // A routing decision never preserves successful evidence from the failed path.
 w.revision++;w.pilot_command=null;if(next==='design')w.seal=null;
 move(w,next,`failure:${cause}:${count}`);return next;
}
export function permitted(w,operation){return POLICY.phases[w.phase]?.allow.includes(operation)===true;}
export function evaluationPath(cwd,path){
 const rel=relative(resolve(cwd),resolve(cwd,path)).replaceAll('\\','/');
 return /^(?:test|tests|eval|evaluation|\.jev)(?:\/|$)/.test(rel)||/(?:^|\/)(?:acceptance|evaluation|criteria|contract)(?:[._-][^/]*)?\.(?:json|ya?ml|md)$/.test(rel);
}
export function evaluationSnapshot(cwd){
 const entries=[];
 function visit(p){
  const stat=lstatSync(p);if(stat.isSymbolicLink())throw new Error('Evaluation symlink is not sealable: '+p);
  if(stat.isDirectory()){for(const name of readdirSync(p).sort()){if(['node_modules','__pycache__','.pytest_cache'].includes(name))continue;visit(join(p,name));}}
  else if(stat.isFile()){
   if(stat.size>2000000 || entries.length>=10000)throw new Error('Evaluation snapshot exceeds limit');
   entries.push([relative(cwd,p).replaceAll('\\','/'),hash(readFileSync(p))]);
  }
 }
 for(const name of readdirSync(cwd).sort())if(evaluationPath(cwd,name))visit(join(cwd,name));
 return {hash:hash(JSON.stringify(entries)),files:entries.length};
}
export function classifyOperation(action,checkKind,evaluationEdit){
 if(action==='read')return 'read';
 if(action==='modify')return evaluationEdit?'evaluation_edit':'implementation_edit';
 if(action==='run')return 'execute';
 if(action==='small_check' && ['premise','pilot','evaluation','result'].includes(checkKind))return checkKind+'_check';
 return 'unknown';
}
export const WORKFLOW_ACTION_QUESTIONS={
 check_kind:{type:'choice',instructions:'Classify what the actual check source and command test, NOT what stage the agent wants to reach. Use other for a non-check.',criteria:{premise:{what:'Tests data availability, timing, causal assumptions or prerequisites before implementation.'},pilot:{what:'Bounded behavior/negative-control test of an implementation.'},evaluation:{what:'Independent audit that the pilot evaluation measures the requested capability and includes a meaningful failure control; not merely rerunning the pilot.'},result:{what:'Examines actual execution results against the fixed goal and acceptance criteria.'},other:{what:'Not one of these checks, or unclear.'}}},
 changes_evaluation:{type:'noul',instructions:'Does this operation alter evaluation criteria, reference expected outcomes, data split, acceptance tests or workflow policy, including via shell commands? Do not treat ordinary execution output as changing criteria.'},
};
export const FAILURE_QUESTIONS={failure_kind:{type:'choice',instructions:'Classify the observed failed check using actual output and source. Do not infer a scientific conclusion from a process error.',criteria:{implementation:{what:'Implementation or process error; mechanism fails a valid test.'},evaluation:{what:'Test/metric/reference does not measure requested capability, or criteria were changed to pass.'},premise:{what:'Evidence contradicts a data assumption or underlying hypothesis.'},observation:{what:'Available results are insufficient; further observation is needed.'},unknown:{what:'Cause cannot be established.'}}}};

export function evidenceQuestions(operation,base){
 const criterion={
  premise_check:'Did the executed assertions establish the required input/data/runtime assumptions, including detecting a violated prerequisite? This stage does NOT require the final capability to exist yet.',
  evaluation_check:'Did the executed independent check show that the evaluation distinguishes correct from intentionally incorrect behavior and measures the fixed goal? Repeating the pilot alone is insufficient.',
  execute:'Did the requested execution finish successfully and produce inspectable results? This is process completion only, NOT proof of the final outcome.',
  result_check:'Did the executed check compare actual execution results against the fixed goal and acceptance reference, without changing that reference? Inspect assertions, not the label passed.',
 }[operation];
 return {
  outcome_observed:{type:'choice',instructions:criterion || 'Did the actual check directly observe the requested bounded implementation behavior, including rejection of an invalid input or a negative control? This is a pilot result, not proof of later production outcomes.',criteria:{observed:{what:'Source assertions exercise the stated current-stage behavior and actual_process_result shows they completed successfully.'},not_observed:{what:'Actual assertions fail or check a different behavior, or a proxy is substituted for the stage objective.'},unclear:{what:'Required source, reference or completed process result is missing or cannot be assessed.'}}},
  evidence_relevant:{type:'choice',instructions:'Is the observation relevant to the current workflow stage and fixed request? Source and request identity are checked by code; judge semantic relevance to this stage, not whether all later stages are done.',criteria:{relevant:{what:'The check measures this stage of the accepted plan.'},unrelated:{what:'Different task, obsolete goal, or an irrelevant proxy.'},unclear:{what:'Cannot establish relevance.'}}}
 };
}
