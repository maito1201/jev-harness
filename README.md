# jev-harness

エージェントが実装に入る前と人間へ完了を伝える前に、計画の価値・範囲外の変更・アウトカムを実証していない完了宣言を差し戻す仕組み。Claude Code / Codex で動く hook と、エージェントが自分で呼ぶ検査 CLI の2つ。
判定は TypeSafe の System One モデル **jev**（1問 200〜600ms・入力 $0.042/M トークン）。コードが事実を集め、jev は意味の照合だけを担う。

判定サブエージェント（LLM as a judge）は1回 42K〜128K トークン・1タスク 561K で実用にならなかった（autopoiesys 2026-09 の実測）。jev は1回 500〜2,500 トークンなので、書き込みごと・ターンごとに挟める。

## 仕組み

| いつ | コードが集める事実 | jev に聞くこと | 結果 |
|---|---|---|---|
| UserPromptSubmit | 依頼文 | 発話の種類 / アウトカム確認と計画審査が必要か | 曖昧ならアウトカム確認、非自明な開発なら計画を要求 |
| Stop（計画） | 依頼・合意アウトカム・計画 | 全範囲を扱うか / 実装する価値があるか / アウトカムを観測できるか | 不足なら差し戻し。合格した計画だけ実装ゲートを開く |
| PreToolUse（Write/Edit/apply_patch） | 書き込み先・新規か | 計画審査済みか / 各ファイルが依頼の範囲内か | 未審査・範囲外なら Codex でも実行前に拒否 |
| PostToolUse（Bash） | コマンドと出力の末尾 | 検証コマンドか / 成功したか | `facts.verification_runs` に記録 |
| PostToolUse（Write/Edit） | 書いたファイル | — | `facts.files_written` に記録 |
| Stop（完了） | 依頼・合意アウトカム・事実・最後の応答 | 完了主張が実行記録と合うか / 合意アウトカムを実環境で観測したか | 不足なら差し戻し（同ターン2回まで）→ その後は人間へ |

Stop で見る問いは、作者が実務で受けた差し戻しの型（結論と成果物の場所が先頭に無い・制作過程を書く・依頼のすり替え・頼まれていない変更・仮定で進める・完了と言いつつ未了）と、数学の証明で分かれた穴の型（手抜き・網羅漏れ・循環）から選ぶ。実例の無い問いは入れない。
「検証済み」の主張は jev に真偽を委ねず、記録された検証コマンドに成功したものが無ければコードが差し戻す。
承認された提案文は「合意アウトカム」として保存し、完了報告が代理指標（テスト・件数）で成功を言っていないかを照らす。

問い・閾値・差し戻し文は `hooks/questions.mjs` の1ファイル。人間がレビューするのはここだけ。

## エージェントが自分で呼ぶ検査（bin/jev-check.mjs）

hook の差し戻しは2回まで。難しい仕事では、見せる前に自分で検査する。`skills/jev-harness/SKILL.md` がいつ使うかを伝える。

| mode | 入力 | 出力 | 実測（√2 の無理性） |
|---|---|---|---|
| `rank` | 主張と方針スケッチ複数 | 見込み Score 0〜2 の順位 | 偶奇 1.98・素因数 1.97 / 「代数的数だから」0.12・小数展開 0.01 |
| `gaps` | 主張・下書き・ステップ列 | 循環・手抜き・場合分け漏れ・未証明の補題・立証度、怪しいステップ番号 | 誤った4段目 0.39（正しい段は 0.86〜0.97） |
| `scope` | 依頼とファイル一覧 | 各ファイルの範囲外度 | NightsCard 0.08 / 新規 Sidebar 0.83 |

## インストール

```bash
# Claude Code
claude plugin marketplace add maito1201/jev-harness && claude plugin install jev-harness@jev-harness
# Codex CLI で marketplace を登録
codex plugin marketplace add maito1201/jev-harness
# その後、Codex デスクトップのプラグインディレクトリから jev-harness をインストール
# opencode
cp -r .opencode ~/.config/opencode/  # グローバル
# またはプロジェクトごと:
cp -r .opencode <your-project>/
```

Codex はプラグインの有効化だけでは未管理 hook を実行しません。`hooks/hooks.json` の内容をレビューして信頼済みにし、新しいタスクで動作確認してください。
Codex デスクトップでは互換マニフェスト `.codex-plugin/plugin.json` の `hooks` 宣言を検出経路として使います。

opencode では `.opencode/plugins/jev-harness.mjs` が自動で読み込まれます。`TYPESAFE_API_KEY` 環境変数を設定してください。

API キーは環境変数 `TYPESAFE_API_KEY`。1Password なら `export TYPESAFE_API_KEY=$(op read "op://<vault>/<item>/credential")`。キーが無い・API 断のときは判定せず警告だけ（fail-open）。
止める: `JEV_HARNESS=off`。記録だけ止める: `JEV_HARNESS_LOG=off`。

## 記録と反証

判定は `~/.jev-harness/log.jsonl`（`CLAUDE_PLUGIN_DATA` があればその下）に1行ずつ残る。差し戻し（decision=block）のうち人間が「正しい応答だった」と思った行の割合が、この設計の反証になる。

```bash
npm test                          # 偽サーバーで hook の入出力を検査
TYPESAFE_API_KEY=… npm run eval   # eval/cases.json（差し戻しの実例16件）を本物の jev に流し、期待と比べる
```

## できないこと

- 証明やコードが「正しい」ことの判定。jev は計画と報告の意味を照合する判定器で、算術（92,670² の検算の捏造は 0.34 で見抜けない）と多段推論はできない。数値はコードで再計算し、正しさはテスト・実行結果・人間が決める
- サブエージェントの審査（SubagentStop に依頼文が渡らない）
- 方針の重複検出は言い換え 0.98、部分的に重なる別方針 0.74 で分離が弱い
