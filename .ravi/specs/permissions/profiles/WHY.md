# Permission Profiles Rationale

## Why This Exists

Operators need a human-scale way to grant recurring authority without pasting
long capability lists. Profiles (a.k.a. permission groups) are reusable
authority bundles that a principal receives only through explicit provider
materialization, preserving provenance for every grant.

Profiles are also the primary approval UX: agents ask for a named profile/tag
instead of raw capabilities, and capability lists become bootstrap material for
new narrow profiles rather than the normal interface.

## Design Position

- A profile grants authority to no one by itself; a concrete relation must link
  a principal or surface to it.
- Profile expansion is consistent between direct `can()` checks and turn-scoped
  runtime materialization.
- Grants are temporary by default; revoked or expired grants stop authorizing.

## Full-Access Is Not A Shell Bypass

`full-access` is the break-glass profile that widens capability authorization to
`admin system:*`. It intentionally does **not** touch shell hard-safety
(`runtime/shell-safety`). No profile — including `full-access` — may allow a
dangerous shell pattern or an `UNCONDITIONAL_BLOCKS` executable, and a
hard-safety denial must never recommend `full-access` as remediation. Widening
authorization and lowering the safety floor are different decisions, and only
the former is a profile concern.
