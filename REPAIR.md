# Long-session review repair

Scope: command hooks in `hooks/enforce.mjs`. No stock research files or production
session JSON files are edited by this repair. The OpenCode adapter is unchanged.

## Fixed invariants

- User input is durably queued **before** calling Jev. Failure does not revoke an
  existing approval or erase the request/corrections. Unreviewed input blocks
  mutation/execution until normal review succeeds. Read-only diagnosis remains
  possible. A continuation without a request cannot create approval. Pure
  continuation is audited without changing the requirement fingerprint.
- When upgrading a session with no request, or when the host omits the initial
  UserPromptSubmit event, actual user transcript messages can
  be queued and reviewed in order. Assistant messages cannot restore authorization.
  Old truncated evidence cannot be reconstructed if the host transcript is gone;
  mismatched output hashes are exposed as incomplete evidence.
- Full transcript messages, tool outputs and unsuccessful/obsolete execution
  records are retained. Exact canonical duplicates may be removed; equal output
  with different provenance/status is not a duplicate. Current successful receipt
  permissions still require matching request and source fingerprints.
- Transport budgeting includes JSON, UTF-8, questions and metadata. First split
  only questions while keeping all evidence. If necessary, split raw evidence
  losslessly with whole-record hashes and offsets. Every batch and every pair of
  batches is examined against the full mandatory request, corrections and report.
  The most adverse score is retained; choices cannot be majority-voted into a pass.
  Factual support requires a complete witness for the entire report in at least
  one slice, with no contradiction/uncertainty in any other slice. Mere absence
  in a slice is not a positive vote; all-absent evidence remains unverified.
  Missing answers, disagreement and a need for larger joint context stop review.
- Pairwise review is **not** a proof of arbitrary higher-order consistency. It
  cannot authorize an inference that needs more jointly visible evidence. Jev's
  semantic judgments can still be wrong; the code guarantees coverage and
  conservative aggregation, not semantic omniscience. A bounded report/check with
  its full reference is necessary when joint context does not fit.
- Mandatory context is never truncated. If it cannot fit, or evidence requires
  more than 64 batches, return `input_budget`, retain it and do not advance.
  A 45-second review budget leaves time before the 60-second host timeout.
  Completed exact-request reviews are persisted and reused on retry; changed
  context, evidence, endpoint or questions invalidate affected cache entries.
- API transport/timeouts/HTTP errors are distinct from content rejection. A
  transient failure gets one bounded retry; failed multi-question calls may be
  retried as individual questions with identical evidence. No error is a pass.
- Documentation edits are evaluated as proposed artifacts, not executed tests.
  An edit review cannot set `planPassed`; only a reviewed, approved plan advances
  design. Denial names the failed criterion, value and a recovery action without
  inventing a defect location the classifier did not provide.
- Stop rejection/continuation uses JSON `decision: block` with exit zero. In an
  actual Windows host probe, native exit code 2 was surfaced as exit code 1 and
  treated as hook execution failure; the portable JSON contract avoids that.
  Plan coverage is judged against the complete request/plan, independently of
  the separate full evidence audit of any factual assertions.
  A purely prospective plan is separately classified and checked with zero
  positive evidence. Only a `limited` factual verdict can take that route; it
  certifies no observations. Raw records remain available for subsequent checks.
  A plan containing empirical claims takes the full evidence path instead.

## Validation commands

`npm test` now includes both `.js` and `.mjs` tests. The regression suite exercises
the hook subprocess against a controlled fake provider, including long Japanese
records, huge output, duplicate/provenance handling, middle failures, distant
contradictions, request recovery, approval and phase gates, and API error paths.
Assertions include lossless reconstruction and negative controls; test counts
alone do not establish real provider or host behavior.

`node eval/workflow-live.mjs <output.json>` uses real Jev with an isolated fixed
four-input fixture, including wrong evaluator controls and blocked early execution.

`node eval/review-budget-live.mjs <output.json> [byte-budget]` uses real Jev with
486 KB of synthetic Japanese evidence (including duplicates and an old failure).
It records failure rather than claiming success during provider outages.

Desktop validation is separate: install via the plugin-creator cachebuster flow,
review/trust and enable the four local hooks, create a **new** task, and correlate
its host events and plugin log session ID. `hooks/list`, fake-provider tests and
direct subprocess runs do not establish desktop enforcement. Existing tasks are
not assumed to reload the new installation.

## API sizing reference

The [provider model documentation](https://docs.typesafe.ai/models) describes two
token budgets (whole request and state plus longest question). Bytes are a
conservative local transport bound, not an exact tokenizer. Provider limit errors
remain fail-closed and cause a smaller budget on the next retry. Runtime provider
overload (including HTTP 503/529) is not evidence that a plan failed semantically.
