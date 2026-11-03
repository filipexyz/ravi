import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { z } from "zod";
import type { ApiKeyAction, ApiKeyInventory, ApiKeyMetadata, ApiKeyReceipt, ApiKeySubject } from "@/shared/api-keys";
import { ORGANIZATION_ACTIONS, PROJECT_ACTIONS, type AuthorizationResource } from "@/shared/project-authorization";
import { compilePolicy } from "../authorization/engine";
import { canonicalJson, policyDigest, policySchema } from "../authorization/policy";
import { organizationDecisionSnapshot } from "../authorization/postgres";
import { assertFleetActor, FleetError, type FleetActor } from "./contract";

const actionSchema = z.enum([...PROJECT_ACTIONS, ...ORGANIZATION_ACTIONS]);
const intent = { operationId: z.uuid(), reason: z.string().trim().min(3).max(300) };
const target = { id: z.uuid(), expectedRevision: z.number().int().positive() };
const subjectSchema = z.object({ kind: z.enum(["user", "service"]), id: z.uuid() }).strict();
const scope = { projectId: z.uuid().nullable(), scopes: z.array(actionSchema).min(1).max(32),
  expiresAt: z.iso.datetime({ offset: true }) };
const issueSchema = z.object({ ...intent, ...scope, name: z.string().trim().min(1).max(120), subject: subjectSchema }).strict();
const classifySchema = z.object({ ...intent, ...target, ...scope, subject: subjectSchema }).strict();
const rotateSchema = z.object({ ...intent, ...target, expiresAt: z.iso.datetime({ offset: true }) }).strict();
const revokeSchema = z.object({ ...intent, ...target }).strict();
const serviceSchema = z.object({ ...intent, name: z.string().trim().min(1).max(120) }).strict();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new FleetError("invalid_request", 400);
  return result.data;
}
function expiry(value: string) {
  const date = new Date(value), now = Date.now();
  if (!(date.getTime() > now) || date.getTime() > now + 366 * 86400_000) throw new FleetError("api_key_expiry_invalid", 400);
  return date.toISOString();
}
async function sourceSession(tx: TransactionSql, actor: FleetActor) {
  if (!actor.sessionId) throw new FleetError("auth_required", 401);
  const [session] = await tx`select expires_at from console_browser_sessions where id=${actor.sessionId}
    and organization_id=${actor.organizationId} and user_id=${actor.userId} and revoked_at is null for share`;
  if (!session || new Date(session.expires_at) <= new Date()) throw new FleetError("auth_required", 401);
}
async function locks(tx: TransactionSql, org: string) {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`fleet:${org}`},0))`;
  await tx`select pg_advisory_xact_lock(hashtextextended(${`project-policy:${org}`},0))`;
}
async function engineFor(tx: TransactionSql, org: string) {
  const [row] = await tx`select r.document,r.digest from authorization_policy_heads h
    join authorization_policy_revisions r on r.id=h.active_revision_id and r.organization_id=h.organization_id
    where h.organization_id=${org} for share of h,r`;
  const parsed = policySchema.safeParse(row?.document);
  if (!parsed.success || parsed.data.organizationId !== org || policyDigest(parsed.data) !== row?.digest)
    throw new FleetError("authorization_unavailable", 503);
  return compilePolicy(parsed.data);
}
async function subjectActive(tx: TransactionSql, org: string, subject: ApiKeySubject) {
  if (subject.kind === "user") {
    const [row] = await tx`select 1 from organization_memberships m join users u on u.id=m.user_id
      where m.organization_id=${org} and m.user_id=${subject.id} and m.status='active' and u.status='active'
      and exists(select 1 from auth_identities i where i.user_id=u.id and i.provider like 'oidc:%') for share of m,u`;
    if (!row) throw new FleetError("api_key_subject_inactive", 403);
  } else {
    const [row] = await tx`select 1 from api_key_service_principals where organization_id=${org}
      and id=${subject.id} and status='active' for share`;
    if (!row) throw new FleetError("api_key_subject_inactive", 403);
  }
}
async function scopeResource(tx: TransactionSql, org: string, projectId: string | null, scopes: readonly string[]): Promise<AuthorizationResource> {
  const catalog: readonly string[] = projectId ? PROJECT_ACTIONS : ORGANIZATION_ACTIONS;
  if (!scopes.length || new Set(scopes).size !== scopes.length || scopes.some(s => !catalog.includes(s)))
    throw new FleetError("api_key_scope_invalid", 400);
  const [organization] = await tx`select 1 from organizations where id=${org} and status='active' for share`;
  if (!organization) throw new FleetError("api_key_scope_invalid", 403);
  if (projectId) {
    const [project] = await tx`select 1 from projects where id=${projectId} and organization_id=${org} and status='active' for share`;
    if (!project) throw new FleetError("api_key_scope_invalid", 403);
  }
  return projectId ? { kind: "project", id: projectId } : { kind: "organization", id: org };
}
async function authorizeSubject(tx: TransactionSql, org: string, subject: ApiKeySubject, projectId: string | null, scopes: readonly ApiKeyAction[]) {
  const resource = await scopeResource(tx, org, projectId, scopes);
  await subjectActive(tx, org, subject);
  const engine = await engineFor(tx, org);
  for (const action of scopes) {
    const decision = subject.kind === "service" ? await engine.decideService({ organizationId: org, servicePrincipalId: subject.id, active: true }, resource, action)
      : resource.kind === "project" ? await engine.decide({ organizationId: org, userId: subject.id, active: true, organizationRole: "",
        projectId: resource.id, projectOrganizationId: org, projectRole: null }, action as (typeof PROJECT_ACTIONS)[number])
      : await engine.decideOrganization({ organizationId: org, userId: subject.id, active: true, organizationRole: "" }, action as (typeof ORGANIZATION_ACTIONS)[number]);
    if (!decision.allowed) throw new FleetError("api_key_subject_not_authorized", 403);
  }
}
async function metadata(tx: TransactionSql, org: string, id?: string): Promise<ApiKeyMetadata[]> {
  // Positive DTO selection; hash/token never leave this query boundary.
  const rows = await tx`select k.id,k.name,k.key_prefix as prefix,k.status,k.revision,
    k.subject_kind as "subjectKind",coalesce(k.subject_user_id,k.service_principal_id) as "subjectId",
    coalesce(u.display_name,u.primary_email,s.name) as "subjectName",coalesce(a.display_name,a.primary_email) as "authorName",
    k.project_id as "projectId",p.name as "projectName",k.scopes_json as scopes,
    k.expires_at as "expiresAt",k.revoked_at as "revokedAt",(k.hash_version<>'sha256') as "rotationRequired"
    from api_keys k left join users u on u.id=k.subject_user_id left join users a on a.id=k.created_by_user_id
    left join api_key_service_principals s on s.id=k.service_principal_id and s.organization_id=k.organization_id
    left join projects p on p.id=k.project_id and p.organization_id=k.organization_id
    where k.organization_id=${org} and (${id ?? null}::uuid is null or k.id=${id ?? null}::uuid)
    order by k.created_at desc,k.id limit 1001`;
  if (rows.length > 1000) throw new FleetError("api_key_inventory_too_large", 422);
  return rows.map(r => ({ ...r, expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null })) as ApiKeyMetadata[];
}

/** Browser administration only. Body fields select targets; authority comes from
 * current server-derived OIDC session and policy. Never invoked with a key actor. */
export class ApiKeysService {
  constructor(private sql: Sql, private org: string) {}

  private async authorized<T>(actor: FleetActor, write: boolean, effect: (tx: TransactionSql) => Promise<T>): Promise<T> {
    assertFleetActor(actor, this.org);
    const result = await this.sql.begin(async tx => {
      await locks(tx, this.org);
      await sourceSession(tx, actor);
      const decide = await organizationDecisionSnapshot(tx, { organizationId: this.org, userId: actor.userId });
      for (const action of write ? ["organization.api_keys.read", "organization.api_keys.manage"] as const : ["organization.api_keys.read"] as const)
        if (!(await decide(action, randomUUID())).allowed) return { allowed: false as const };
      const value = await effect(tx);
      await sourceSession(tx, actor);
      return { allowed: true as const, value };
    }) as { allowed: false } | { allowed: true; value: T };
    if (!result.allowed) throw new FleetError("forbidden", 403);
    return result.value;
  }

  async list(actor: FleetActor): Promise<ApiKeyInventory> {
    return this.authorized(actor, false, async tx => {
      const keys = await metadata(tx, this.org);
      const services = await tx<ApiKeyInventory["services"]>`select id,name,status,revision from api_key_service_principals where organization_id=${this.org} order by name,id limit 1001`;
      // The dedicated action includes minimal subject/scope selectors, not email,
      // memberships, roles, grants or project content.
      const users = await tx<ApiKeyInventory["users"]>`select u.id,coalesce(u.display_name,'Member') as name from users u join organization_memberships m on m.user_id=u.id
        where m.organization_id=${this.org} and m.status='active' and u.status='active' order by u.id limit 1001`;
      const projects = await tx<ApiKeyInventory["projects"]>`select id,name from projects where organization_id=${this.org} and status='active' order by name,id limit 1001`;
      if (Math.max(services.length, users.length, projects.length) > 1000) throw new FleetError("api_key_inventory_too_large", 422);
      return { keys, services, users, projects, unresolved: keys.filter(k => k.status === "active" &&
        (k.subjectKind === "unclassified" || k.rotationRequired || (k.projectId && !k.projectName))).length } as ApiKeyInventory;
    });
  }

  private async mutate(actor: FleetActor, operation: string, input: { operationId: string; reason: string },
    effect: (tx: TransactionSql) => Promise<Omit<ApiKeyReceipt, "operationId">>): Promise<ApiKeyReceipt> {
    return this.authorized(actor, true, async tx => {
      const digest = hash(canonicalJson({ operation, org: this.org, actor: actor.userId, input }));
      const [receipt] = await tx`select input_hash,result_json from fleet_mutation_receipts where organization_id=${this.org} and operation_id=${input.operationId}`;
      if (receipt) {
        if (receipt.input_hash !== digest) throw new FleetError("idempotency_conflict", 409);
        return receipt.result_json as ApiKeyReceipt;
      }
      const result = { operationId: input.operationId, ...await effect(tx) };
      const { token: _token, ...safe } = result;
      await tx`insert into audit_events(id,organization_id,actor_type,actor_id,target_type,target_id,action,request_id,after_json,metadata_json)
        values(${randomUUID()},${this.org},'user',${actor.userId},${result.key ? "api_key" : "api_key_service_principal"},
        ${result.key?.id ?? result.service!.id},${operation},${input.operationId},${JSON.stringify(safe)}::jsonb,
        ${JSON.stringify({ reason: input.reason, source: "fleet.api-keys" })}::jsonb)`;
      await tx`insert into fleet_mutation_receipts(organization_id,operation_id,input_hash,result_json)
        values(${this.org},${input.operationId},${digest},${JSON.stringify(safe)}::jsonb)`;
      // Late audit/receipt waits cannot extend admission or token lifetime.
      if (result.key?.expiresAt && result.key.status === "active" && new Date(result.key.expiresAt) <= new Date()) throw new FleetError("api_key_expired", 403);
      return result;
    });
  }

  async createService(actor: FleetActor, body: unknown) {
    const input = parse(serviceSchema, body);
    return this.mutate(actor, "api_key.service_created", input, async tx => {
      const [service] = await tx`insert into api_key_service_principals(organization_id,name,created_by_user_id)
        values(${this.org},${input.name},${actor.userId}) returning id,name,status,revision`;
      return { service: service as ApiKeyReceipt["service"] };
    });
  }

  async revokeService(actor: FleetActor, body: unknown) {
    const input = parse(revokeSchema, body);
    return this.mutate(actor, "api_key.service_revoked", input, async tx => {
      const [before] = await tx`select id,revision from api_key_service_principals where organization_id=${this.org} and id=${input.id} for update`;
      if (!before) throw new FleetError("not_found", 404);
      if (before.revision !== input.expectedRevision) throw new FleetError("version_conflict", 409);
      const [service] = await tx`update api_key_service_principals set status='revoked',revision=revision+1,updated_at=clock_timestamp()
        where organization_id=${this.org} and id=${input.id} returning id,name,status,revision`;
      await tx`update api_keys set status='revoked',revoked_at=clock_timestamp(),updated_at=clock_timestamp(),revision=revision+1
        where organization_id=${this.org} and service_principal_id=${input.id} and status<>'revoked'`;
      return { service: service as ApiKeyReceipt["service"] };
    });
  }

  async issue(actor: FleetActor, body: unknown) {
    const input = parse(issueSchema, body);
    return this.mutate(actor, "api_key.issued", input, async tx => {
      const expiresAt = expiry(input.expiresAt);
      await authorizeSubject(tx, this.org, input.subject, input.projectId, input.scopes);
      const token = "rvk_" + randomBytes(32).toString("base64url"), id = randomUUID();
      await tx`insert into api_keys(id,organization_id,project_id,name,key_prefix,key_hash,hash_version,subject_kind,subject_user_id,
        service_principal_id,scopes_json,created_by_user_id,expires_at)
        values(${id},${this.org},${input.projectId},${input.name},${token.slice(0,12)},${hash(token)},'sha256',${input.subject.kind},
        ${input.subject.kind === "user" ? input.subject.id : null},${input.subject.kind === "service" ? input.subject.id : null},
        ${JSON.stringify(input.scopes)}::jsonb,${actor.userId},${expiresAt})`;
      return { key: (await metadata(tx, this.org, id))[0]!, token };
    });
  }

  private async existing(tx: TransactionSql, input: { id: string; expectedRevision: number }) {
    const [key] = await tx`select * from api_keys where organization_id=${this.org} and id=${input.id} for update`;
    if (!key) throw new FleetError("not_found", 404);
    if (key.revision !== input.expectedRevision) throw new FleetError("version_conflict", 409);
    if (key.status !== "active" || key.revoked_at) throw new FleetError("api_key_revoked", 409);
    return key;
  }

  async classify(actor: FleetActor, body: unknown) {
    const input = parse(classifySchema, body);
    return this.mutate(actor, "api_key.classified", input, async tx => {
      const key = await this.existing(tx, input);
      if (key.subject_kind !== "unclassified") throw new FleetError("api_key_already_classified", 409);
      const expiresAt = expiry(input.expiresAt);
      await authorizeSubject(tx, this.org, input.subject, input.projectId, input.scopes);
      await tx`update api_keys set subject_kind=${input.subject.kind},subject_user_id=${input.subject.kind === "user" ? input.subject.id : null},
        service_principal_id=${input.subject.kind === "service" ? input.subject.id : null},project_id=${input.projectId},
        scopes_json=${JSON.stringify(input.scopes)}::jsonb,expires_at=${expiresAt},revision=revision+1,updated_at=clock_timestamp()
        where id=${input.id} and organization_id=${this.org}`;
      return { key: (await metadata(tx, this.org, input.id))[0]! };
    });
  }

  async rotate(actor: FleetActor, body: unknown) {
    const input = parse(rotateSchema, body);
    return this.mutate(actor, "api_key.rotated", input, async tx => {
      const key = await this.existing(tx, input);
      if (key.subject_kind === "unclassified") throw new FleetError("api_key_classification_required", 409);
      const expiresAt = expiry(input.expiresAt);
      await authorizeSubject(tx, this.org, { kind: key.subject_kind, id: key.subject_user_id ?? key.service_principal_id }, key.project_id, key.scopes_json);
      const token = "rvk_" + randomBytes(32).toString("base64url");
      await tx`update api_keys set key_hash=${hash(token)},key_prefix=${token.slice(0,12)},hash_version='sha256',expires_at=${expiresAt},
        revision=revision+1,updated_at=clock_timestamp() where id=${input.id} and organization_id=${this.org}`;
      return { key: (await metadata(tx, this.org, input.id))[0]!, token };
    });
  }

  async revoke(actor: FleetActor, body: unknown) {
    const input = parse(revokeSchema, body);
    return this.mutate(actor, "api_key.revoked", input, async tx => {
      await this.existing(tx, input);
      await tx`update api_keys set status='revoked',revoked_at=clock_timestamp(),revision=revision+1,updated_at=clock_timestamp()
        where id=${input.id} and organization_id=${this.org}`;
      return { key: (await metadata(tx, this.org, input.id))[0]! };
    });
  }
}

/** Server-only consumer seam. A route supplies its canonical resource/action;
 * neither comes from a claimed bearer identity. No existing CLI/MCP transport is
 * changed to accept keys. Callback must contain only bounded local DB work. */
export async function withApiKey<T>(sql: Sql, input: { token: string; organizationId: string; projectId: string | null; action: ApiKeyAction; requestId: string },
  effect: (tx: TransactionSql, subject: ApiKeySubject & { keyId: string }) => Promise<T>): Promise<T> {
  if (!/^rvk_[A-Za-z0-9_-]{43}$/.test(input.token)) throw new FleetError("api_key_invalid", 401);
  const result = await sql.begin(async tx => {
    await locks(tx, input.organizationId);
    const [key] = await tx`select * from api_keys where organization_id=${input.organizationId} and key_hash=${hash(input.token)} for share`;
    if (!key) throw new FleetError("api_key_invalid", 401);
    try {
      // A denied final checkpoint rolls back the effect and success audit, while
      // the outer transaction preserves a safe refusal record for this known key.
      const value = await tx.savepoint(async tx => {
        if (key.status !== "active" || key.revoked_at || key.hash_version !== "sha256" || key.subject_kind === "unclassified"
          || !key.expires_at || new Date(key.expires_at) <= new Date()) throw new FleetError("api_key_invalid", 401);
        if (key.project_id !== input.projectId || !Array.isArray(key.scopes_json) || !key.scopes_json.includes(input.action)) throw new FleetError("api_key_scope_denied", 403);
        const subject: ApiKeySubject & { keyId: string } = { kind: key.subject_kind, id: key.subject_user_id ?? key.service_principal_id, keyId: key.id };
        await authorizeSubject(tx, input.organizationId, subject, key.project_id, [input.action]);
        const value = await effect(tx, subject);
        if (!input.action.endsWith(".read")) await tx`insert into audit_events(organization_id,project_id,actor_type,actor_id,target_type,target_id,action,request_id,metadata_json)
          values(${input.organizationId},${input.projectId},'api_key',${key.id},'api_key',${key.id},'api_key.used',${input.requestId},
          ${JSON.stringify({ subjectKind: subject.kind, subjectId: subject.id, action: input.action })}::jsonb)`;
        if (new Date(key.expires_at) <= new Date()) throw new FleetError("api_key_invalid", 401);
        return value;
      });
      return { allowed: true as const, value };
    } catch (error) {
      if (!(error instanceof FleetError) || ![401, 403].includes(error.status)) throw error;
      await tx`insert into audit_events(organization_id,actor_type,actor_id,target_type,target_id,action,request_id,metadata_json)
        values(${input.organizationId},'api_key',${key.id},'api_key',${key.id},'api_key.denied',${input.requestId},
        ${JSON.stringify({ code: error.code, action: input.action })}::jsonb)`;
      return { allowed: false as const, error };
    }
  }) as { allowed: true; value: T } | { allowed: false; error: FleetError };
  if (!result.allowed) throw result.error;
  return result.value;
}
