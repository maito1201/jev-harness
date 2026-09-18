// hooks/run.mjs を本物のプロセスとして起動し、stdin → exit code / stdout / stderr を確かめる。jev は偽サーバー。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RUN = join(here, "..", "hooks", "run.mjs");
let server, port, nextAnswers = {}, requests = [];

before(async () => {
  server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { requests.push(JSON.parse(body)); res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "jev-test", answers: typeof nextAnswers === "function" ? nextAnswers(JSON.parse(body)) : nextAnswers, usage: { input_tokens: 100, output_tokens: 5 } })); });
  });
  await new Promise((r) => server.listen(0, r)); port = server.address().port;
});
after(() => server.close());

// 偽サーバーはこのプロセス内で動くので、hook は非同期に起動する（同期起動だとサーバーが応答できない）
function run(event, input, envExtra = {}, stateDir) {
  const env = { ...process.env, TYPESAFE_API_KEY: "test-key", JEV_HARNESS_ENDPOINT: `http://127.0.0.1:${port}/`, JEV_HARNESS_STATE_DIR: stateDir, ...envExtra };
  delete env.JEV_HARNESS; if (envExtra.JEV_HARNESS) env.JEV_HARNESS = envExtra.JEV_HARNESS;
  return new Promise((resolve) => {
    const c = spawn("node", [RUN, event], { env });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (code) => resolve({ code, out: stdout.trim() ? JSON.parse(stdout) : null, err: stderr }));
    c.stdin.end(JSON.stringify({ session_id: "s1", ...input }));
  });
}
const n = (p) => ({ type: "noul", noul: p });
const choice = (c) => ({ type: "choice", choice: c, confidence: 0.9 });
const state = (dir) => JSON.parse(readFileSync(join(dir, "sessions", "s1.json"), "utf8"));
const tmp = () => mkdtempSync(join(tmpdir(), "jh-"));

test("曖昧な依頼 → 確認を要求し書き込み拒否。返事の後は通る。明確な依頼は最初から通る", async () => {
  const dir = tmp();
  nextAnswers = { prompt_kind: choice("new_request"), needs_outcome_check: n(0.82) };
  let r = await run("UserPromptSubmit", { prompt: "ダッシュボードを見やすくして" }, {}, dir);
  assert.match(r.out.hookSpecificOutput.additionalContext, /解釈が分かれる/);
  r = await run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/p/a.js" }, scratchpad_dir: "/tmp/scr" }, {}, dir);
  assert.equal(r.out.hookSpecificOutput.permissionDecision, "deny");
  r = await run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/tmp/scr/x" }, scratchpad_dir: "/tmp/scr" }, {}, dir);
  assert.equal(r.out, null, "一時ファイルは常に通る");
  nextAnswers = { prompt_kind: choice("answers"), needs_outcome_check: n(0.1) };
  await run("UserPromptSubmit", { prompt: "1 前者 2 ある" }, {}, dir);
  nextAnswers = { off_scope: n(0.1) };
  r = await run("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/p/a.js" } }, {}, dir);
  assert.equal(r.out, null);
  const dir2 = tmp();
  nextAnswers = { prompt_kind: choice("new_request"), needs_outcome_check: n(0.1) };
  r = await run("UserPromptSubmit", { prompt: "README の typo を直して" }, {}, dir2);
  assert.equal(r.out, null, "明確な依頼には儀式を要求しない");
  assert.equal(state(dir2).approved, true);
});

test("範囲外に見える書き込みは人間に聞く（ask）。PostToolUse で事実が溜まる", async () => {
  const dir = tmp();
  nextAnswers = { prompt_kind: choice("new_request"), needs_outcome_check: n(0.1) };
  await run("UserPromptSubmit", { prompt: "売上カードの寸法を直して" }, {}, dir);
  nextAnswers = { off_scope: n(0.85) };
  let r = await run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/p/src/Sidebar.tsx" }, cwd: "/p" }, {}, dir);
  assert.equal(r.out.hookSpecificOutput.permissionDecision, "ask"); assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /src\/Sidebar\.tsx/);
  assert.equal(requests.at(-1).state.is_new, true);
  r = await run("PostToolUse", { tool_name: "Write", tool_input: { file_path: "/p/src/Sidebar.tsx" }, cwd: "/p" }, {}, dir);
  assert.deepEqual(state(dir).facts.files_written, [{ file: "src/Sidebar.tsx", is_new: true }]);
  nextAnswers = { is_verification: n(0.9), passed: n(0.97) };
  r = await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "node --test" }, tool_response: "ℹ tests 9\nℹ pass 9\nℹ fail 0" }, {}, dir);
  assert.deepEqual(state(dir).facts.verification_runs, [{ command: "node --test", passed: 0.97 }]);
  nextAnswers = { is_verification: n(0.05), passed: n(0.5) };
  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "a b" }, {}, dir);
  assert.equal(state(dir).facts.verification_runs.length, 1, "検証でないコマンドは記録しない");
});

