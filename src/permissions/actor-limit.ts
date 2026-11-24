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
