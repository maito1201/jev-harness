import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, clip, buildStopState } from "../hooks/judge.mjs";

const n = (p) => ({ type: "noul", noul: p });
const kind = (c, conf = 0.9) => ({ type: "choice", choice: c, confidence: conf });

test("proposal: 言い換え 0.9 は差し戻し、仮定 0.5 は注意", () => {
  const v = verdict({ message_kind: kind("proposal"), outcome_paraphrase: n(0.9), assumed_instead_of_asking: n(0.5) });
  assert.deepEqual(v.blocks.map((b) => b.id), ["outcome_paraphrase"]);
  assert.deepEqual(v.warns.map((w) => w.id), ["assumed_instead_of_asking"]);
});

test("completion: presence 型は低いほど欠けている（結論先頭・言い直し）", () => {
  const v = verdict({ message_kind: kind("completion"), conclusion_first: n(0.1), restates_request_faithfully: n(0.4), remaining_work_while_done: n(0.1) });
  assert.deepEqual(v.blocks.map((b) => b.id), ["conclusion_first"]);
  assert.deepEqual(v.warns.map((w) => w.id), ["restates_request_faithfully"]);
});

test("事実の照合: 検証済みと言うのに成功した記録が無ければ差し戻し。記録があり jev も一致なら通る", () => {
  const base = { message_kind: kind("completion"), conclusion_first: n(0.9), claims_verification_passed: n(0.95), verification_matches_facts: n(0.9) };
  let v = verdict(base, { facts: { verification_runs: [] } });
  assert.deepEqual(v.blocks.map((b) => b.id), ["verification_matches_facts"]);
  v = verdict(base, { facts: { verification_runs: [{ command: "node --test", passed: 0.98 }] } });
  assert.equal(v.blocks.length, 0);
  v = verdict({ ...base, verification_matches_facts: n(0.1) }, { facts: { verification_runs: [{ command: "npm run lint", passed: 0.9 }] } });
  assert.deepEqual(v.blocks.map((b) => b.id), ["verification_matches_facts"], "記録はあるが主張と別物なら差し戻し");
  v = verdict({ ...base, claims_verification_passed: n(0.1) }, { facts: { verification_runs: [] } });
  assert.equal(v.blocks.length, 0, "検証を主張していなければ照合しない");
});

test("outcome_drift は合意アウトカムがある時だけ見る", () => {
  const a = { message_kind: kind("completion"), conclusion_first: n(0.9), outcome_drift: n(0.9) };
  assert.equal(verdict(a, { hasOutcome: false }).blocks.length, 0);
  assert.deepEqual(verdict(a, { hasOutcome: true }).blocks.map((b) => b.id), ["outcome_drift"]);
});

test("plan: 網羅していない・手抜きは差し戻し", () => {
  const v = verdict({ message_kind: kind("plan"), plan_covers_request: n(0.2), handwave: n(0.8), cases_incomplete: n(0.1) });
  assert.deepEqual(v.blocks.map((b) => b.id).sort(), ["handwave", "plan_covers_request"]);
});

test("plan: 実装価値とアウトカム検収が無ければ差し戻す", () => {
  const v = verdict({ message_kind: kind("plan"), plan_covers_request: n(0.9), plan_advances_outcome: n(0.2), plan_has_outcome_check: n(0.1), handwave: n(0.1), cases_incomplete: n(0.1) });
  assert.deepEqual(v.blocks.map((b) => b.id).sort(), ["plan_advances_outcome", "plan_has_outcome_check"]);
});

test("completion: 合意アウトカムの実証が無ければ差し戻す", () => {
  const v = verdict({ message_kind: kind("completion"), conclusion_first: n(0.9), remaining_work_while_done: n(0.1), outcome_drift: n(0.1), outcome_evidence: n(0.2) }, { hasOutcome: true });
  assert.deepEqual(v.blocks.map((b) => b.id), ["outcome_evidence"]);
});

test("未知の種類・欠けた答えは other / 無視", () => {
  assert.equal(verdict({ message_kind: kind("weird"), handwave: n(0.99) }).blocks.length, 0);
  assert.equal(verdict({}).kind, "other");
});

test("state は上限内で、事実は最新40件", () => {
  const long = "あ".repeat(30000);
  const st = buildStopState({ request: long, agreedOutcome: long, userReplies: [long, long, long, long], facts: { files_written: Array.from({ length: 60 }, (_, i) => ({ file: `f${i}` })) }, report: long });
  assert.ok(st.request.length <= 6001 && st.agreed_outcome.length <= 3001);
  assert.equal(st.user_replies.length, 3);
  assert.equal(st.facts.files_written.length, 40);
  assert.ok(st.report.includes("中略"));
  assert.equal(clip("abc", 10), "abc");
});
