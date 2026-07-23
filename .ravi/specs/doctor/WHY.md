# Why Ravi Doctor

The existing `ravi doctor` command is useful as a narrow smoke check, but it
does not yet cover the operational drift that has repeatedly caused runtime
debugging loops.

The 2026-06-08 investigation found these gaps:

- SDK return coverage could fail with `missingPublic=0` because weak schemas
  were still drifting.
- Apps had valid state beyond the local meta-app registry.
- Many specs were still draft while applying to production code.
- Permission state was large, broad, and mostly permanent, while newer manual
  grants had already moved toward temporary defaults.
- Cost usage had provider/model rows without pricing.
- Daemon status used legacy process labels that could create false positives.
- At least one route pointed to a missing agent.
- Channel health and inbound actor/contact resolution needed first-class
  checks.

Raw logs and individual commands expose pieces of this state, but they do not
answer the operator question: "is Ravi safe and healthy enough to proceed?"

Doctor is the answer to that question.

## Design Choices

Doctor uses a three-level severity model because the operator action differs:

- `error`: stop and fix first;
- `warn`: review drift, usually safe to continue;
- `info`: context and coverage only.

Doctor is read-only because it should be safe to run before any risky action,
inside agent sessions, in CI, and during incident investigation.

Doctor composes existing validators because each domain should continue owning
its detailed rules. Doctor should turn those domain checks into a consistent
summary, not fork their behavior.

Doctor reports stable finding ids because the next layer will be automation:
CI gates, watchdogs, trigger templates, and agents that can ask for or apply
specific repairs.

## Alternatives Rejected

Keeping only domain-specific commands was rejected because it forces agents to
know every possible drift surface before diagnosis.

Using only logs was rejected because logs are event history, not a current
health contract.

Auto-repair inside doctor was rejected because a health command must remain
safe and predictable. Repair commands can consume doctor findings later.
