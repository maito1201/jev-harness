# Repair validation — 2026-09-21

Status: implementation and reinstall performed; the requested end-to-end outcome is **not yet demonstrated**. Do not treat this document as a completion certificate.

## Controlled regression tests

`node --test` covers the existing checks and lossless Japanese evidence fragmentation, provenance-sensitive deduplication, distant contradictions, failures within evidence, missing approvals, forbidden phase skipping, false completion, API failure recovery and document-edit review. These use a controlled provider; they do not establish real Jev accuracy.

## Real Jev, isolated subprocesses

`.smoke-state/workflow-repair-live.json`: 17 lifecycle events passed in the isolated four-input fixture. Actual scripts ran; early execution was denied; independent evaluator negative controls ran; changing the evaluation criteria invalidated prior approvals. This was not a Codex host integration test.

`.smoke-state/long-plan-live.json`: 586,958 bytes of synthetic Japanese conversation and tool evidence, including duplicates and a middle failure. The prospective plan reached semantic review without a token-limit error, but plan coverage failed the unchanged 0.8 threshold. The latest experiment with an expanded rubric scored 0.65; that rubric change was discarded. The earlier original-rubric run scored 0.78. Neither is a pass. Evidence was retained, not certified as successful.

`.smoke-state/review-budget-live.json` (if present): direct real-provider divided-evidence testing is separate from both the hook subprocess and host tests. Pairwise review is conservative and cannot establish arbitrary higher-order relationships; `joint_context_required` is an unresolved review, never success.

## Actual Codex host

Task `01a0c2f4-bbc3-7931-9bdb-943308a63986` used ordinary app-server user input and installed plugin `0.1.0+codex.20260921075317`. Host notifications in `.smoke-state/host-normal-input.json` show UserPromptSubmit, PreToolUse, PostToolUse and Stop activity. The original request was approved. JSON Stop blocking was recognized as `blocked` and the host resumed the assistant, unlike the earlier Windows exit-code path.

The plan did **not** advance: coverage scored 0.62. Subsequent empirical reports required joint evidence and remained blocked. The 180-second harness observation ended without workflow completion. Thus host hook execution and continuation are observed, but successful host workflow completion is not.

Tool-created task prompts arrived as tool output rather than normal user messages. They were not promoted to user authorization. Host-injected environment-only messages are preserved as context, not recovered as user requests.

## Remaining work

Resolve semantic plan rejection and joint-evidence handling without weakening criteria, discarding adverse evidence or fabricating authorization. Successful fake-provider tests and successful isolated fixture execution do not satisfy this remaining acceptance condition.

Production session state and the stock research project were not edited manually. Reinstallation uses plugin-creator cachebuster and `codex plugin add`; enabled/trusted hook hashes are managed through the host config API. Existing tasks are not assumed to reload the plugin.
