---
id: quality/ci-gates/error-causes
title: Error Cause Ratchet Rationale
kind: feature
domain: quality
capability: ci-gates
feature: error-causes
status: active
---

# Rationale

PR #798 exposed a class of masking failures. Repairing selected handlers did not account for the remaining catch sites. The scan enumerates debt mechanically and blocks new debt while allowing separate, reviewable repairs to reduce the baseline.

AST nodes distinguish handlers from examples in comments or strings. Stable IDs include file, lexical scope, handler kind and normalized AST; line shifts do not create debt. Identical handlers in the same scope retain an occurrence count, preventing a copied handler from hiding under an existing ID.

The initial Git commit is the ceiling, and the prior branch baseline prevents reintroduction after a repair. Checking both avoids an allowlist that can grow by editing its own JSON. Runtime corpus tests remain necessary: syntactic binding use does not prove that every dynamic transport preserves the cause or redacts secrets.

Before the gate's first publication in PR #798, its rules were expanded to detect logging a cause without forwarding it and manufacturing raw failure envelopes. Recomputing the same immutable source commit (`94682e274af4867dc240b81fc84b7ce76c97efa5`) with those rules changed the inaugural ceiling from 805 to 913 violations. The working tree then contained 894, closing 19 of the original sites without adding an allowance. The earlier 805/803 JSON files and inventory described the narrower scanner and were reconciled before publication; this is not permission to reset a published baseline.
