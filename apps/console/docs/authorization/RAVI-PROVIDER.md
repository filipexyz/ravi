# Ravi authorization provider: local contract, not runtime rollout

`POST /api/cli/authorization/decision` accepts version1, exact project UUID and
`project.read|write|admin`. The existing verified CLI bearer plus
`x-ravi-actor-contact` resolve the human through an active link. No actor, roles,
groups, installation, agent or arbitrary context in the body is accepted. A
personal login without a link is refused by this decision-query endpoint (normal
personal CLI routes remain separate). A machine-only credential is not a human.

The endpoint authenticates a native Console CLI session, current token JTI,
installation, active binding and organization membership, then intersects human
and installation policy. Response gives policy revision/digest, each decision
lane, reason, resource/action and the verified subject. It never returns secrets.
`cacheMaxAgeSeconds=0`, `reusableCapability=false`: this is an observation, not a
signed execution permit. Service operations must authorize again at their effect.
Errors/timeout/unavailable are deny, never offline allow.

The existing runtime has no per-agent attestation to this Console. Therefore the
endpoint explicitly says `agentAttestation=not_supported`. The engine's agent
lane has tests, but cannot be selected by supplying an agent name. Provisioning a
service principal and a signed scoped delegation is a later identity contract,
not a fallback to the installation owner or a synthetic user.

## Adapter integration required in Ravi (not done here)

1. Resolve the local operation into an exact canonical project resource and one
   catalog action. Unmapped operations remain denied by this provider; no wildcard
   command-to-project grant and no LLM interpretation.
2. Use the native installation credential and genuine author context. Resolve
   link through the existing native mechanism; never synthesize a contact/context.
3. Query the customer's Console, not commercial central. Require matching request,
   resource/action and supported response version. Do not cache allow decisions.
4. Intersect with local execution safety, host/filesystem bounds and tool scopes.
   An allow does not authorize SSH, arbitrary shell or an operation absent from
   the typed catalog. Reevaluate queued jobs before effects and streams before
   each emission; stop on revocation/unavailability. Already-started external
   effects cannot be recalled and must be audited as such.
5. Integrate agent attestation before claiming agent-specific grants or remote
   delegation of every Ravi authorization. This change does not install a provider,
   change daemon grants, issue real runtime contexts or start an agent turn.

Loss of commercial central is unrelated. Loss of the customer Console fails
closed for covered protected operations. Host break-glass/recovery remains an
explicit operator mechanism, not a hidden browser/admin override.
