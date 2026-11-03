import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import { FleetError, idSchema, parseFleet } from "./contract";
import { beginOidcLogin, completeOidcLogin } from "@/lib/auth/oidc-client";
import { hashBrowserSessionToken, newBrowserSessionToken, openOidcTransaction, sealOidcTransaction } from "@/lib/auth/oidc-transaction";
import { oidcProvider, type OidcConfig } from "@/lib/auth/oidc-config";
import { initializeAuthorizationInBootstrapTransaction } from "../authorization/bootstrap";

export const SETUP_COOKIE = "__Host-ravi_fleet_setup";
export const SETUP_CALLBACK = "/callback/setup";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const startSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), operationId: idSchema }).strict();
const issueSchema = z.object({ organizationId: idSchema, name: z.string().trim().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), email: z.string().email().transform(x => x.toLowerCase()) }).strict();
type Driver = { begin: typeof beginOidcLogin; complete: typeof completeOidcLogin };
async function noMembers(tx: TransactionSql, org: string) {
  // Serialize first-owner issuance/claim with ALL fleet operations; reject even
  // inactive memberships so an abandoned org cannot be taken over through setup.
  await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${org}`},0))`;
  if ((await tx`select id from organization_memberships where organization_id=${org} limit 1`).length) throw new FleetError("setup_unavailable", 409);
  const [organization] = await tx`select status from organizations where id=${org} for update`;
  if (organization && organization.status !== "active") throw new FleetError("setup_unavailable", 409);
}
/** Operator-only function; never exposed by an HTTP route. Caller must securely
 * deliver the returned token once; no token is persisted by this function. */
