// jev-harness opencode plugin
// TypeSafe jev で応答の官僚主義の兆候を検出し、形式的な完了を差し戻す。
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ask } from "../../hooks/jev.mjs";
import {
  MODEL,
  PROMPT_QUESTIONS,
  WRITE_QUESTIONS,
  COMMAND_QUESTIONS,
  STOP_QUESTIONS,
  MAX_BLOCKS_PER_TURN,
  NEEDS_OUTCOME_CHECK,
  OFF_SCOPE_ASK,
  LIMITS,
} from "../../hooks/questions.mjs";
import { buildStopState, verdict, blockReason, warnMessage, clip } from "../../hooks/judge.mjs";

const env = process.env;
if (env.JEV_HARNESS === "off") {
  // Early return handled in each hook
}

const stateDir = env.JEV_HARNESS_STATE_DIR || env.OPENCODE_PLUGIN_DATA || join(homedir(), ".jev-harness");
const apiKey = env.TYPESAFE_API_KEY || "";
const sessions = new Map();

function loadState(sessionId) {
  const sessPath = join(stateDir, "sessions", `${sessionId}.json`);
  try {
    return JSON.parse(readFileSync(sessPath, "utf8"));
  } catch {
    return {};
  }
}

function saveState(sessionId, state) {
  mkdirSync(join(stateDir, "sessions"), { recursive: true });
  writeFileSync(join(stateDir, "sessions", `${sessionId}.json`), JSON.stringify(state));
}

function log(sessionId, rec) {
  if (env.JEV_HARNESS_LOG === "off") return;
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), session: sessionId, ...rec }) + "\n");
  } catch {}
}

function rel(fp, cwd) {
  return cwd && fp.startsWith(cwd + "/") ? fp.slice(cwd.length + 1) : fp;
}

