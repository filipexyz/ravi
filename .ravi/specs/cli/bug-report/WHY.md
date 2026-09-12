# Global bug-report agent-first CLI contract / WHY

`ravi feedback send --kind bug` already exists, but it is a short inbox note
for the organization. Luís asked for a dedicated, **global** bug surface:
structured evidence, sanitization, tracking id, and an agent-first collect
step that does not POST until the dossier is ready.

The brake decision is the same question as feedback: does `bug report` stay
on the machine or leave it? `src/bug-report/client.ts` authenticates with
stored cloud credentials (`ravi login`) and POSTs to Console
`/api/cli/bugs`. The record is attributed to the authenticated user and the
CLI cannot retract it. That is external publication — the Manual v2 write
brake applies. Hence `report` is dry-run by default and `--execute` performs
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

The always-on session prompt is a small paragraph, not a second skill: when
the session actually hits a product/runtime bug, ask once; if the user says
yes, run `ravi bug report`. Spam and unsolicited `--execute` would make the
feature unusable.