test("Stop: 検証済みと言うが走っていない → 差し戻し（上限まで）。走っていれば通る", async () => {
  const dir = tmp();
  nextAnswers = { prompt_kind: choice("new_request"), needs_outcome_check: n(0.1) };
  await run("UserPromptSubmit", { prompt: "バグを直して", prompt_id: "t1" }, {}, dir);
  nextAnswers = { message_kind: choice("completion"), conclusion_first: n(0.9), claims_verification_passed: n(0.95), verification_matches_facts: n(0.9), remaining_work_while_done: n(0.1) };
  const stop = { last_assistant_message: "直しました。テスト全部通りました。", prompt_id: "t1" };
  let r = await run("Stop", stop, {}, dir);
  assert.equal(r.code, 2); assert.match(r.err, /差し戻し 1\/2/); assert.match(r.err, /実際に走った検証コマンドの記録に成功したものが無い/);
  r = await run("Stop", { ...stop, stop_hook_active: true }, {}, dir); assert.equal(r.code, 2);
  r = await run("Stop", { ...stop, stop_hook_active: true }, {}, dir);
  assert.equal(r.code, 0); assert.match(r.out.systemMessage, /人間が確認する/);
  nextAnswers = { is_verification: n(0.9), passed: n(0.99) };
  await run("PostToolUse", { tool_name: "Bash", tool_input: { command: "go test ./..." }, tool_response: "ok" }, {}, dir);
  nextAnswers = { message_kind: choice("completion"), conclusion_first: n(0.9), claims_verification_passed: n(0.95), verification_matches_facts: n(0.9), remaining_work_while_done: n(0.1) };
  r = await run("Stop", { ...stop, prompt_id: "t2" }, {}, dir);
  assert.equal(r.code, 0); assert.equal(r.out, null);
  const sent = requests.at(-1); assert.equal(sent.state.facts.verification_runs[0].command, "go test ./..."); assert.equal(sent.state.agreed_outcome, null);
  const log = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((l) => l.event === "Stop").map((l) => l.decision);
  assert.deepEqual(log, ["block", "block", "give_up", "pass"]);
});

test("提案 → 承認で合意アウトカムが保存され、以後 outcome_drift を見る", async () => {
  const dir = tmp();
  nextAnswers = { prompt_kind: choice("new_request"), needs_outcome_check: n(0.9) };
  await run("UserPromptSubmit", { prompt: "ハーネスを作って" }, {}, dir);
  nextAnswers = { message_kind: choice("proposal"), outcome_paraphrase: n(0.05), assumed_instead_of_asking: n(0.05) };
  let r = await run("Stop", { last_assistant_message: "アウトカム: レビュワーが読む前に差し戻しが止まる。確認をください" }, {}, dir);
  assert.equal(r.code, 0); assert.equal(state(dir).pending_proposal.slice(0, 5), "アウトカム");
  nextAnswers = { prompt_kind: choice("go_ahead"), needs_outcome_check: n(0.1) };
  await run("UserPromptSubmit", { prompt: "OK" }, {}, dir);
  assert.match(state(dir).agreed_outcome, /レビュワーが読む前に.*\[ユーザーの返事\] OK/s); assert.equal(state(dir).pending_proposal, null);
  nextAnswers = { message_kind: choice("completion"), conclusion_first: n(0.9), claims_verification_passed: n(0.1), remaining_work_while_done: n(0.1), outcome_drift: n(0.9) };
  r = await run("Stop", { last_assistant_message: "テスト 9/9。完了。" }, {}, dir);
  assert.equal(r.code, 2); assert.match(r.err, /outcome_drift/);
  assert.match(requests.at(-1).state.agreed_outcome, /レビュワー/);
});

test("fail-open: サーバー断・キー無し・off ではブロックしない", async () => {
  const dir = tmp();
  nextAnswers = { prompt_kind: choice("new_request"), needs_outcome_check: n(0.1) };
  await run("UserPromptSubmit", { prompt: "作って" }, {}, dir);
  let r = await run("Stop", { last_assistant_message: "できた" }, { JEV_HARNESS_ENDPOINT: "http://127.0.0.1:9/" }, dir);
  assert.equal(r.code, 0); assert.match(r.out.systemMessage, /スキップ/);
  r = await run("Stop", { last_assistant_message: "できた" }, { TYPESAFE_API_KEY: "" }, dir);
  assert.equal(r.code, 0); assert.match(r.out.systemMessage, /未設定/);
  r = await run("Stop", { last_assistant_message: "できた" }, { TYPESAFE_API_KEY: "" }, dir);
  assert.equal(r.out, null, "キー無し警告は1回だけ");
  r = await run("Stop", { last_assistant_message: "できた" }, { JEV_HARNESS: "off" }, dir);
  assert.equal(r.code, 0); assert.equal(r.out, null);
  const dir2 = tmp();
  await run("UserPromptSubmit", { prompt: "作って" }, { TYPESAFE_API_KEY: "" }, dir2);
  r = await run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/p/a" } }, { TYPESAFE_API_KEY: "" }, dir2);
  assert.equal(r.out, null, "分類できないときは門を閉じない");
});
