/**
 * Whether a turn is a person held below the agent's break-glass. Read from
 * the capabilities (`deny_admin:system:*` / `deny_execute:executable:*`), not
 * only from the `actorBreakGlassWithheld` metadata, so derived contexts that
 * inherit the capabilities (context issue --inherit, app-runtime) keep the
 * limit even when the metadata is not copied. Pure: no storage imports.
 */
export interface ActorLimitContextLike {
  metadata?: Record<string, unknown> | null;
  capabilities?: ReadonlyArray<{ permission: string; objectType: string; objectId: string }> | null;
}

export function isActorBreakGlassLimitedContext(context: ActorLimitContextLike | null | undefined): boolean {
  if (!context) return false;
  const withheld = context.metadata?.actorBreakGlassWithheld;
  if (Array.isArray(withheld) && withheld.length > 0) return true;
  return (context.capabilities ?? []).some(
    (capability) =>
      (capability.permission === "deny_admin" && capability.objectType === "system" && capability.objectId === "*") ||
      (capability.permission === "deny_execute" &&
        capability.objectType === "executable" &&
        capability.objectId === "*"),
  );
}

/**
 * Whether a relayed turn (a session relay, a Slack thread bootstrap, a report)
 * is held below the agent. `relayNarrowing` only says the turn carries its
 * caller's capabilities as a ceiling (the lineage a revocation follows); it is
 * set for every verified human work handoff, the operator's included, and the
 * operator's relay holds the agent's whole authority. The relay is held when
 * its caller was: narrowed to a contact's chat grants, held below the agent's
 * break-glass, revoked, or itself a held relay. A relay of a turn that was none
 * of those is stamped `relayCallerUnrestricted` when it is built; a relay
 * without the stamp (an older context, a chain through a held one) stays held.
 */
export function isRelayHeldBelowAgent(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.relayNarrowing === true && metadata.relayCallerUnrestricted !== true;
}
