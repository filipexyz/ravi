import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { organizationDecisionSnapshot } from "../authorization/postgres";
import type { OrganizationAction } from "../authorization/policy";
import { ORGANIZATION_ACTIONS } from "@/shared/project-authorization";
import type { OrganizationAccess } from "@/shared/organization-access";
import { assertFleetActor, FleetError, type FleetActor } from "./contract";

export async function currentBrowserSession(tx: TransactionSql, actor: FleetActor) {
  // Native HTTP adapter requires this server-derived id. Internal synthetic
  // fixtures may omit it; it is never taken from a JSON body.
  if (!actor.sessionId) return;
  const [row] = await tx`select 1 from console_browser_sessions where id=${actor.sessionId}
    and organization_id=${actor.organizationId} and user_id=${actor.userId}
    and revoked_at is null and expires_at>clock_timestamp() for share`;
  if (!row) throw new FleetError("auth_required", 401);
}

/** Browser-only adapter. The actor comes from the authenticated server context;
 * this function never interprets role labels or accepts client-supplied grants.
 * The single policy engine holds its head/membership locks through the effect.
 * A denied result commits only the decision audit, then becomes HTTP403 outside
 * the transaction. Exceptions from the effect roll back all its DB writes.
 */
export async function withFleetAuthorization<T>(sql: Sql, organizationId: string,
  actor: FleetActor, actions: readonly OrganizationAction[],
  effect: (tx: TransactionSql) => Promise<T>, requestId: string = randomUUID()): Promise<T> {
  assertFleetActor(actor, organizationId);
  if (!actions.length) throw new FleetError("forbidden", 403);
  const result = await sql.begin(async tx => {
    if (actions.some(action => !action.endsWith(".read")))
      await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${organizationId}`},0))`;
    await currentBrowserSession(tx, actor);
    const decide = await organizationDecisionSnapshot(tx, { organizationId, userId: actor.userId });
    for (const action of actions) {
      const decision = await decide(action, requestId);
      if (!decision.allowed) return { allowed: false as const };
    }
    const value = await effect(tx);
    await currentBrowserSession(tx, actor);
    return { allowed: true as const, value };
  }) as { allowed: false } | { allowed: true; value: T };
  if (!result.allowed) throw new FleetError("forbidden", 403);
  return result.value;
}

export async function readOrganizationAccess(sql: Sql, organizationId: string, actor: FleetActor): Promise<OrganizationAccess> {
  assertFleetActor(actor, organizationId);
  return await sql.begin(async tx => {
    await currentBrowserSession(tx, actor);
    const decide = await organizationDecisionSnapshot(tx, { organizationId, userId: actor.userId });
    const actions = {} as OrganizationAccess["actions"], requestId = randomUUID();
    let generation = 0, revisionId: string | null = null;
    for (const action of ORGANIZATION_ACTIONS) {
      const result = await decide(action, requestId, true);
      actions[action] = result.allowed; generation = result.generation; revisionId = result.revisionId;
    }
    return { actions, generation, revisionId };
  }) as OrganizationAccess;
}
