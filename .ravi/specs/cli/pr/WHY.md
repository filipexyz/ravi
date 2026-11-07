# Verified PR publication / WHY

The supported alternative to git push in a runtime session was manual Git
Data API work followed by a separate script. Incorrect raw-diff parsing could
upload the wrong tree; successful PR creation could still leave no CI follow.
One command owns the complete outcome and exposes partial states honestly.

Content-addressed objects make retries safe only when their hashes are checked.
GitHub's commit endpoint does not accept arbitrary raw commit bytes, so v1
refuses formats it cannot reproduce exactly. It never manufactures a replacement
commit or weakens independent review to make publication appear successful.

A row in the trigger table is not proof of a loaded subscription. The runner
health request confirms that the existing runner consumed this exact desired
follow configuration, without adding another watcher or scheduling system.

## Decision: remove bare operator publication

`--reply-session` selected a notification destination but proved no identity.
The local-operator permission path trusted the host; the protected journal
correctly refused that execution path. Routing to a socket cannot fix this:
gateway authentication still requires a live registered runtime credential.
Weakening the journal, accepting environment identity, or minting a bootstrap
admin key would turn a destination/host assertion into publication authority.

This is a breaking change, not an authentication feature: remove the flag,
deny local-operator command admission, and require a resolved session context
through the gateway/agent before publication IO. Existing authenticated
sessions keep their permission checks, preview/execute brake, durable follow
and journal. The state-boundary change motivating this finding is independent
and must not wait for an operator-login feature.

## What exists today

- `src/sdk/gateway/auth.ts` validates bearer runtime credentials through the
  registry; a reachable socket does not authenticate the caller.
- `src/cli/commands/context.ts` implements `issue` and `authorize` only after
  resolving an existing parent context. They do not authenticate a bare human.
- `src/runtime/context-registry.ts` issues scoped, expiring child contexts and
  records parent ID/kind, issuance mode and approval source. Ordinary child
  issuance does not itself establish a human actor; session binding and
  human identity must not be conflated.
- `ravi login` authenticates to the Console, not the runtime publication
  gateway. There is no implemented Console-login-to-publication-rctx exchange.
- `daemon init-admin-key` is host/bootstrap administration, not proof of
  the operator's personal identity. It is not a publication onboarding path.

For current use, request publication in an existing authorized Ravi session.
The runtime issues its turn context; the gateway resolves it and authorization
checks it again before effects. Existing context capabilities/provider policy
must authorize the command. Where policy requires approval, the existing
authority must satisfy it; `--execute` neither grants permission nor substitutes
for approval. The audit identifies the verified actor when available, otherwise
the authenticated executing agent, never an inferred local human. The public
context ID links publication events to the context/approval lineage.

## Future authenticated terminal flow (design only, not implemented)

Reintroducing terminal publication requires a separate identity exchange. No
new command or endpoint is promised by this fix. Its minimum design is:

1. The terminal starts a short-lived, single-use challenge with a verifier
   bound to that initiating process. The human authenticates on a trusted
   authority surface. The challenge code correlates the request; it does not
   authorize it. Socket possession, host files and environment aliases are
   never identity evidence.
2. That authority verifies the person's canonical identity and access to the
   target installation/session. It presents one approval containing the
   repository, branch/base, exact commit/tree, requested capability, executor,
   CI destination and expiry. The person approves this concrete publication;
   a denial, expiry, replay or changed publication tuple invalidates it.
3. The authenticated authority issues a runtime context only after verifying
   both approval and challenge binding. It binds the verified human actor,
   executor, authorized session, approval ID, parent/issuer, publication tuple
   and short TTL. Authority is restricted to that publication, with no admin
   or wildcard grant. This needs real scope enforcement in the runtime, not
   just metadata claiming a repository restriction.
4. The initiating process receives the credential over the authenticated
   exchange and calls the gateway. The gateway validates issuer/audience,
   liveness, scope and approval binding on every attempt. A credential is a
   carrier of server-issued authority, never a reason to trust its host or
   storage location. It must not be printed into logs, prompts or audit rows.
5. Publication previews the exact plan and executes only after explicit
   confirmation. Authentication, capability/approval and `--execute` remain
   separate requirements. The runtime revalidates authority before each effect;
   expiry/revocation stops further writes and returns any partial state.
6. Persist challenge/approval issuance and consumption, verified actor,
   installation, executor, session, parent/public context IDs, scope, TTL and
   revocation. Link these to the existing publication ID/attempt, intents,
   confirmations, uncertain outcomes, remote SHA/tree/PR and follow IDs.
   Keep credentials and content out of the audit. Missing durable audit remains
   a hard stop. Retrying reconciles actual remote state, never replays approval
   for a different SHA.

The exchange, human/session binding, approval consumption and scope enforcement
are absent today. That is why removing support is the honest current contract.

## CLI interaction analysis before implementation

Inspection used the rendered `pr publish --help` from the source CLI. The goal
is one verified PR with a durable CI recipient; authentication precedes the
preview, then explicit execution, then the final PR/SHA/CI result. Once execution
succeeds, setup/recovery guidance gives way to that result.

The existing headings, indentation and aligned option descriptions establish
hierarchy, similarity, proximity and common regions. The conflict was grouping
`--reply-session` with publication inputs while describing it as operator
onboarding: visual proximity incorrectly implied authority. Remove that option;
put authentication beside USE and its recovery beside ON ERROR. Continuity and
alignment stay stable from examples to lifecycle. Figure-ground is textual
(headings versus body), without dependence on color; closure is the verified
result, while a partial result explicitly remains incomplete. Symmetry has no
functional role in a linear terminal; common fate is represented by the single
publication lifecycle. Pragnanz improves by exposing one supported entry path.

Density stays compact: one requirement, one breaking-change note and one
actionable refusal. Existing typography/contrast belong to the terminal and
need no styling changes. Text wraps naturally; JSON stays structured and
screen-reader accessible. Missing authority has an immediate error rather than
a misleading loading/journal failure. Preview and success preserve their
different exit codes; detailed partial-state recovery is progressively shown
only when relevant. No visual UI or new login screen is introduced.
