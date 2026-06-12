---
id: permissions/enterprise/why
title: "Why Enterprise Authorization"
kind: why
domain: permissions
capability: enterprise
---

# Why Enterprise Authorization

## Thesis

A powerful AI agent is a blast-radius machine. The authorization layer is the
only load-bearing wall that makes deploying it survivable. In enterprise it is
therefore not a feature of the product — it is the condition of the product's
existence.

## The existential argument

The more useful the agent (more tools, more reach), the more dangerous a mistake
or compromise. The model WILL be manipulated — prompt injection is a certainty,
not a risk — so it cannot be trusted to police itself. Host enforcement, before
the tool call, is the only real control. This is why the industry converged on
host-enforced-before-tool-call authorization for agents. Without that wall, a
powerful agent reachable by untrusted input is not deployable in a serious
environment.

## The commercial argument

Enterprises do not "buy"; they pass gates. Each Phase 0/1 item removes a
specific reason a deal dies:

- Security review / pentest: an implicit "no agent principal ⇒ full authority"
  bypass is found in an hour and is a deal-killer — not because it is exploited,
  but because it exists.
- Identity / IT: without SSO/SCIM, IT will not deploy it; they manage no local
  accounts.
- Compliance (SOC2/ISO): without complete audit and "who can do X", an auditor
  cannot certify it.

## The strategic argument

In the agent era the buying question is "can I trust this autonomous thing in my
org?" The authorization layer IS the answer. Ravi's turn-scoped, local,
host-enforced model is exactly the pattern the industry named, AND it is what a
cloud-only competitor cannot offer on-prem. For regulated industries that cannot
send data to the cloud, a self-hosted agent with built-in delegated
authorization is a differentiated, defensible position. Authorization is the
sales pitch, not its overhead.

## The risk argument

The downside of weak authorization on a powerful agent is unbounded: one
compromised turn can exfiltrate, delete, send, or spend at machine speed across
everything the agent can reach. The 2026-06-10 incident is the proof — even the
safety machinery, mishandled, caused an outage; a mishandled agent in a
customer's production is worse. The intersection model contains this: a
compromised actor can only do what THAT actor was authorized for, never the
agent's full power. That containment is the entire value proposition for a
nervous enterprise — and Phase 0 is about making the containment provable to the
people who sign the cheque.

## Why Phase 0 first

- Authenticated break-glass: the agent's god-mode path must be closed and
  recorded, or no one trusts the deployment. It is the first "no" in a review.
- Complete audit: in a regulated industry, an action you cannot prove did not
  happen legally happened. The log is the defense.

## Alternatives rejected

- **Multi-tenant SaaS first.** Rejected for now: it forces a tenancy and scale
  rearchitecture that fights Ravi's local-first strength, and on-prem is where
  the differentiated, regulated-industry demand is.
- **Replace the bespoke engine wholesale.** Rejected: the core is the asset and
  is industry-validated; the enterprise gap is the perimeter (identity, audit,
  governance), not the decision model. Analyzable policy (Cedar) is adopted as a
  later assurance layer, not a Phase 0 rewrite.
