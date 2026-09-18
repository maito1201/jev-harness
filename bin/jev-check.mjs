#!/usr/bin/env node
// エージェントが自分の下書きを 0.3 秒で検査する CLI。stdin に JSON、stdout に JSON。
//   rank : { claim, sketches: {name: text} }          → 各方針の見込み（Score 0〜2）を高い順に
//   gaps : { claim, draft, steps?: [..] }               → 循環・手抜き・場合分け漏れ・立証度と、各ステップが前から従うか
//   scope: { request, agreed_outcome?, files: [..] }    → 各ファイルが依頼の範囲外か
// 数学の実測（2026-09-18）: 循環 0.94/0.05、手抜き 0.97/0.03、場合分け漏れ 0.97/0.06、方針 Score 1.95/0.01、誤ステップ 0.41（正 0.88〜0.96）
import { readFileSync } from "node:fs";
import { ask } from "../hooks/jev.mjs";
import { MODEL, WRITE_QUESTIONS } from "../hooks/questions.mjs";

const mode = process.argv[2];
const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) { console.error("TYPESAFE_API_KEY が未設定"); process.exit(2); }
const P = (state, questions) => ask(state, questions, { apiKey, model: MODEL });

const PROMISE = { promise: { type: "score", instructions: "How likely is `sketch` to be completed into a rigorous, correct, complete solution of `claim`?", criteria: [
  { summary: "Not a real strategy", signals: ["Observation, empirical check, or appeal to plausibility", "Would not establish the claim even if carried out"] },
  { summary: "Plausible direction but a key step is missing or unclear" },
  { summary: "Standard, complete strategy; remaining work is routine", signals: ["Names the invariant, contradiction, or mechanism that finishes it"] },
] } };
const GAPS = {
  assumes_conclusion: { type: "noul", instructions: "Does `draft` assume what `claim` asks for, or use its converse or an equivalent restatement as the key step?" },
  handwave: { type: "noul", instructions: "Does `draft` justify a necessary step only with 明らかに/clearly/obviously/適宜/うまくいくはず, without a derivation or a how?" },
  cases_incomplete: { type: "noul", instructions: "Does `draft` do a case analysis that omits a case required to cover everything in `claim`?" },
  unproved_lemma: { type: "noul", instructions: "Does `draft` rely on an intermediate claim that is stated but neither proved nor cited as a known result?" },
  establishes_claim: { type: "noul", instructions: "Does `draft` establish `claim` completely, with every step justified and all cases covered?" },
};

let result;
if (mode === "rank") {
  const entries = Object.entries(input.sketches || {});
  const rs = await Promise.all(entries.map(([, sketch]) => P({ claim: input.claim, sketch }, PROMISE)));
  result = entries.map(([name], i) => ({ name, promise: +rs[i].answers.promise.score.toFixed(2), confidence: +rs[i].answers.promise.confidence.toFixed(2) })).sort((a, b) => b.promise - a.promise);
} else if (mode === "gaps") {
  const q = { ...GAPS };
  (input.steps || []).forEach((_, i) => { q[`step${i + 1}_follows`] = { type: "noul", instructions: `Does step ${i + 1} in \`steps\` follow validly from the assumptions and the earlier steps? Answer about step ${i + 1} only.` }; });
  const r = await P({ claim: input.claim, draft: input.draft, steps: input.steps || undefined }, q);
  result = Object.fromEntries(Object.entries(r.answers).map(([k, a]) => [k, +a.noul.toFixed(2)]));
  result.suspect_steps = Object.entries(result).filter(([k, p]) => /^step\d+_follows$/.test(k) && p < 0.6).map(([k]) => +k.match(/\d+/)[0]);
} else if (mode === "scope") {
  const rs = await Promise.all((input.files || []).map((file) => P({ request: input.request, agreed_outcome: input.agreed_outcome ?? null, file, is_new: !!input.is_new?.[file] }, WRITE_QUESTIONS)));
  result = (input.files || []).map((file, i) => ({ file, off_scope: +rs[i].answers.off_scope.noul.toFixed(2) }));
} else {
  console.error("usage: jev-check.mjs rank|gaps|scope < input.json"); process.exit(2);
}
console.log(JSON.stringify(result, null, 2));
