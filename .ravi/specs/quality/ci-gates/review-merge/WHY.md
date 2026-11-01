---
id: quality/ci-gates/review-merge
title: "Review Merge Gate Rationale"
kind: feature
domain: quality
capability: ci-gates
feature: review-merge
status: active
---

# Why this gate exists

PRs #767 and #756 were reported merged with unresolved security findings and
without independent approvals. Successful build checks do not establish that
review findings were addressed. This rationale distinguishes evidence from
actual enforcement and from the proposed remedy.

## 1. Historical snapshot — 2026-10-31

The initial design combined a read-only Actions evaluator with native approval
and conversation rules. On 31/10 the reviewer requirement was temporarily
removed, while the two review checks and conversation resolution were still
required in ruleset `26284495`. `SPEC.md` preserves the dated readback.

The initial rollout reported a single-collaborator setup. That was historical
context, not a current collaborator inventory or permission to add accounts.
The old ruleset JSON and evaluator remain evidence of that implementation;
they are not evidence of today's live rules.

## 2. Current configured policy — 2026-11-01

The independent reviewer rejected the previous version of this document
because it continued to describe the old ruleset as operational. Fresh API
readback confirms that the ruleset returns 404 and only `Quality Gate` is a
required status check in `dev`. Review Gate results are advisory.

The exposure is broader than the earlier zero-approval snapshot: a reproduced
credential finding does not itself prevent merge. A failing advisory review
check or unresolved review cannot be represented as a server-enforced veto.
The remaining quality/Copilot rules do not establish that every security
finding is addressed. This exposure is reported explicitly, not silently
accepted as permission to integrate unsafe work.

## 3. Recommended remedy — independent authority

The independent audit reported on 01/11 identified same-principal session
approval as a bypass. Changing the envelope cannot create authority separation.
Different agent ids or sessions are insufficient if the author can forge the
verdict, access the signer or replace its policy.

Require a reviewer attestation signed with a key outside the author's reach,
validated by a trusted verifier, and a mandatory check published by and bound
to a dedicated GitHub App. Both are necessary: a signed verdict with an
optional check is still bypassable, and a required check accepting an author's
own envelope enforces the wrong authority. Binding a check to the shared
Actions publisher does not bind it to an immutable trusted workflow.

Astra, fresh review context and durable task/thread provenance improve review
quality and auditability. They do not supply the cryptographic or permission
boundary. The key, signer, verifier policy and App credential must be outside
PR/author control; a generic signing oracle would recreate the same bypass.

Luís owns the activation decision. Direction/main supplies the readiness
packet and follows up. The work here only corrects the documentation; it does
not deploy a verifier, change rules or expand access. Closure requires the
live readback and independent checks defined in SPEC/CHECKS, not a declaration
that a process now exists.
