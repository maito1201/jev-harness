# Lifecycle gates (Codex / Claude command hooks)

The command hook runtime is hooks/enforce.mjs, invoked by hooks/run.mjs.
PreToolUse reviews all operations, including freeform patches and shell commands.
It checks the requested behavior against code, not only file paths. Expansion
requires a completed, successful small check tied to the current request and
source fingerprint. Changing source invalidates that evidence.

Stop rejects unsupported completion claims without a retry-count escape.
Missing API answers and communication errors do not authorize execution.
The exact message `審査不能のため停止中です。完了とは扱っていません。`
can report an unavailable reviewer without claiming completion.

Source and relevant output are sent to the configured TypeSafe API for review.
Do not assume a previous design-summary permission covers code disclosure.
For the current owner, permission to send code and results was explicitly given.

Validation: node --test uses mock judgments for deterministic control flow.
eval/phase-gates-live.mjs uses real Jev in an isolated temporary project and
executes a small behavioral test. Neither proves that a particular desktop host
has loaded the hook or honors its denial. Verify that separately after loading.

Limits: semantic review can misclassify. A source fingerprint covers the scanned
project source, not all external data, dependencies, or arbitrary side effects.
Asynchronous process continuation is not yet credited as successful evidence.
The legacy OpenCode adapter and standalone judge are separate implementations;
the lifecycle guarantees described here do not apply to those adapters.
