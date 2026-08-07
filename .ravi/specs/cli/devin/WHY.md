# Devin agent-first CLI contract / WHY

Devin sessions cost real money: every created session and every steering
message runs on a paid external service metered in ACUs. An agent that "just
tries" `devin sessions create` to see what happens has already spent budget —
that is the externality the brake exists for. `create` and `send` therefore
dry-run by default, and their plans are built to be genuinely reviewable:
prompt size and a bounded preview, the ACU ceiling and where it came from,
tags/repos/mode, and the secret COUNT (never the values — secrets in a
dry-run plan would leak into logs and transcripts).

The unbraked pair is deliberate, not leftover:

- `terminate` stops a billable session — braking the spend-stop repeats the
  prox `cancel` mistake in reverse.
- `sync` is a cache refresh: remote reads, local writes.

`archive` is different: it changes state in the external Devin service and
this CLI exposes no inverse. It therefore requires confirmation before client
construction even though it starts no work and consumes no new ACUs.

Insights has the same invocation-level split. Reading existing insights and
refreshing a local cache is routine. `--generate` asks the paid provider to
create/update analysis, so only that branch is confirmed. Its dry-run happens
before client construction, provider calls and cache writes.

One ordering decision matters for operability: the brake fires BEFORE
`createDevinClientFromEnv`. The dry-run must work on machines without Devin
credentials — inspection should never require the keys that execution does.
The client construction moved below the brake for exactly that reason.

Known consumers that teach `devin sessions create|send` (tasks skill
delegation protocol, docs/task-profiles-catalog-v1.md) include `--execute` in
their real-dispatch steps. Their plain insights examples remain unbraked. No
dedicated `devin` skill exists yet — the gap is registered in SPEC.md.
