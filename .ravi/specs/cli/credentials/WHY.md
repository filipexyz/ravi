# Credentials agent-first CLI contract / WHY

Credentials are the one CLI domain where a sloppy error message is itself an
incident: an envelope that echoes a `secretRef` teaches every agent transcript
where the secret lives, and a dry-run plan that includes the resolved secret
defeats the entire broker boundary. So this migration adds a domain-specific
invariant on top of the standard contract: plans carry only necessary
identifiers plus presence/boolean/count metadata, while envelopes and
suggestions never carry secret material. Suggestions are safe here precisely
because the suggestion corpus is identity, not value.

The brake landed on the two ops that change the security posture:

- `connections remove` deletes credential metadata and — with
  `--delete-secret` — the backend secret itself. There is no undo for a
  deleted keychain/vault entry.
- `broker exec` is the boundary that resolves a live backend secret for a
  provider action. Today its adapter only resolves in-process (the secret is
  intentionally not returned), but the surface is designed to execute real
  provider calls; braking it now means the contract is already correct when
  those adapters land. The pre-existing `--dry-run` flag could not simply
  become the default (scripts pass it explicitly and expect exit 0 with the
  planned payload), so it stays as the documented legacy equivalent while the
  brake uses the standard `--execute` polarity.

`add`, `enable`, and `disable` stay immediate: add/remove and enable/disable
are reverse pairs, and `add` already forces the secret through stdin or an
existing ref — never through argv.
