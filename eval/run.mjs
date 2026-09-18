#!/usr/bin/env node
// 本物の jev に eval/cases.json を流し、種類・確率・判定を期待と比べる。反証の観測器。
// 使い方: TYPESAFE_API_KEY=… node eval/run.mjs [--verbose]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ask } from "../hooks/jev.mjs";
import { MODEL, STOP_QUESTIONS } from "../hooks/questions.mjs";
import { buildStopState, verdict } from "../hooks/judge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) { console.error("TYPESAFE_API_KEY が未設定"); process.exit(2); }
const verbose = process.argv.includes("--verbose");

let mismatches = 0, tokens = 0, ms = 0;
console.log("| ケース | 種類(期待) | conf | 差し戻し(期待) | 一致 | ms |\n|---|---|---|---|---|---|");
for (const c of cases) {
  const state = buildStopState({ request: c.request, agreedOutcome: c.agreed_outcome || null, userReplies: c.user_replies || [], facts: c.facts || {}, report: c.report });
  const r = await ask(state, STOP_QUESTIONS, { apiKey, model: MODEL });
  const v = verdict(r.answers, { hasOutcome: !!c.agreed_outcome, facts: c.facts || {} });
  const got = v.blocks.map((b) => b.id).sort(), exp = [...c.expect.blocks].sort();
  const kinds = [].concat(c.expect.kind); // 境界が曖昧なケースは複数の種類を許す
  const allowed = new Set([...exp, ...(c.expect.also_allowed || [])]); // 種類の境界で点いても正しい追加の差し戻し
  const ok = kinds.includes(v.kind) && exp.every((id) => got.includes(id)) && got.every((id) => allowed.has(id));
  if (!ok) mismatches++;
  tokens += r.usage?.input_tokens ?? 0; ms += r.latencyMs;
  console.log(`| ${c.name} | ${v.kind}(${kinds.join("|")}) | ${v.confidence?.toFixed(2)} | ${got.join(",") || "-"}(${exp.join(",") || "-"}) | ${ok ? "○" : "×"} | ${r.latencyMs} |`);
  if (verbose || !ok) {
    const probs = Object.entries(r.answers).filter(([, a]) => a.type === "noul").map(([k, a]) => `${k}=${a.noul.toFixed(2)}`).join(" ");
    console.log(`|  | ${probs} | | | | |`);
  }
}
console.log(`\n${cases.length} ケース、不一致 ${mismatches}、入力トークン合計 ${tokens}（≈ $${(tokens * 0.042 / 1e6).toFixed(5)}）、合計 ${ms} ms、model ${MODEL}`);
process.exit(mismatches ? 1 : 0);
