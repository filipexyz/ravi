# Feedback agent-first CLI contract / WHY

The brake decision hinged on one question: does `feedback send` stay on the
machine or leave it? Inspection of `src/feedback/client.ts` settled it —
`submitFeedback` authenticates against stored cloud credentials and POSTs to
the Ravi Console at `/api/cli/feedback`. The record lands in the
organization's feedback inbox (`<console>/org/feedback`), attributed to the
authenticated user, and the CLI offers no way to retract it. That is external,
audience-facing publication: the strongest case for the Manual v2 write brake
short of destructive deletion. Hence `send` is dry-run by default and
`--execute` performs the real submission.

Two ordering rules keep the brake honest:

- **Brake before auth.** The plan is built locally from normalized,
  content-minimized metadata, so a dry-run needs no credentials, exposes no
  feedback body or destination override, and produces zero network traffic.
  An agent can rehearse feedback on a machine that never ran `ravi login`.
- **Validation before the brake outcome matters.** Invalid `--kind`,
  `--severity`, broken `--metadata-json` or an empty message fail with the
  pre-existing `PAYLOAD_INVALID` CloudAuthError code (exit 2) even in dry-run —
  a plan for an unsendable payload would be noise.

One integration subtlety: the domain already had its own error funnel
(`runFeedbackCommand` → CloudAuthError → exit codes). `contractDryRun` throws
`ContractError` inside that funnel, and `cloudAuthErrorFromUnknown` would
happily wrap it as `SERVER_UNAVAILABLE` (exit 1) — silently defeating the
brake. The funnel therefore rethrows `ContractError` untouched before any
wrapping.

Skill gap: `feedback` ships no SKILL.md and no doc teaches the command today.
The gap is registered in the spec's consumers section; the future skill must
teach `--execute` and the plan-review step from day one.
