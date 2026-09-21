import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkflow,transition,restart,failure,permitted,evaluationSnapshot,evaluationPath,classifyOperation} from '../hooks/workflow.mjs';
test('工程飛ばし・AIが勝手に選んだ遷移・未検証実行・未検証完了を拒否',()=>{
 const w=createWorkflow();assert.equal(permitted(w,'execute'),false);assert.throws(()=>transition(w,'execution_finished'));
 const phases=['premises','implementation','evaluation','execution','results','complete'];
 for(const [i,event] of ['plan_accepted','premises_passed','pilot_passed','evaluation_passed','execution_finished','result_passed'].entries()){
  transition(w,event);assert.equal(w.phase,phases[i]);assert.equal(permitted(w,'execute'),w.phase==='execution');
 }
 assert.throws(()=>transition(w,'result_passed'));
});
test('失敗原因で戻り先が分かれ、同じ失敗を3回繰り返すと停止',()=>{
 for(const [cause,to] of Object.entries({implementation:'implementation',evaluation:'design',premise:'premises',observation:'execution',unknown:'halted'})){
  const w=createWorkflow();w.phase='execution';w.seal='sealed';failure(w,cause,'same');assert.equal(w.phase,to);
  failure(w,cause,'same');failure(w,cause,'same');assert.equal(w.phase,'halted');assert.equal(permitted(w,'execute'),false);
 }
});
test('評価ファイルの期待値変更は指紋が変わり、実装編集とは区別できる',()=>{
 const root=mkdtempSync(join(tmpdir(),'workflow-contract-'));mkdirSync(join(root,'tests'));writeFileSync(join(root,'tests','oracle.json'),'1');
 const first=evaluationSnapshot(root);writeFileSync(join(root,'main.js'),'implementation');assert.equal(evaluationSnapshot(root).hash,first.hash);
 writeFileSync(join(root,'tests','oracle.json'),'0');assert.notEqual(evaluationSnapshot(root).hash,first.hash);
 assert.equal(evaluationPath(root,'tests/oracle.json'),true);assert.equal(evaluationPath(root,'main.js'),false);
});
test('設計や検証の役割は実装変更できず、実装役は評価変更できない',()=>{
 const w=createWorkflow();assert.equal(permitted(w,'evaluation_edit'),true);assert.equal(permitted(w,'implementation_edit'),false);
 transition(w,'plan_accepted');assert.equal(permitted(w,'implementation_edit'),false);
 transition(w,'premises_passed');assert.equal(permitted(w,'evaluation_edit'),false);
 assert.equal(classifyOperation('small_check','made-up',false),'unknown');
 w.seal='old';restart(w,'implementation','implementation changed');assert.equal(w.seal,'old');
 restart(w,'design','criteria changed');assert.equal(w.seal,null);assert.equal(w.revision,2);
});