export async function issueBootstrap(sql: Sql, body: unknown) {
  const input = parseFleet(issueSchema, body), token = randomBytes(32).toString("base64url");
  await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended('fleet:bootstrap-installation',0))`;
    await noMembers(tx, input.organizationId);
    if ((await tx`select id from organizations where id<>${input.organizationId} limit 1`).length) throw new FleetError("single_org_required", 409);
    await tx`insert into organizations(id,name,slug) values(${input.organizationId},${input.name},${input.slug}) on conflict(id) do nothing`;
    await tx`insert into fleet_bootstrap_grants(organization_id,token_hash,expected_email,expires_at)
      values(${input.organizationId},${sha(token)},${input.email},clock_timestamp()+interval '30 minutes')
      on conflict(organization_id) do update set token_hash=excluded.token_hash,expected_email=excluded.expected_email,expires_at=excluded.expires_at,
        consumed_at=null,claimed_by=null,attempt_id=null,state_hash=null,transaction_ciphertext=null,authorization_url=null,attempt_expires_at=null,created_at=now()`;
    await tx`insert into audit_events(organization_id,actor_type,actor_id,target_type,target_id,action,metadata_json)
      values(${input.organizationId},'system','operator-bootstrap','organization',${input.organizationId},'fleet.setup.issued','{}'::jsonb)`;
  });
  return token;
}
export class BootstrapService {
  constructor(private sql: Sql, private config: OidcConfig,
    private driver: Driver = { begin: beginOidcLogin, complete: completeOidcLogin }) {}
  async begin(body: unknown) {
    const input = parseFleet(startSchema, body);
    return await this.sql.begin(async tx => {
      const org = this.config.organizationId;
      await noMembers(tx, org);
      const [grant] = await tx`select * from fleet_bootstrap_grants where organization_id=${org} for update`;
      if (!grant || grant.consumed_at || new Date(grant.expires_at).getTime() <= Date.now() ||
        !timingSafeEqual(Buffer.from(grant.token_hash), Buffer.from(sha(input.token)))) throw new FleetError("setup_unavailable", 403);
      if (grant.attempt_id === input.operationId && grant.attempt_expires_at && new Date(grant.attempt_expires_at).getTime() > Date.now()) {
        return { url: grant.authorization_url as string, cookie: grant.transaction_ciphertext as string };
      }
      const { transaction, url } = await this.driver.begin("/org/onboarding", this.config, SETUP_CALLBACK);
      const cookie = await sealOidcTransaction(transaction, { ...this.config, generation: `setup:${grant.token_hash}` });
      await tx`update fleet_bootstrap_grants set attempt_id=${input.operationId},state_hash=${sha(transaction.state)},
        transaction_ciphertext=${cookie},authorization_url=${url.toString()},attempt_expires_at=least(expires_at,clock_timestamp()+interval '5 minutes') where organization_id=${org}`;
      if (new Date(grant.expires_at).getTime() <= Date.now()) throw new FleetError("setup_unavailable", 403);
      return { url: url.toString(), cookie };
    }) as { url: string; cookie: string };
  }
  async complete(url: URL, cookie: string) {
    if (url.origin !== this.config.origin || url.pathname !== SETUP_CALLBACK || !url.searchParams.get("state")) throw new FleetError("setup_unavailable", 403);
    return await this.sql.begin(async tx => {
      const org = this.config.organizationId;
      await noMembers(tx, org);
      const [grant] = await tx`select * from fleet_bootstrap_grants where organization_id=${org} for update`;
      if (!grant || grant.consumed_at || new Date(grant.expires_at).getTime() <= Date.now() || !grant.attempt_expires_at ||
        new Date(grant.attempt_expires_at).getTime() <= Date.now() || grant.state_hash !== sha(url.searchParams.get("state")!) || grant.transaction_ciphertext !== cookie) {
        throw new FleetError("setup_unavailable", 403);
      }
      const transaction = await openOidcTransaction(cookie, { ...this.config, generation: `setup:${grant.token_hash}` });
      const identity = await this.driver.complete(url, transaction, this.config, SETUP_CALLBACK);
      if (identity.issuer !== this.config.issuer || !identity.subject || identity.emailVerified !== true || identity.email.toLowerCase() !== grant.expected_email) throw new FleetError("setup_unavailable", 403);
      if ((await tx`select id from users where lower(primary_email)=${grant.expected_email} limit 1`).length ||
        (await tx`select id from auth_identities where provider=${oidcProvider(identity.issuer)} and provider_user_id=${identity.subject} limit 1`).length) throw new FleetError("setup_identity_collision", 409);
      const userId = randomUUID(), identityId = randomUUID(), token = newBrowserSessionToken();
      const expiresAt = new Date(Date.now()+this.config.sessionTtlSeconds*1000);
      await tx`insert into users(id,primary_email,display_name) values(${userId},${grant.expected_email},${identity.name.slice(0,200)})`;
      await tx`insert into auth_identities(id,provider,provider_user_id,user_id,email) values(${identityId},${oidcProvider(identity.issuer)},${identity.subject},${userId},${grant.expected_email})`;
      await tx`insert into organization_memberships(organization_id,user_id,role,status) values(${org},${userId},'owner','active')`;
      await tx`insert into console_browser_sessions(token_hash,auth_identity_id,user_id,organization_id,expires_at,oidc_groups)
        values(${hashBrowserSessionToken(token)!},${identityId},${userId},${org},${expiresAt.toISOString()},${JSON.stringify(identity.groups ?? [])}::jsonb)`;
      await tx`update fleet_bootstrap_grants set consumed_at=now(),claimed_by=${userId},transaction_ciphertext=null,authorization_url=null where organization_id=${org}`;
      await initializeAuthorizationInBootstrapTransaction(tx, {
        organizationId: org, userId, identityId, attemptId: grant.attempt_id,
      });
      await tx`insert into audit_events(organization_id,actor_type,actor_id,target_type,target_id,action,metadata_json)
        values(${org},'user',${userId},'organization',${org},'fleet.setup.claimed','{}'::jsonb)`;
      // Provider exchange, policy/row/audit writes can wait past either source
      // deadline. Roll back owner, policy, session, grant consumption and audit.
      const admittedAt = Date.now();
      if (new Date(grant.expires_at).getTime() <= admittedAt || new Date(grant.attempt_expires_at).getTime() <= admittedAt)
        throw new FleetError("setup_unavailable", 403);
      return { token, expiresAt };
    }) as { token: string; expiresAt: Date };
  }
}
