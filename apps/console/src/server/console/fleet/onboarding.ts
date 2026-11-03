import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sql, TransactionSql } from "postgres";
import { FleetError, idSchema, parseFleet, type FleetActor } from "./contract";
import { withFleetAuthorization } from "./authorization";
import type { OrganizationAction } from "../authorization/policy";

export type OnboardingState = { completed: boolean; name: string; slug: string; login: "bootstrap" | "managed";
  storedCredentials: number; activeTransports: number; pendingTransports: number; snapshot: string };
const finishSchema = z.object({ operationId: idSchema, snapshot: z.string().regex(/^[a-f0-9]{64}$/), reviewed: z.literal(true) }).strict();
export class OnboardingService {
  constructor(private sql: Sql, private organizationId: string) {}
  private transaction<T>(actor: FleetActor, action: OrganizationAction, run: (tx: TransactionSql) => Promise<T>, requestId?: string): Promise<T> {
    return withFleetAuthorization(this.sql, this.organizationId, actor, [action], run, requestId);
  }
  private async snapshot(tx: TransactionSql): Promise<OnboardingState> {
    const org = this.organizationId;
    const [organization] = await tx`select name,slug from organizations where id=${org}`;
    const credentials = await tx`select id,revision,status from fleet_credentials where organization_id=${org} order by id`;
    const installations = await tx`select id,revision,status from fleet_installations where organization_id=${org} order by id`;
    const sso = await tx`select id,revision,status from fleet_sso_connections where organization_id=${org} order by id`;
    const completed = (await tx`select organization_id from fleet_onboarding where organization_id=${org}`).length > 0;
    const snapshot = createHash("sha256").update(JSON.stringify({ organization, credentials, installations, sso })).digest("hex");
    return { completed, name: organization!.name, slug: organization!.slug, login: sso.some(x => x.status === "active") ? "managed" : "bootstrap",
      storedCredentials: credentials.filter(x => x.status === "active").length, activeTransports: installations.filter(x => x.status === "active").length,
      pendingTransports: installations.filter(x => x.status !== "active").length, snapshot };
  }
  async state(actor: FleetActor) { return this.transaction(actor, "organization.onboarding.read", tx => this.snapshot(tx)); }
  async finish(actor: FleetActor, body: unknown) {
    const input = parseFleet(finishSchema, body);
    return this.transaction(actor, "organization.onboarding.manage", async tx => {
      const state = await this.snapshot(tx);
      if (state.snapshot !== input.snapshot) throw new FleetError("version_conflict",409);
      if (!state.name.trim() || !state.slug) throw new FleetError("organization_required",409);
      if (!state.completed) {
        await tx`insert into fleet_onboarding(organization_id,completed_at,completed_by,snapshot_hash) values(${actor.organizationId},now(),${actor.userId},${input.snapshot})`;
        await tx`insert into audit_events(organization_id,actor_type,actor_id,target_type,target_id,action,request_id,metadata_json)
          values(${actor.organizationId},'user',${actor.userId},'organization',${actor.organizationId},'fleet.onboarding.reviewed',${input.operationId},
            ${JSON.stringify({ activeTransports: state.activeTransports, pendingTransports: state.pendingTransports, storedCredentials: state.storedCredentials })}::jsonb)`;
      }
      return { ...state, completed: true };
    }, input.operationId);
  }
}
