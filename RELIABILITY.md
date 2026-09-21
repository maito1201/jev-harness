# Reliability repair — 2026-09-21

The failure target is unsupported factual answers, substituting a proxy for the
requested capability, and continuing work after evidence no longer supports it.
Hook installation alone does not establish this target.

## Changes

- Every answer category is checked against actual tool observations. Assistant
  statements are context, never evidence. Truthfulness is classified separately
  from completion: supported / explicitly limited / unsupported / unclear.
- Outcome preservation and experiment validity are checked for every answer.
  Existing pre-execution and source-bound verification gates remain active.
- Stop no longer silently succeeds without a report. It can read the current
  turn from a transcript; stale turns are not accepted as the current answer.
- Entry, errors, review results and report hash are logged with turn IDs.
- Read-only observations are captured. Transcript observations also work when
  PostToolUse has not produced a paired receipt; these are NOT completion receipts.
- A continuation such as `早くやれ` preserves the existing task and approval.

## Evidence and limits

31 local control/adapter tests passed. Eight fixed bad/good cases ran twice
against the real Jev API and hook subprocess: 16/16 matched after correcting
false rejection of limited answers. The initial failures are retained in the
workspace report directory; cases and expected results were not changed.
This is a small development regression set, not a held-out accuracy estimate.

`node bin/health.mjs LOG_JSONL SESSION_ID` reports observations without asserting
that missing logs prove nonexecution. `inspect-host.mjs` can inspect host metadata;
its standalone mode is configuration evidence, not desktop execution evidence.

The installed predecessor had only UserPromptSubmit trusted. Stop/PostToolUse
were `modified`; PreToolUse was `modified` and disabled. Reinstallation alone
does not repair trust. Review exact handlers and activate them through Codex.

Stop is an end-of-turn continuation hook, not a guarantee that streamed text is
hidden before review. These controls do not make arbitrary ML research correct.
They cannot detect every invalid premise, nor prevent a host from skipping hooks.
Model judgments can still be wrong; independent domain checks remain necessary.
