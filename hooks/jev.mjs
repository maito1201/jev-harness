// TypeSafe System One (jev) の最小クライアント。依存なし。
// https://docs.typesafe.ai/api — POST /v1/systemone { state, model, questions } → { answers, usage }
export const ENDPOINT = process.env.JEV_HARNESS_ENDPOINT || "https://api.typesafe.ai/v1/systemone"; // テストではローカルの偽サーバーに向ける

import {ReviewError} from './review-budget.mjs';
export async function ask(state, questions, { apiKey, model = "jev-latest", timeoutMs = 12000, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new ReviewError('credentials',"TYPESAFE_API_KEY が未設定");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model, questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail=(await res.text()).slice(0,300);
      throw new ReviewError(detail.includes('max_tokens_exceeded')?'input_budget':res.status>=500?'api_unavailable':'api_error',`jev HTTP ${res.status}: ${detail}`);
    }
    const body = await res.json();
    return { answers: body.answers ?? {}, usage: body.usage ?? null, model: body.model ?? model, latencyMs: Date.now() - t0 };
  } catch(e) {
    if(e instanceof ReviewError)throw e;
    throw new ReviewError(e.name==='AbortError'?'api_timeout':'api_transport',e.name==='AbortError'?'jev request timed out':String(e.message));
  } finally {
    clearTimeout(timer);
  }
}
