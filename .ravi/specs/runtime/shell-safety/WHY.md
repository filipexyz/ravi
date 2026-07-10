---
id: runtime/shell-safety
title: "Why Shell Hard-Safety"
kind: why
domain: runtime
capability: shell-safety
owners:
  - ravi-dev
status: active
normative: true
---

# Why

## Safety Is Not Authorization

Ravi capability authorization answers "may this subject do this?". It is designed
to be widened: operators grant tools and executables, wildcards exist
(`execute executable:*`), and `admin system:*` / `full-access` intentionally
satisfy broad authorization checks.

Shell hard-safety answers a different question: "is this command shape ever
allowed to run through an agent?". Some shapes — arbitrary shell interpreters
(`bash`, `sh`, `zsh`, ...), string execution (`eval`, `exec`), sourcing
(`source`, `.`), and dangerous patterns such as command substitution, process
substitution, here-documents, and piping into an interpreter — defeat every
downstream control. Once an agent can spawn an interpreter or substitute a
command, the parsed-executable model and its allowlists no longer describe what
actually executes.

Because these shapes erase the meaning of authorization, they cannot be governed
by authorization. If a grant could satisfy them, the grant would be a universal
bypass. So hard-safety runs first and cannot be satisfied by any grant.

## The "Always Blocked" Promise Has No Hidden Exceptions

The shell policy promises that `UNCONDITIONAL_BLOCKS` are always blocked. A
promise with exceptions is not a promise. The confirmed bug was exactly a hidden
exception: a wildcard executable grant or `admin system:*` crossed an early
return before the unconditional check, so "always blocked" quietly became "blocked
unless you hold a broad grant".

We reject hidden exceptions on principle:

- No owner bypass. Ownership is an authorization concept; it cannot lower a safety
  floor.
- No privileged-shell bypass. "Trusted" agents running interpreters is precisely
  the scenario the floor exists for.
- No profile bypass. `full-access` widens authorization; it does not delete the
  safety layer.

If a specific command genuinely must be allowed, the correct move is a narrow,
audited, first-class allowance with its own spec and tests — not a silent hole
punched through the floor by a broad grant.

## One Classifier, Two Paths

The SDK Bash hook and the runtime host services enforce the same policy for the
same commands. Two copies of "what is dangerous" drift, and drift is how a floor
develops a crack. A single shared classifier with stable `blockType` values keeps
both paths honest and keeps audits comparable.

## Denials Are Policy, Not Missing Grants

A hard-safety denial is a statement that the command is not permitted to run,
not that the subject lacks a capability. Persisting it as a resolvable
`permission_denials` row, or recommending a grant/profile/full-access, would tell
operators to "fix" it by widening authorization — which must never satisfy
hard-safety. Hard-safety denials therefore audit through the policy audit path
only, with redacted provenance, and never enter capability-denial remediation.
