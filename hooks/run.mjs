#!/usr/bin/env node
// hook の入口。stdin の JSON を読み、イベントごとに jev を1回呼び、結果をホスト（Claude Code / Codex）へ返す。
// 常に fail-open: API キー無し・ネットワーク断・不正入力ではブロックしない。
// 記録は <stateDir>/log.jsonl のみ（反証の観測に使う）。JEV_HARNESS=off で全停止、JEV_HARNESS_LOG=off で記録停止。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ask } from "./jev.mjs";
import { MODEL, PROMPT_QUESTIONS, WRITE_QUESTIONS, COMMAND_QUESTIONS, STOP_QUESTIONS, MAX_BLOCKS_PER_TURN, NEEDS_OUTCOME_CHECK, NEEDS_PLAN_REVIEW, OFF_SCOPE_ASK, LIMITS } from "./questions.mjs";
import { buildStopState, verdict, blockReason, warnMessage, clip } from "./judge.mjs";

const env = process.env;
if (env.JEV_HARNESS === "off") process.exit(0);
const stateDir = env.JEV_HARNESS_STATE_DIR || env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || join(homedir(), ".jev-harness");
const apiKey = env.TYPESAFE_API_KEY || "";
const event = process.argv[2];

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { process.exit(0); }
const sessionId = String(input.session_id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
const sessPath = join(stateDir, "sessions", `${sessionId}.json`);
const s = loadState();
s.facts ||= { files_written: [], verification_runs: [] };

try {
  if (event === "UserPromptSubmit") await onPrompt();
  else if (event === "PreToolUse") await onPreToolUse();
  else if (event === "PostToolUse") await onPostToolUse();
  else if (event === "Stop") await onStop();
} catch (e) {
  log({ event, error: String(e?.message || e) });
  out({ systemMessage: `jev-harness: 判定をスキップ（${String(e?.message || e).slice(0, 120)}）` });
}
process.exit(0);

// ── UserPromptSubmit: 発話の種類と、儀式（アウトカム確認）が要るか ──
async function onPrompt() {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!prompt.trim()) return;
  s.turn = { id: turnId(), blocks: 0 };
  if (!apiKey) { s.request ||= prompt; s.approved = true; saveState(); return; }
  const r = await ask({ prompt }, PROMPT_QUESTIONS, { apiKey, model: MODEL });
  const kind = r.answers.prompt_kind?.choice || "other";
  const needs = r.answers.needs_outcome_check?.noul ?? 0;
  const needsPlan = r.answers.needs_plan_review?.noul ?? 0;
  if (kind === "new_request") {
    s.request = prompt; s.replies = []; s.agreed_outcome = null; s.pending_proposal = null;
    s.facts = { files_written: [], verification_runs: [] };
    s.approved = needs < NEEDS_OUTCOME_CHECK; // 解釈が分かれる依頼だけ、作る前の確認を要求する
    s.planRequired = needsPlan >= NEEDS_PLAN_REVIEW;
    s.planPassed = !s.planRequired;
  } else if (kind !== "other") {
    s.replies = [...(s.replies || []), prompt].slice(-5);
    if (s.pending_proposal && (kind === "go_ahead" || kind === "answers")) { s.agreed_outcome = `${s.pending_proposal}\n\n[ユーザーの返事] ${prompt}`; s.pending_proposal = null; }
    s.approved = true; // ユーザーが見て返事をした
  }
  s.promptKind = kind;
  saveState();
  log({ event, kind, needs_outcome_check: round(needs), needs_plan_review: round(needsPlan), confidence: r.answers.prompt_kind?.confidence, usage: r.usage, latencyMs: r.latencyMs, prompt: prompt.slice(0, 500) });
  if (kind === "new_request" && !s.approved) {
    out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `jev-harness: この依頼は解釈が分かれる（${needs.toFixed(2)}）。作る前に、アウトカム（誰の何がどう変わるか）・未知・埋め方を書いてユーザーの返事を待つ。返事があるまで成果物の書き込みは止まる` } });
  }
}

// ── PreToolUse（Write/Edit）: 未確認なら拒否、範囲外に見えるなら人間に聞く ──
async function onPreToolUse() {
  const fps = filePaths();
  const scratch = input.scratchpad_dir ? String(input.scratchpad_dir) : null;
  const scoped = fps.filter((fp) => !(scratch && fp.startsWith(scratch)));
  if (!scoped.length) return;
  if (s.approved === false && s.request) {
    log({ event, denied: true, reason: "outcome_not_approved", tool: input.tool_name, files: scoped });
    return out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "jev-harness: アウトカムが未確認。作る前に、アウトカム・未知・埋め方を書いてユーザーの返事を待つ。返事があれば書き込みは通る" } });
  }
  if (s.planRequired && !s.planPassed && s.request) {
    log({ event, denied: true, reason: "plan_not_reviewed", tool: input.tool_name, files: scoped });
    return out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "jev-harness: 実装価値を審査した計画がまだ合格していない。アウトカムへの寄与と実環境での検収方法を含む計画を先に提示する" } });
  }
  const entries = scoped.map((fp) => ({ file: rel(fp), is_new: !existsSync(fp) }));
  s._preNew = { ...(s._preNew || {}), ...Object.fromEntries(entries.map((x) => [x.file, x.is_new])) }; saveState(); // PostToolUse では書いた後なので、新規かはここで覚える
  if (!apiKey || !s.request) return;
  const r = await ask({ request: clip(s.request, LIMITS.request), agreed_outcome: s.agreed_outcome ? clip(s.agreed_outcome, LIMITS.outcome) : null, files: entries }, WRITE_QUESTIONS, { apiKey, model: MODEL });
  const p = r.answers.off_scope?.noul ?? 0;
  log({ event, tool: input.tool_name, files: entries, off_scope: round(p), usage: r.usage, latencyMs: r.latencyMs });
  if (p >= OFF_SCOPE_ASK) {
    out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `jev-harness: ${entries.map((x) => x.file).join(", ")} への書き込みは依頼の範囲外に見える（${p.toFixed(2)}）。必要性をユーザーに説明し、承認後に進める` } });
  }
}

