# Bounded recovery (2026-09-22)

Observed incident: session `01a0c474-1989-7e12-a3aa-f15a70dbfa49`
repeated `joint_context_required` in action, report and prompt review. The
session remained in design with five queued user messages. Diagnosis depended
on the same remote reviewer; Stop returned another block indefinitely.

Acceptance: unavailable review, oversized context and changing rejected reports
must not lock out diagnosis or create an unlimited Stop loop. They must not
authorize edits/execution or certify completion. Subprocess regression tests
exercise these properties with a controlled failing provider.

- Native `Read` and the narrow PowerShell command `Get-Content -LiteralPath
  'path'` (optional `-TotalCount N` or `-Tail N`) are locally recognized before
  source snapshots and network review. An exact single `functions.exec` wrapper
  calling `tools.exec_command` with JSON arguments is supported. Scripts,
  pipelines, interpolation, redirects and additional calls take normal review.
  Host permissions still apply; observations are retained through PostToolUse.
- Action classification receives operation and sources, not task history.
  Authorization and semantic gates retain full request/correction context.
- Three Stop rejections without an actual phase advance end automatic
  continuation with a `systemMessage` declaring the task incomplete and the
  response unapproved. This is **not** a successful review. The adapter cannot
  replace the assistant's final text; the host must display the accompanying
  notice. This deliberately bounds retries rather than promising that no
  unverified assistant text can ever be shown.
- In this recovery state, effects remain denied and diagnosis remains possible.
  A real user message reopens review, preserving pending messages and evidence.
  Replayed hook feedback does not reset the budget or become authorization.
  A reviewed recovery plan can leave the formerly terminal `halted` phase,
  restarting from prerequisite verification without restoring old receipts.
- The fixed incomplete-status response exits before snapshots and external
  review. It asserts no successful outcome.

Limits: this does not guarantee semantic review will eventually succeed or
repair a provider outage. It guarantees bounded hook continuation and a local
diagnostic route under those failures. Storage failure or an externally killed
hook still requires host-level handling. Existing threads may retain old hooks;
the updated plugin must be loaded in a new thread.

## Validation recorded

- `npm test`: 68 passed, 0 failed.
- `node eval/recovery-replay.mjs INCIDENT_SESSION_JSON [PLUGIN_ROOT]` passed
  against a copy of the incident above, both from the repository and installed
  version `0.1.0+codex.20260922021232`. API access was disabled. Local diagnosis,
  bounded Stop, denied mutation, preserved request/queue and unchanged production
  state were asserted. Installed runtime hashes match the tested source.
- Plugin and skill validators passed. The updated local plugin was installed.
- Live desktop hook activation could not be inspected: the app-server control
  socket returned Windows error 10050. No live desktop completion is claimed;
  installed-runtime replay is subprocess validation, not a new desktop task.

## Bounded review inputs (2026-09-22, second pass)

Observed in session `57f27e07-ab87-445e-a67c-27dedb1dcdcd`: read-only commands
that mention several files, PostToolUse results with large output, and Stop
reviews of a long session all exceeded the 24KB review budget. Every
partitioned review returned `joint_context_required` (4 of 4), so those paths
were deterministic dead ends: repeated denials, a session-wide lock through
`unreviewed_result`, and three Stop blocks per turn.

- Side-effect classification receives the operation only. Referenced file
  contents are loaded after a read is allowed, for effect gates that need them.
- Command output sent to a reviewer is clipped to head and tail with its
  `output_hash`; the full output stays in state.
- Stop reviews send a bounded window: all verification runs (including failed
  and stale ones) first, then the newest observations, with an explicit
  `evidence_window` count. Nothing is deleted from state.
- A result whose review fails three times is archived as unreviewed evidence
  (`passed=false`, authorizes nothing) and stops blocking later operations.

Regression tests cover each path with a controlled reviewer. The mock reviewer
answers `independent` for partitioned reviews, so the live `required` behaviour
is avoided rather than reproduced.
