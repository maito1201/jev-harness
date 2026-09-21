import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transcript,auditHealth} from '../hooks/observations.mjs';
test('助手の発言は根拠に昇格させず、実ツール出力だけ収集',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'jev-transcript-')),'trace.jsonl');
 const rows=[{type:'turn_context',payload:{turn_id:'t'}},
 {type:'response_item',payload:{type:'message',role:'assistant',content:[{text:'全て合格した'}]}},
 {type:'response_item',payload:{type:'function_call',name:'exec_command',call_id:'c',arguments:'inspect'}},
 {type:'response_item',payload:{type:'function_call_output',call_id:'c',output:'exit_code: 1; failed'}}];
 writeFileSync(path,rows.map(JSON.stringify).join('\n'));
 const r=transcript(path,'t');assert.equal(r.observations.length,1);assert.equal(r.observations[0].output,'exit_code: 1; failed');assert.equal(r.observations[0].call.name,'exec_command');
 assert.equal(transcript(path,'other').report,'');
});
test('入力審査だけでは回答審査稼働と言わない。他セッションも数えない',()=>{
 const r=auditHealth([{session:'s',event:'UserPromptSubmit',decision:'review'},{session:'other',event:'Stop',decision:'review'}],'s');
 assert.equal(r.status,'stop_review_not_observed');assert.equal(r.stop_reviews,0);
});
