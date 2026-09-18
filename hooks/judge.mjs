// 純粋な判定ロジック（I/O なし）。テストはここを叩く。
import { BLOCK, WARN, MISSING_BLOCK, MISSING_WARN, LIMITS, POLICY, PRESENCE, FIX, FACT_RULE } from "./questions.mjs";

export function clip(s, head, tail = 0) {
  if (typeof s !== "string") return "";
  if (s.length <= head + tail) return s;
  return tail > 0 ? `${s.slice(0, head)}\n…（中略 ${s.length - head - tail} 字）…\n${s.slice(-tail)}` : s.slice(0, head) + "…";
}

// Stop の state。facts はコードが集めた事実（jev に真偽を委ねない）
export function buildStopState({ request, agreedOutcome = null, userReplies = [], facts = {}, report }) {
  return {
    request: clip(request, LIMITS.request),
    agreed_outcome: agreedOutcome ? clip(agreedOutcome, LIMITS.outcome) : null,
    user_replies: userReplies.slice(-LIMITS.laterCount).map((m) => clip(m, LIMITS.laterEach)),
    facts: {
      files_written: (facts.files_written || []).slice(-LIMITS.facts),
      verification_runs: (facts.verification_runs || []).slice(-LIMITS.facts),
    },
    report: clip(report, LIMITS.messageHead, LIMITS.messageTail),
  };
}

export function noul(answers, id) {
  const a = answers?.[id];
  return typeof a?.noul === "number" ? a.noul : null;
}

function level(answers, id) {
  const p = noul(answers, id);
  if (p === null) return null;
  if (PRESENCE.has(id)) return p <= MISSING_BLOCK ? "block" : p <= MISSING_WARN ? "warn" : null;
  return p >= BLOCK ? "block" : p >= WARN ? "warn" : null;
}

// answers + state → { kind, confidence, blocks: [{id,p}], warns: [{id,p}] }
export function verdict(answers, { hasOutcome = false, facts = {} } = {}) {
  const k = answers?.message_kind;
  const kind = POLICY[k?.choice] ? k.choice : "other";
  const policy = POLICY[kind];
  const blocks = [], warns = [];
  const push = (id, l) => (l === "block" ? blocks : warns).push({ id, p: noul(answers, id) });
  for (const id of policy.block) { const l = level(answers, id); if (l) push(id, l); }
  for (const id of policy.warn) { if (level(answers, id)) push(id, "warn"); }
  if (hasOutcome) for (const id of policy.needsOutcome || []) { const l = level(answers, id); if (l) push(id, l); }
  // 事実との照合: 「検証済み」と言うなら、成功した検証の記録が要る。記録が空なら jev に聞かず code が決める
  if (FACT_RULE.kinds.includes(kind) && (noul(answers, FACT_RULE.claim) ?? 0) >= BLOCK) {
    const passedRuns = (facts.verification_runs || []).filter((r) => r.passed >= 0.5);
    const m = noul(answers, FACT_RULE.match);
    if (passedRuns.length === 0 || (m !== null && m <= MISSING_BLOCK)) push(FACT_RULE.match, "block");
    else if (m !== null && m <= MISSING_WARN) push(FACT_RULE.match, "warn");
  }
  return { kind, confidence: typeof k?.confidence === "number" ? k.confidence : null, blocks, warns };
}

export function blockReason(v, attempt, max) {
  const lines = v.blocks.map(({ id, p }) => `- ${FIX[id]}（${id} ${fmt(id, p)}）`);
  return [`jev-harness: 人間に見せる前に直す点がある（差し戻し ${attempt}/${max}、応答の種類: ${v.kind}）。`, ...lines].join("\n");
}
export function warnMessage(v) {
  return `jev-harness 注意（${v.kind}）: ` + v.warns.map(({ id, p }) => `${FIX[id]}（${fmt(id, p)}）`).join(" / ");
}
function fmt(id, p) { return p === null ? "記録なし" : PRESENCE.has(id) ? `あり ${p.toFixed(2)}` : p.toFixed(2); }
