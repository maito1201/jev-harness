// TypeSafe System One (jev) の最小クライアント。依存なし。
// https://docs.typesafe.ai/api — POST /v1/systemone { state, model, questions } → { answers, usage }
export const ENDPOINT = process.env.JEV_HARNESS_ENDPOINT || "https://api.typesafe.ai/v1/systemone"; // テストではローカルの偽サーバーに向ける

export async function ask(state, questions, { apiKey, model = "jev-latest", timeoutMs = 12000, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("TYPESAFE_API_KEY が未設定");
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
    if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    return { answers: body.answers ?? {}, usage: body.usage ?? null, model: body.model ?? model, latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