function getSession(event) {
  const sessionId = String(event.session?.id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  let s = sessions.get(sessionId);
  if (!s) {
    s = loadState(sessionId);
    s.facts ||= { files_written: [], verification_runs: [] };
    sessions.set(sessionId, s);
  }
  return { sessionId, s };
}

// ── session.created / session.updated / message.updated: 発話の種類と、儀式（アウトカム確認）が要るか ──
async function onUserMessage(event) {
  const { sessionId, s } = getSession(event);
  const prompt = event.message?.content || "";
  if (!prompt.trim()) return;
  
  s.turn = { id: Date.now().toString(), blocks: 0 };
  if (!apiKey) { s.request ||= prompt; s.approved = true; saveState(sessionId, s); return; }
  
  const r = await ask({ prompt }, PROMPT_QUESTIONS, { apiKey, model: MODEL });
  const kind = r.answers.prompt_kind?.choice || "other";
  const needs = r.answers.needs_outcome_check?.noul ?? 0;
  
  if (kind === "new_request") {
    s.request = prompt; s.replies = []; s.agreed_outcome = null; s.pending_proposal = null;
    s.facts = { files_written: [], verification_runs: [] };
    s.approved = needs < NEEDS_OUTCOME_CHECK;
  } else if (kind !== "other") {
    s.replies = [...(s.replies || []), prompt].slice(-5);
    if (s.pending_proposal && (kind === "go_ahead" || kind === "answers")) { 
      s.agreed_outcome = `${s.pending_proposal}\n\n[ユーザーの返事] ${prompt}`; 
      s.pending_proposal = null; 
    }
    s.approved = true;
  }
  s.promptKind = kind;
  saveState(sessionId, s);
  log(sessionId, { event: "user_message", kind, needs_outcome_check: Math.round(needs * 1000) / 1000, confidence: r.answers.prompt_kind?.confidence, usage: r.usage, latencyMs: r.latencyMs });
  
  if (kind === "new_request" && !s.approved) {
    // Signal to opencode that outcome confirmation is needed
    await event.client?.app?.log?.({
      body: { service: "jev-harness", level: "warn", message: `この依頼は解釈が分かれる（${needs.toFixed(2)}）。作る前に、アウトカム（誰の何がどう変わるか）・未知・埋め方を書いてユーザーの返事を待つ。返事があるまで成果物の書き込みは止まる` }
    });
  }
}

// ── tool.execute.before: 未確認なら拒否、範囲外に見えるなら警告 ──
async function onToolBefore(event) {
  const { sessionId, s } = getSession(event);
  const tool = event.tool?.name || "";
  const fp = event.tool?.arguments?.file_path || event.tool?.arguments?.path || "";
  const scratch = event.tool?.arguments?.scratchpad_dir || null;
  if (!fp || (scratch && fp.startsWith(scratch))) return;
  if (s.approved === false && s.request) {
    log(sessionId, { event: "tool.before", denied: true, tool, file: fp });
    throw new Error("jev-harness: アウトカムが未確認。作る前に、アウトカム・未知・埋め方を書いてユーザーの返事を待つ。");
  }
  const isNew = !existsSync(fp);
  s._preNew = { ...(s._preNew || {}), [rel(fp, event.cwd)]: isNew };
  saveState(sessionId, s);
  
  if (!apiKey || !s.request) return;
  const r = await ask({ 
    request: clip(s.request, LIMITS.request), 
    agreed_outcome: s.agreed_outcome ? clip(s.agreed_outcome, LIMITS.outcome) : null, 
    file: rel(fp, event.cwd), 
    is_new: isNew 
  }, WRITE_QUESTIONS, { apiKey, model: MODEL });
  
  const p = r.answers.off_scope?.noul ?? 0;
  log(sessionId, { event: "tool.before", tool, file: rel(fp, event.cwd), is_new: isNew, off_scope: Math.round(p * 1000) / 1000, usage: r.usage, latencyMs: r.latencyMs });
  
  if (p >= OFF_SCOPE_ASK) {
    // Show warning via toast
    await event.client?.app?.log?.({
      body: { service: "jev-harness", level: "warn", message: `${rel(fp, event.cwd)} への書き込みは依頼の範囲外に見える（${p.toFixed(2)}）。必要なら理由を述べて進める` }
    });
  }
}

// ── tool.execute.after: 事実を記録する（書いたファイル・走った検証と結果） ──
async function onToolAfter(event) {
  const { sessionId, s } = getSession(event);
  const tool = event.tool?.name || "";
  const toolResult = event.tool?.result;
  
  if (/^(write|edit|multiEdit|notebookEdit|apply_patch)$/.test(tool)) {
    const fp = event.tool?.arguments?.file_path || event.tool?.arguments?.path || "";
    if (!fp) return;
    const f = s.facts.files_written;
    const relPath = rel(fp, event.cwd);
    if (!f.some((x) => x.file === relPath)) f.push({ file: relPath, is_new: s._preNew?.[relPath] ?? false });
    saveState(sessionId, s);
    return;
  }
  
  if (!/^(bash|shell|exec_command)$/.test(tool) || !apiKey) return;
  const command = String(event.tool?.arguments?.command ?? event.tool?.arguments?.cmd ?? "");
  if (!command) return;
  
  const output = String(toolResult ?? "").slice(-LIMITS.output);
  const r = await ask({ command: command.slice(0, 500), output }, COMMAND_QUESTIONS, { apiKey, model: MODEL });
  const isV = r.answers.is_verification?.noul ?? 0;
  const passed = r.answers.passed?.noul ?? 0;
  
  if (isV >= 0.5) { 
    s.facts.verification_runs.push({ command: command.slice(0, 200), passed: Math.round(passed * 1000) / 1000 }); 
    saveState(sessionId, s); 
  }
  log(sessionId, { event: "tool.after", tool, command: command.slice(0, 200), is_verification: Math.round(isV * 1000) / 1000, passed: Math.round(passed * 1000) / 1000, usage: r.usage, latencyMs: r.latencyMs });
}

// ── session.idle / session.compacted: 最後の応答を判定 ──
async function onSessionIdle(event) {
  const { sessionId, s } = getSession(event);
  const msg = event.message?.content || "";
  if (!msg.trim() || !s.request) return;
  if (!apiKey) { 
    if (!s.warnedKey) { s.warnedKey = true; saveState(sessionId, s); 
      await event.client?.app?.log?.({ body: { service: "jev-harness", level: "warn", message: "TYPESAFE_API_KEY が未設定のため判定していない" }});
    } 
    return; 
  }
  
  const state = buildStopState({ 
    request: s.request, 
    agreedOutcome: s.agreed_outcome, 
    userReplies: s.replies || [], 
    facts: s.facts, 
    report: msg 
  });
  
  const r = await ask(state, STOP_QUESTIONS, { apiKey, model: MODEL });
  const v = verdict(r.answers, { hasOutcome: !!s.agreed_outcome, facts: s.facts });
  
  if (v.kind === "proposal") s.pending_proposal = msg;
  
  const tid = s.turn?.id || Date.now().toString();
  if (!s.turn || s.turn.id !== tid) s.turn = { id: tid, blocks: 0 };
  
  const rec = { 
    event: "session.idle", 
    kind: v.kind, 
    confidence: v.confidence, 
    answers: flat(r.answers), 
    blocks: v.blocks.map((b) => b.id), 
    warns: v.warns.map((w) => w.id), 
    usage: r.usage, 
    latencyMs: r.latencyMs 
  };
  
  if (v.blocks.length && s.turn.blocks < MAX_BLOCKS_PER_TURN) {
    s.turn.blocks += 1; 
    saveState(sessionId, s); 
    log(sessionId, { ...rec, decision: "block", attempt: s.turn.blocks });
    await event.client?.app?.log?.({ 
      body: { service: "jev-harness", level: "error", message: blockReason(v, s.turn.blocks, MAX_BLOCKS_PER_TURN) } 
    });
    // Could throw to block, but opencode doesn't have a direct block mechanism for session.idle
    return;
  }
  
  saveState(sessionId, s);
  
  if (v.blocks.length) { 
    log(sessionId, { ...rec, decision: "give_up" }); 
    await event.client?.app?.log?.({ 
      body: { service: "jev-harness", level: "warn", message: `${MAX_BLOCKS_PER_TURN}回差し戻したが解消しなかった。人間が確認する: ${v.blocks.map((b) => b.id).join(", ")}` } 
    }); 
    return; 
  }
  
  log(sessionId, { ...rec, decision: v.warns.length ? "warn" : "pass" });
  if (v.warns.length) {
    await event.client?.app?.log?.({ 
      body: { service: "jev-harness", level: "warn", message: warnMessage(v) } 
    });
  }
}

function flat(answers) {
  const o = {};
  for (const [k, a] of Object.entries(answers || {})) 
    o[k] = a.type === "noul" ? Math.round(a.noul * 1000) / 1000 : { choice: a.choice, confidence: Math.round((a.confidence ?? 0) * 1000) / 1000 };
  return o;
}

export const JevHarnessPlugin = async ({ project, client, $, directory, worktree }) => {
  if (process.env.JEV_HARNESS === "off") return {};
  return {
    "session.created": async (event) => { await onUserMessage(event); },
    "session.updated": async (event) => { await onUserMessage(event); },
    "message.updated": async (event) => { await onUserMessage(event); },
    "session.idle": async (event) => { await onSessionIdle(event); },
    "session.compacted": async (event) => { await onSessionIdle(event); },
    "tool.execute.before": async (event) => { await onToolBefore(event); },
    "tool.execute.after": async (event) => { await onToolAfter(event); },
  };
};