# ADR 0001: Establish an agent-first CLI foundation before domain facades

**Date:** 2026-08-21  
**Status:** accepted

## Context

The domain audits found the same unresolved failures in multiple CLI surfaces:
large JSON output can be lost during immediate process exit, known validation
errors can become generic `COMMAND_FAILED` responses, unknown `--fields` values
can succeed with empty objects, pagination contracts diverge, and effect risk is
not consistently discoverable or enforced.

Implementing these concerns independently in every domain would duplicate
policy, create conflicting contracts, and make later domain pull requests depend
on accidental merge order. The program also requires one pull request per
domain, native repository tests, and no external test-bench artifacts.

## Decision

Create one prerequisite `cli/foundation` pull request before the 21 domain pull
requests. It owns only shared transport and contract primitives:

- reliable stdout and stderr completion before process termination;
- typed public errors and the common exit taxonomy;
- strict field-selection validation;
- the common pagination envelope and validation rules;
- discoverable effect, risk, and confirmation metadata with global consistency
  checks.

Each domain remains responsible for its public error codes, accepted fields,
stable query ordering, effect classification, and facade behavior. A domain
facade follows `plan -> apply -> verify -> recover` when the operation has
effects that require confirmation or recovery; the foundation does not invent a
single universal business facade.

The foundation pull request is a prerequisite, not a second pull request for
any domain. Every domain still receives exactly one domain pull request. Tests
are added to the repository's native suites; no `tests/bench` structure is part
of this program.

## Alternatives considered

- **Implement the shared behavior inside the first domain pull request.**
  Rejected because unrelated domains would inherit a hidden dependency from a
  domain-owned change, and review scope would mix shared policy with business
  behavior.
- **Repeat the helpers in each domain.** Rejected because contracts and fixes
  would drift, and parallel pull requests would conflict in shared CLI files.
- **Build one universal facade before any domain work.** Rejected because read,
  local reversible writes, external effects, destructive operations, and
  authority changes need different safeguards. Only the lifecycle vocabulary
  is shared.
- **Proceed without the foundation and reconcile later.** Rejected because the
  known output and error defects would invalidate evidence produced by domain
  CLIs.

## Consequences

- **Positive:** domain pull requests start from one explicit contract, reuse the
  same safety primitives, and can be reviewed with comparable evidence.
- **Positive:** large-output, error, pagination, and risk behavior is verified
  once at the common boundary and then specialized by each domain.
- **Cost:** the first domain pull request waits for the foundation to merge or
  become a stable dependency branch.
- **Cost:** domain branches must be rebased in controlled waves as prerequisite
  pull requests merge.
- **Cost:** the foundation needs a narrow review to prevent it from absorbing
  business rules that belong to domains.

## Notes

This decision is based on the 2026-08-21 audit of `origin/dev` at
`b6046936fce0b08add2253ca52974d4cde5f3e9f`. Deployment to the VPS remains a
separate, serial operation that requires explicit approval and evidence from the
exact package commit.