// ── PostToolUse: 事実を記録する（書いたファイル・走った検証と結果） ──
async function onPostToolUse() {
  const tool = String(input.tool_name || "");
  if (/^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/.test(tool)) {
    const fps = filePaths(); if (!fps.length) return;
    const f = s.facts.files_written;
    for (const fp of fps) if (!f.some((x) => x.file === rel(fp))) f.push({ file: rel(fp), is_new: s._preNew?.[rel(fp)] ?? false });
    saveState(); return;
  }
  if (!/^(Bash|shell|exec_command)$/.test(tool) || !apiKey) return;
  const command = String(input.tool_input?.command ?? input.tool_input?.cmd ?? "");
  if (!command) return;
  const resp = input.tool_response; const text = typeof resp === "string" ? resp : JSON.stringify(resp ?? "");
  const output = text.length > LIMITS.output ? text.slice(-LIMITS.output) : text;
  const r = await ask({ command: command.slice(0, 500), output }, COMMAND_QUESTIONS, { apiKey, model: MODEL });
  const isV = r.answers.is_verification?.noul ?? 0, passed = r.answers.passed?.noul ?? 0;
  if (isV >= 0.5) { s.facts.verification_runs.push({ command: command.slice(0, 200), passed: round(passed) }); saveState(); }
  log({ event, tool, command: command.slice(0, 200), is_verification: round(isV), passed: round(passed), usage: r.usage, latencyMs: r.latencyMs });
}

// ── Stop ──
async function onStop() {
  const msg = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  if (!msg.trim() || !s.request) return;
  if (!apiKey) { if (!s.warnedKey) { s.warnedKey = true; saveState(); out({ systemMessage: "jev-harness: TYPESAFE_API_KEY が未設定のため判定していない" }); } return; }
  const state = buildStopState({ request: s.request, agreedOutcome: s.agreed_outcome, userReplies: s.replies || [], facts: s.facts, report: msg });
  const r = await ask(state, STOP_QUESTIONS, { apiKey, model: MODEL });
  const v = verdict(r.answers, { hasOutcome: !!s.agreed_outcome, facts: s.facts });
  if (v.kind === "proposal") s.pending_proposal = msg; // 次のユーザー発話が承認なら合意アウトカムになる
  const tid = turnId();
  if (!s.turn || s.turn.id !== tid) s.turn = { id: tid, blocks: 0 };
  const rec = { event, kind: v.kind, confidence: v.confidence, answers: flat(r.answers), blocks: v.blocks.map((b) => b.id), warns: v.warns.map((w) => w.id), usage: r.usage, latencyMs: r.latencyMs, stop_hook_active: !!input.stop_hook_active, state };
  if (v.blocks.length && s.turn.blocks < MAX_BLOCKS_PER_TURN) {
    s.turn.blocks += 1; saveState(); log({ ...rec, decision: "block", attempt: s.turn.blocks });
    process.stderr.write(blockReason(v, s.turn.blocks, MAX_BLOCKS_PER_TURN) + "\n");
    process.exit(2);
  }
  if (v.kind === "plan" && v.blocks.length === 0) s.planPassed = true;
  saveState();
  if (v.blocks.length) { log({ ...rec, decision: "give_up" }); return out({ systemMessage: `jev-harness: ${MAX_BLOCKS_PER_TURN}回差し戻したが解消しなかった。人間が確認する: ${v.blocks.map((b) => b.id).join(", ")}` }); }
  log({ ...rec, decision: v.warns.length ? "warn" : "pass" });
  if (v.warns.length) out({ systemMessage: warnMessage(v) });
}

// ── helpers ──
function filePaths() {
  const direct = input.tool_input?.file_path || input.tool_input?.path || input.tool_input?.notebook_path;
  if (direct) return [String(direct)];
  if (input.tool_name !== "apply_patch") return [];
  const patch = String(input.tool_input?.command || input.tool_input?.patch || "");
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
}
function rel(fp) { const cwd = String(input.cwd || ""); const norm = (x) => x.replace(/\\/g, "/"); return cwd && norm(fp).startsWith(norm(cwd) + "/") ? norm(fp).slice(norm(cwd).length + 1) : norm(fp); }
function turnId() { return String(input.prompt_id || input.turn_id || `${sessionId}:${(s.request || "").length}`); }
function loadState() { try { return JSON.parse(readFileSync(sessPath, "utf8")); } catch { return {}; } }
function saveState() { mkdirSync(join(stateDir, "sessions"), { recursive: true }); writeFileSync(sessPath, JSON.stringify(s)); }
function log(rec) {
  if (env.JEV_HARNESS_LOG === "off") return;
  try { mkdirSync(stateDir, { recursive: true }); appendFileSync(join(stateDir, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), session: sessionId, ...rec }) + "\n"); } catch {}
}
function out(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function flat(answers) { const o = {}; for (const [k, a] of Object.entries(answers || {})) o[k] = a.type === "noul" ? round(a.noul) : { choice: a.choice, confidence: round(a.confidence) }; return o; }
function round(x) { return typeof x === "number" ? Math.round(x * 1000) / 1000 : x; }
