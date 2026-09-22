# Global bug-report agent-first CLI contract / WHY

`ravi feedback send --kind bug` already exists, but it is a short inbox note
for the organization. Luís asked for a dedicated, **global** bug surface:
structured evidence, sanitization, tracking id, and an agent-first collect
step that does not POST until the dossier is ready.

The brake decision is the same question as feedback: does `bug report` stay
on the machine or leave it? `src/bug-report/client.ts` authenticates with
stored cloud credentials (`ravi login`) and POSTs a mapped Console
`createBodySchema` body to `/api/cli/bugs` (`title`, `summary`,
`severity`, required `payload` holding the full dossier; UUID refs only).
The record is attributed to the authenticated user and the CLI cannot
retract it. That is external publication — the Manual v2 write brake
applies. Hence `report` is dry-run by default and `--execute` performs
the real submission.

Two ordering rules keep the brake honest:

- **Brake before auth.** The first call is a collection prompt, not a
  payload rehearsal that needs credentials. An agent can start the flow on a
  machine that never ran `ravi login`.
- **Validation before the brake outcome matters.** A broken dossier or
  illegal `--severity` fails with `PAYLOAD_INVALID` (exit 2) even in
  dry-run — a plan for an unsendable payload is noise.

Org and project stay optional **inside** the dossier. The command is global
so the same CLI works regardless of which Console org the user last selected;
those refs are hints for triage, not a scope gate.

`ravi feedback` is intentionally not replaced. Feedback stays the lightweight
inbox. Bugs need reproduction, environment, and redaction — a different
schema and a different Console API.

After `--execute` succeeds, the same session should hear when Console
changes that bug's status. Console push-delivers
`watch.console.bug.status` only to installations that subscribed to that
bugId. The CLI therefore calls `POST /api/cli/bugs/:id/subscribe` and
arms a `ravi.watch.console.bug.status` trigger filtered to that id.
A shared "all my bugs" trigger would wake this session for bugs filed
elsewhere; the per-bug filter is the isolation boundary. Subscribe or
trigger failure is a warning: the dossier already left the machine.

Follow-up diagnosis often arrives after the first dossier. Without an
append verb, agents file a second report and split the status feed.
`bug comment` is the same publication class as `bug report` (it leaves
the machine and cannot be retracted from the CLI), so it keeps the
`--execute` brake and the same sanitization rules. Idempotency is
Console-owned: the CLI sends a stable `Idempotency-Key` derived from the
bug id plus the sanitized body so a retried `--execute` does not create
a second comment.

The always-on session prompt is a small paragraph, not a second skill: when
the session actually hits a product/runtime bug, ask once; if the user says
yes, run `ravi bug report`. If more evidence arrives later, append it with
`ravi bug comment <id>` on that same id. Spam and unsolicited `--execute`
would make the feature unusable.
