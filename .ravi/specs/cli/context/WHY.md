# Context agent-first CLI contract / WHY

Contexts are the auth substrate every other surface stands on: an `rctx_*` key
IS the credential a session, worker or external CLI uses to act as itself. That
shapes this migration in two ways the other domains did not need.

First, the brake targets the two ops that destroy working auth. `context
revoke` cascades to descendant contexts by default, so a mistyped id or an
agent "cleaning up" can silently kill the auth of live workers — that is
exactly the class of irreversible, wide-blast mutation the write brake exists
for. `context credentials remove` deletes a stored key from the local store;
the key cannot be recovered from the store afterwards (only re-issued), so it
brakes too. `prune` was NOT touched: it already shipped with a stronger brake
than the standard one (`--apply` plus a literal `--confirm prune-contexts`),
and renaming working safety flags would break every caller for zero gain.
`cleanup-agent-runtime` likewise already defaults to dry-run with an opt-in
`--revoke` — same local equivalent, documented instead of renamed.

Second, the not-found envelope had to be designed around secret hygiene.
Everywhere else, suggestions echo entity ids and titles. Here, the natural
"candidates" for a credentials-store miss would be the stored `rctx_*` keys —
which must never enter an envelope that gets logged, relayed to models, or
pasted into issues. So `CREDENTIAL_NOT_FOUND` suggests context IDs and labels
instead, and when the user's own input is a key it is echoed masked (first 8
chars). The same rule keeps `context revoke`'s dry-run plan to IDs only.

`issue`, `credentials add` and `set-default` stay unbraked: issuing a child
context is revocable by definition, and the two local-store writes are
reversible one-liners. Braking them would put exit-3 friction inside the
canonical "issue → export → whoami" flow that the context-cli skill teaches.
