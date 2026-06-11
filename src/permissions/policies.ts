import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { getDb } from "../router/router-db.js";
import { dbFindTagBindings, normalizeTagSlug, normalizeTagSource, requireTagAssetType } from "../tags/tag-db.js";
import { type TagAssetType, type TagBinding } from "../tags/types.js";
import { getRaviStateDir } from "../utils/paths.js";
import { revokeRuntimeContextsForPolicyMaterializations } from "./policy-materialization-revocation.js";
import {
  grantRelationIfAbsentOrOwned,
  listRelations,
  revokeRelationIfSource,
  type GrantRelationOptions,
  type Relation,
} from "./relations.js";
import { DELEGATION_OVERRIDE_RELATION_PREFIX, DENY_RELATION_PREFIX } from "./delegation.js";

const POLICY_FILE_PATTERN = /\.(json)$/i;
const DEFAULT_TEMPORARY_TTL_MS = 60 * 60 * 1000;
const BREAK_GLASS_MAX_TTL_MS = 60 * 60 * 1000;
const POLICY_SOURCE_PREFIX = "policy:";

const VALID_ENTITY_TYPES = new Set([
  "agent",
  "system",
  "group",
  "session",
  "contact",
  "cron",
  "trigger",
  "team",
  "tool",
  "executable",
  "toolgroup",
  "chat",
  "role",
  "app",
  "automation",
  "platform_identity",
  "mailbox",
  "mail-provider",
  "calendar",
  "calendar-provider",
  "network",
]);

const VALID_RELATIONS = new Set([
  "admin",
  "use",
  "execute",
  "access",
  "modify",
  "write_contacts",
  "read_own_contacts",
  "read_tagged_contacts",
  "read_contact",
  "view",
  "member",
  "constrain",
  "read",
  "write",
  "send",
  "sync",
  "free-busy",
]);

const ROLE_OBJECT_TYPE = "role";
const SUBJECT_FROM_ASSET_TYPES = new Set(["agent", "automation", "chat", "contact", "session"]);
const TRUSTED_DEFAULT_BINDING_SOURCES = ["manual", "ravi"];
const FORBIDDEN_BROAD_OUTPUTS = [
  { relation: "admin", objectType: "system", objectId: "*" },
  { relation: "use", objectType: "tool", objectId: "*" },
  { relation: "use", objectType: "app", objectId: "*" },
  { relation: "execute", objectType: "app", objectId: "*" },
  { relation: "execute", objectType: "executable", objectId: "*" },
  { relation: "execute", objectType: "group", objectId: "*" },
  { relation: "access", objectType: "group", objectId: "*" },
  { relation: "admin", objectType: "group", objectId: "*" },
  { relation: "write_contacts", objectType: "system", objectId: "*" },
  { relation: "read_tagged_contacts", objectType: "system", objectId: "*" },
  { relation: "modify", objectType: "session", objectId: "*" },
];

const PolicyEntitySchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
});

const PolicySubjectSchema = z.union([z.object({ fromAsset: z.literal(true) }), PolicyEntitySchema]);

const PolicyEmitSchema = z.object({
  subject: PolicySubjectSchema,
  relation: z.string().min(1),
  object: PolicyEntitySchema,
});

export const PermissionPolicyRuleSchema = z
  .object({
    id: z.string().min(1),
    version: z.string().min(1).optional(),
    kind: z
      .enum(["assignment", "profile-definition", "delegation", "surface-constraint", "app-visibility"])
      .default("assignment"),
    enabled: z.boolean().default(true),
    description: z.string().optional(),
    selector: z.object({
      assetType: z.string().min(1),
      tag: z.string().min(1),
      match: z.enum(["exact", "prefix"]).default("exact"),
      acceptedBindingSources: z.array(z.string().min(1)).optional(),
    }),
    emits: z.array(PolicyEmitSchema).min(1),
    grant: z
      .object({
        mode: z.enum(["temporary", "permanent"]).default("temporary"),
        ttl: z.string().optional(),
        renew: z.boolean().default(true),
        reason: z.string().optional(),
      })
      .default({ mode: "temporary", renew: true }),
    breakGlass: z.boolean().default(false),
    approval: z
      .object({
        approvedBy: z.string().min(1),
        approvedAt: z.string().min(1).optional(),
        reason: z.string().min(1).optional(),
        ticket: z.string().min(1).optional(),
      })
      .optional(),
    allowNonPolicyTag: z.boolean().default(false),
  })
  .passthrough();

export type PermissionPolicyRule = z.infer<typeof PermissionPolicyRuleSchema>;

export interface LoadedPermissionPolicyRule {
  rule: PermissionPolicyRule;
  source: string;
}

export interface LoadPermissionPolicyRulesResult {
  rules: LoadedPermissionPolicyRule[];
  errors: Array<{ source: string; error: string }>;
}

export interface PermissionPolicyValidationResult {
  rules: LoadedPermissionPolicyRule[];
  errors: Array<{ source: string; error: string }>;
  warnings: Array<{ policyId: string; message: string }>;
  valid: boolean;
}

export type PermissionPolicyActionStatus =
  | "would_create"
  | "would_refresh"
  | "created"
  | "refreshed"
  | "conflict"
  | "skipped"
  | "invalid";

export interface PermissionPolicyAction {
  policyId: string;
  policyVersion: string;
  source: string;
  selector: {
    assetType: TagAssetType;
    assetId: string;
    tag: string;
    bindingId: string;
    bindingSource: string;
  };
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
  desiredHash: string;
  materializationId: string;
  grantMode: "temporary" | "permanent";
  expiresAt: number | null;
  status: PermissionPolicyActionStatus;
  conflictSource?: string;
  reason?: string;
  relationId?: number | null;
  error?: string;
}

export interface PermissionPolicyRunResult {
  mode: "dry-run" | "apply" | "reconcile";
  valid: boolean;
  rules: Array<{ id: string; version: string; enabled: boolean; source: string }>;
  errors: Array<{ source: string; error: string }>;
  warnings: Array<{ policyId: string; message: string }>;
  actions: PermissionPolicyAction[];
  revoked: PermissionPolicyMaterialization[];
  summary: {
    rules: number;
    actions: number;
    created: number;
    refreshed: number;
    conflicts: number;
    skipped: number;
    invalid: number;
    revoked: number;
  };
}

export interface PermissionPolicyMaterialization {
  id: string;
  policyId: string;
  policyVersion: string;
  selectorAssetType: string;
  selectorAssetId: string;
  tagSlug: string;
  tagBindingId: string | null;
  tagBindingSource: string | null;
  subjectType: string;
  subjectId: string;
  relation: string;
  objectType: string;
  objectId: string;
  desiredHash: string;
  relationId: number | null;
  status: string;
  conflictSource: string | null;
  reason: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

interface PermissionPolicyMaterializationRow {
  id: string;
  policy_id: string;
  policy_version: string;
  selector_asset_type: string;
  selector_asset_id: string;
  tag_slug: string;
  tag_binding_id: string | null;
  tag_binding_source: string | null;
  subject_type: string;
  subject_id: string;
  relation: string;
  object_type: string;
  object_id: string;
  desired_hash: string;
  relation_id: number | null;
  status: string;
  conflict_source: string | null;
  reason: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

export interface PermissionPolicyRunOptions {
  directory?: string;
  policyId?: string;
}

export interface PermissionPolicyExplainResult {
  assetType: TagAssetType;
  assetId: string;
  tags: Array<{ tag: string; bindingId: string; source: string }>;
  valid: boolean;
  errors: Array<{ source: string; error: string }>;
  warnings: Array<{ policyId: string; message: string }>;
  actions: PermissionPolicyAction[];
  materializations: PermissionPolicyMaterialization[];
}

function rowToMaterialization(row: PermissionPolicyMaterializationRow): PermissionPolicyMaterialization {
  return {
    id: row.id,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    selectorAssetType: row.selector_asset_type,
    selectorAssetId: row.selector_asset_id,
    tagSlug: row.tag_slug,
    tagBindingId: row.tag_binding_id,
    tagBindingSource: row.tag_binding_source,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    relation: row.relation,
    objectType: row.object_type,
    objectId: row.object_id,
    desiredHash: row.desired_hash,
    relationId: row.relation_id,
    status: row.status,
    conflictSource: row.conflict_source,
    reason: row.reason,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

function resolvePolicyDir(directory?: string): string {
  if (directory) return resolve(directory);
  return join(getRaviStateDir(), "permission-policies");
}

export function listPermissionPolicyFiles(directory?: string): string[] {
  const dir = resolvePolicyDir(directory);
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((entry) => POLICY_FILE_PATTERN.test(entry))
    .map((entry) => join(dir, entry))
    .sort();
}

export function loadPermissionPolicyRulesFromDirectory(directory?: string): LoadPermissionPolicyRulesResult {
  const files = listPermissionPolicyFiles(directory);
  const rules: LoadedPermissionPolicyRule[] = [];
  const errors: Array<{ source: string; error: string }> = [];
  const seenIds = new Set<string>();

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      errors.push({ source: file, error: `Invalid JSON: ${(error as Error).message}` });
      continue;
    }

    const validation = PermissionPolicyRuleSchema.safeParse(parsed);
    if (!validation.success) {
      errors.push({ source: file, error: validation.error.issues.map((issue) => issue.message).join("; ") });
      continue;
    }

    const rule = validation.data;
    rule.version = rule.version ?? computePolicyVersion(rule);
    if (seenIds.has(rule.id)) {
      errors.push({ source: file, error: `Duplicate policy id: ${rule.id}` });
      continue;
    }
    seenIds.add(rule.id);
    rules.push({ rule, source: file });
  }

  rules.sort((a, b) => a.rule.id.localeCompare(b.rule.id));
  return { rules, errors };
}

export function validatePermissionPolicies(options: PermissionPolicyRunOptions = {}): PermissionPolicyValidationResult {
  const loaded = loadPermissionPolicyRulesFromDirectory(options.directory);
  const filtered = filterLoadedRules(loaded.rules, options.policyId);
  const errors = [...loaded.errors];
  if (options.policyId && loaded.rules.length > 0 && filtered.length === 0) {
    errors.push({ source: "<policy-filter>", error: `Policy not found: ${options.policyId}` });
  }

  const validation = validateLoadedRules(filtered);
  errors.push(...validation.errors);
  return {
    rules: filtered,
    errors,
    warnings: validation.warnings,
    valid: errors.length === 0,
  };
}

export function dryRunPermissionPolicies(options: PermissionPolicyRunOptions = {}): PermissionPolicyRunResult {
  return runPermissionPolicies("dry-run", options);
}

export function applyPermissionPolicies(options: PermissionPolicyRunOptions = {}): PermissionPolicyRunResult {
  return runPermissionPolicies("apply", options);
}

export function reconcilePermissionPolicies(options: PermissionPolicyRunOptions = {}): PermissionPolicyRunResult {
  return runPermissionPolicies("reconcile", options);
}

export function explainPermissionPoliciesForAsset(input: {
  assetType: string;
  assetId: string;
  directory?: string;
}): PermissionPolicyExplainResult {
  const assetType = requireTagAssetType(input.assetType);
  const assetId = input.assetId.trim();
  const validation = validatePermissionPolicies({ directory: input.directory });
  const actions = validation.valid
    ? buildPolicyActions(validation.rules).filter(
        (action) => action.selector.assetType === assetType && action.selector.assetId === assetId,
      )
    : [];

  return {
    assetType,
    assetId,
    tags: dbFindTagBindings({ assetType, assetId }).map((binding) => ({
      tag: binding.tagSlug,
      bindingId: binding.id,
      source: binding.source,
    })),
    valid: validation.valid,
    errors: validation.errors,
    warnings: validation.warnings,
    actions,
    materializations: listPermissionPolicyMaterializations().filter(
      (item) => item.selectorAssetType === assetType && item.selectorAssetId === assetId,
    ),
  };
}

export function revalidatePolicyMaterializationsBeforeAuthorization(): PermissionPolicyMaterialization[] {
  return revokePolicyMaterializationsWithForbiddenRoleClosures();
}

export function listPermissionPolicyMaterializations(policyId?: string): PermissionPolicyMaterialization[] {
  const db = getDb();
  const rows = policyId
    ? (db
        .prepare("SELECT * FROM permission_policy_materializations WHERE policy_id = ? ORDER BY updated_at DESC, id")
        .all(policyId) as PermissionPolicyMaterializationRow[])
    : (db
        .prepare("SELECT * FROM permission_policy_materializations ORDER BY updated_at DESC, id")
        .all() as PermissionPolicyMaterializationRow[]);
  return rows.map(rowToMaterialization);
}

function runPermissionPolicies(
  mode: PermissionPolicyRunResult["mode"],
  options: PermissionPolicyRunOptions,
): PermissionPolicyRunResult {
  const validation = validatePermissionPolicies(options);
  const desiredPolicyIds = new Set(validation.rules.map((loaded) => loaded.rule.id));
  const actions = validation.valid ? buildPolicyActions(validation.rules) : [];
  const desiredHashes = new Map<string, Set<string>>();
  for (const action of actions) {
    const set = desiredHashes.get(action.policyId) ?? new Set<string>();
    set.add(action.desiredHash);
    desiredHashes.set(action.policyId, set);
  }

  const appliedActions: PermissionPolicyAction[] = [];
  const revoked: PermissionPolicyMaterialization[] = [];

  if (mode === "dry-run" || !validation.valid) {
    for (const action of actions) {
      const relation = findExistingRelation(action);
      appliedActions.push({
        ...action,
        status:
          relation && relation.source !== policySource(action.policyId)
            ? "conflict"
            : relation
              ? "would_refresh"
              : "would_create",
        conflictSource: relation && relation.source !== policySource(action.policyId) ? relation.source : undefined,
        relationId: relation?.id ?? null,
      });
    }
    if (validation.valid) {
      revoked.push(...findStaleMaterializations(desiredPolicyIds, desiredHashes));
      revoked.push(...findMaterializationsWithForbiddenRoleClosures());
    }
  } else {
    upsertPolicyRules(validation.rules);

    for (const action of actions) {
      const grantResult = grantRelationIfAbsentOrOwned(
        action.subjectType,
        action.subjectId,
        action.relation,
        action.objectType,
        action.objectId,
        policySource(action.policyId),
        grantOptionsForAction(action),
      );
      const nextAction: PermissionPolicyAction = {
        ...action,
        status: grantResult.status === "conflict" ? "conflict" : grantResult.status,
        conflictSource: grantResult.conflictSource,
        relationId: grantResult.relation?.id ?? null,
        expiresAt: grantResult.relation?.expiresAt ?? action.expiresAt,
      };
      upsertMaterialization(nextAction);
      appliedActions.push(nextAction);
    }

    if (mode === "reconcile") {
      revoked.push(...revokeStaleMaterializations(desiredPolicyIds, desiredHashes));
    }
    revoked.push(...revokePolicyMaterializationsWithForbiddenRoleClosures());
  }

  return buildRunResult(mode, validation, appliedActions, revoked);
}

function filterLoadedRules(rules: LoadedPermissionPolicyRule[], policyId?: string): LoadedPermissionPolicyRule[] {
  if (!policyId) return rules;
  return rules.filter((loaded) => loaded.rule.id === policyId);
}

function validateLoadedRules(rules: LoadedPermissionPolicyRule[]): {
  errors: Array<{ source: string; error: string }>;
  warnings: Array<{ policyId: string; message: string }>;
} {
  const errors: Array<{ source: string; error: string }> = [];
  const warnings: Array<{ policyId: string; message: string }> = [];
  const emittedRoleRelations = new Map<string, Array<{ relation: string; objectType: string; objectId: string }>>();

  for (const loaded of rules) {
    const { rule } = loaded;
    try {
      requireTagAssetType(rule.selector.assetType);
      const tagSlug = normalizeTagSlug(rule.selector.tag);
      if (!tagSlug.startsWith("policy.") && !rule.allowNonPolicyTag) {
        errors.push({
          source: loaded.source,
          error: `${rule.id}: selector tag ${tagSlug} is not a policy tag; set allowNonPolicyTag explicitly`,
        });
      }
      if (tagSlug.startsWith("policy.breakglass.") && !rule.breakGlass) {
        errors.push({
          source: loaded.source,
          error: `${rule.id}: breakglass policy tag requires breakGlass=true`,
        });
      }
    } catch (error) {
      errors.push({ source: loaded.source, error: `${rule.id}: ${(error as Error).message}` });
    }

    for (const emit of rule.emits) {
      const resolvedSubject = emit.subject;
      const possibleSubjectTypes = resolvePossibleSubjectTypes(rule, emit);
      if ("type" in resolvedSubject && !VALID_ENTITY_TYPES.has(resolvedSubject.type)) {
        errors.push({ source: loaded.source, error: `${rule.id}: unknown subject type: ${resolvedSubject.type}` });
      }
      if (!VALID_ENTITY_TYPES.has(emit.object.type)) {
        errors.push({ source: loaded.source, error: `${rule.id}: unknown object type: ${emit.object.type}` });
      }
      if (!isValidPolicyRelation(emit.relation)) {
        errors.push({ source: loaded.source, error: `${rule.id}: unknown relation: ${emit.relation}` });
      }
      if (possibleSubjectTypes.length === 0) {
        errors.push({
          source: loaded.source,
          error: `${rule.id}: selector asset type ${rule.selector.assetType} cannot be used as a policy subject`,
        });
      }
      for (const subjectType of possibleSubjectTypes) {
        if (!isAllowedPolicyOutput(rule, subjectType, emit.relation, emit.object.type, emit.object.id)) {
          errors.push({
            source: loaded.source,
            error: `${rule.id}: emitted tuple is outside the MVP policy output matrix: ${subjectType}:<id> ${emit.relation} ${emit.object.type}:${emit.object.id}`,
          });
        }
      }
      if (isForbiddenOutput(emit.relation, emit.object.type, emit.object.id)) {
        if (!rule.breakGlass) {
          errors.push({
            source: loaded.source,
            error: `${rule.id}: forbidden broad output without breakGlass: ${emit.relation} ${emit.object.type}:${emit.object.id}`,
          });
        } else {
          errors.push(...validateBreakGlassForbiddenOutput(loaded.source, rule));
        }
      }
      if ("type" in resolvedSubject && resolvedSubject.type === "role") {
        const list = emittedRoleRelations.get(resolvedSubject.id) ?? [];
        list.push({ relation: emit.relation, objectType: emit.object.type, objectId: emit.object.id });
        emittedRoleRelations.set(resolvedSubject.id, list);
      }
    }

    if ((rule.selector.acceptedBindingSources ?? TRUSTED_DEFAULT_BINDING_SOURCES).length === 0) {
      warnings.push({ policyId: rule.id, message: "Policy has no accepted binding sources and will match nothing." });
    }
    if (rule.grant.mode === "temporary") {
      try {
        parseDurationMs(rule.grant.ttl ?? "1h");
      } catch (error) {
        errors.push({ source: loaded.source, error: `${rule.id}: ${(error as Error).message}` });
      }
    }
  }

  for (const loaded of rules) {
    for (const emit of loaded.rule.emits) {
      if (emit.object.type !== "role") continue;
      if (emit.relation !== "member" && emit.relation !== "constrain") continue;
      const forbidden = findForbiddenRoleClosureOutputs(emit.object.id, emittedRoleRelations);
      for (const rel of forbidden) {
        errors.push({
          source: loaded.source,
          error: `${loaded.rule.id}: role ${emit.object.id} closure contains forbidden output: ${rel.relation} ${rel.objectType}:${rel.objectId}`,
        });
      }
    }
  }

  return { errors, warnings };
}

function buildPolicyActions(rules: LoadedPermissionPolicyRule[]): PermissionPolicyAction[] {
  const actions: PermissionPolicyAction[] = [];

  for (const loaded of rules) {
    const { rule } = loaded;
    if (!rule.enabled) continue;
    const selectorAssetType = requireTagAssetType(rule.selector.assetType);
    const tagSlug = normalizeTagSlug(rule.selector.tag);
    const acceptedSources = new Set(
      (rule.selector.acceptedBindingSources ?? TRUSTED_DEFAULT_BINDING_SOURCES).map((source) =>
        normalizeTagSource(source),
      ),
    );
    const bindings = findMatchingBindings(selectorAssetType, tagSlug, rule.selector.match);

    for (const binding of bindings) {
      if (!acceptedSources.has(binding.source)) continue;
      for (const emit of rule.emits) {
        const subject = resolvePolicySubject(emit.subject, binding);
        if (!subject) {
          actions.push(invalidAction(loaded, binding, emit, "selector asset type cannot be used as a subject"));
          continue;
        }
        const baseAction = makeAction(loaded, binding, subject, emit);
        actions.push(baseAction);
      }
    }
  }

  return actions;
}

function findMatchingBindings(assetType: TagAssetType, tagSlug: string, match: "exact" | "prefix"): TagBinding[] {
  if (match === "exact") return dbFindTagBindings({ slug: tagSlug, assetType });
  return dbFindTagBindings({ assetType }).filter((binding) => binding.tagSlug.startsWith(tagSlug));
}

function resolvePolicySubject(
  subject: z.infer<typeof PolicySubjectSchema>,
  binding: TagBinding,
): { subjectType: string; subjectId: string } | null {
  if ("type" in subject) {
    return { subjectType: subject.type, subjectId: subject.id };
  }
  if (!SUBJECT_FROM_ASSET_TYPES.has(binding.assetType)) return null;
  return { subjectType: binding.assetType, subjectId: binding.assetId };
}

function makeAction(
  loaded: LoadedPermissionPolicyRule,
  binding: TagBinding,
  subject: { subjectType: string; subjectId: string },
  emit: z.infer<typeof PolicyEmitSchema>,
): PermissionPolicyAction {
  const grantMode = loaded.rule.grant.mode;
  const expiresAt =
    grantMode === "temporary"
      ? Math.floor(Date.now() / 1000) + Math.ceil(parseDurationMs(loaded.rule.grant.ttl ?? "1h") / 1000)
      : null;
  const actionCore = {
    policyId: loaded.rule.id,
    policyVersion: loaded.rule.version!,
    selectorAssetType: binding.assetType,
    selectorAssetId: binding.assetId,
    tagSlug: binding.tagSlug,
    tagBindingId: binding.id,
    tagBindingSource: binding.source,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    relation: emit.relation,
    objectType: emit.object.type,
    objectId: emit.object.id,
    grantMode,
  };
  const desiredHash = digestStable(actionCore);
  const materializationId = `ppm_${digestStable({ policyId: loaded.rule.id, desiredHash }).slice(0, 24)}`;
  return {
    policyId: loaded.rule.id,
    policyVersion: loaded.rule.version!,
    source: loaded.source,
    selector: {
      assetType: binding.assetType,
      assetId: binding.assetId,
      tag: binding.tagSlug,
      bindingId: binding.id,
      bindingSource: binding.source,
    },
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    relation: emit.relation,
    objectType: emit.object.type,
    objectId: emit.object.id,
    desiredHash,
    materializationId,
    grantMode,
    expiresAt,
    status: "would_create",
    reason: loaded.rule.grant.reason ?? `permission-policy:${loaded.rule.id}@${loaded.rule.version}`,
  };
}

function invalidAction(
  loaded: LoadedPermissionPolicyRule,
  binding: TagBinding,
  emit: z.infer<typeof PolicyEmitSchema>,
  error: string,
): PermissionPolicyAction {
  const subject = "type" in emit.subject ? emit.subject : { type: binding.assetType, id: binding.assetId };
  const desiredHash = digestStable({
    policyId: loaded.rule.id,
    bindingId: binding.id,
    subject,
    relation: emit.relation,
    object: emit.object,
    error,
  });
  return {
    policyId: loaded.rule.id,
    policyVersion: loaded.rule.version!,
    source: loaded.source,
    selector: {
      assetType: binding.assetType,
      assetId: binding.assetId,
      tag: binding.tagSlug,
      bindingId: binding.id,
      bindingSource: binding.source,
    },
    subjectType: subject.type,
    subjectId: subject.id,
    relation: emit.relation,
    objectType: emit.object.type,
    objectId: emit.object.id,
    desiredHash,
    materializationId: `ppm_${digestStable({ policyId: loaded.rule.id, desiredHash }).slice(0, 24)}`,
    grantMode: loaded.rule.grant.mode,
    expiresAt: null,
    status: "invalid",
    error,
  };
}

function findExistingRelation(action: PermissionPolicyAction): Relation | null {
  return (
    listRelations({
      subjectType: action.subjectType,
      subjectId: action.subjectId,
      relation: action.relation,
      objectType: action.objectType,
      objectId: action.objectId,
    })[0] ?? null
  );
}

function grantOptionsForAction(action: PermissionPolicyAction): GrantRelationOptions {
  if (action.grantMode === "permanent") {
    return { permanent: true, reason: action.reason, issuedBy: policySource(action.policyId) };
  }
  return {
    ttlMs:
      Math.max(1, (action.expiresAt ?? Math.floor(Date.now() / 1000) + 3600) - Math.floor(Date.now() / 1000)) * 1000,
    reason: action.reason,
    issuedBy: policySource(action.policyId),
  };
}

function upsertPolicyRules(rules: LoadedPermissionPolicyRule[]): void {
  const db = getDb();
  const now = Date.now();
  const statement = db.prepare(`
    INSERT INTO permission_policy_rules (id, version, enabled, source_path, rule_json, created_at, updated_at, disabled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      version = excluded.version,
      enabled = excluded.enabled,
      source_path = excluded.source_path,
      rule_json = excluded.rule_json,
      updated_at = excluded.updated_at,
      disabled_at = excluded.disabled_at
  `);
  const tx = db.transaction((items: LoadedPermissionPolicyRule[]) => {
    for (const loaded of items) {
      const version = loaded.rule.version ?? computePolicyVersion(loaded.rule);
      statement.run(
        loaded.rule.id,
        version,
        loaded.rule.enabled ? 1 : 0,
        loaded.source,
        JSON.stringify({ ...loaded.rule, version }),
        now,
        now,
        loaded.rule.enabled ? null : now,
      );
    }
  });
  tx(rules);
}

function upsertMaterialization(action: PermissionPolicyAction): void {
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `
    INSERT INTO permission_policy_materializations (
      id,
      policy_id,
      policy_version,
      selector_asset_type,
      selector_asset_id,
      tag_slug,
      tag_binding_id,
      tag_binding_source,
      subject_type,
      subject_id,
      relation,
      object_type,
      object_id,
      desired_hash,
      relation_id,
      status,
      conflict_source,
      reason,
      expires_at,
      created_at,
      updated_at,
      revoked_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(policy_id, desired_hash) DO UPDATE SET
      policy_version = excluded.policy_version,
      selector_asset_type = excluded.selector_asset_type,
      selector_asset_id = excluded.selector_asset_id,
      tag_slug = excluded.tag_slug,
      tag_binding_id = excluded.tag_binding_id,
      tag_binding_source = excluded.tag_binding_source,
      subject_type = excluded.subject_type,
      subject_id = excluded.subject_id,
      relation = excluded.relation,
      object_type = excluded.object_type,
      object_id = excluded.object_id,
      relation_id = excluded.relation_id,
      status = excluded.status,
      conflict_source = excluded.conflict_source,
      reason = excluded.reason,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at,
      revoked_at = NULL
  `,
  ).run(
    action.materializationId,
    action.policyId,
    action.policyVersion,
    action.selector.assetType,
    action.selector.assetId,
    action.selector.tag,
    action.selector.bindingId,
    action.selector.bindingSource,
    action.subjectType,
    action.subjectId,
    action.relation,
    action.objectType,
    action.objectId,
    action.desiredHash,
    action.relationId ?? null,
    action.status,
    action.conflictSource ?? null,
    action.reason ?? null,
    action.expiresAt,
    now,
    now,
  );
}

function revokeStaleMaterializations(
  desiredPolicyIds: Set<string>,
  desiredHashes: Map<string, Set<string>>,
): PermissionPolicyMaterialization[] {
  return revokeMaterializations(findStaleMaterializations(desiredPolicyIds, desiredHashes));
}

function findStaleMaterializations(
  desiredPolicyIds: Set<string>,
  desiredHashes: Map<string, Set<string>>,
): PermissionPolicyMaterialization[] {
  if (desiredPolicyIds.size === 0) return [];
  return listPermissionPolicyMaterializations()
    .filter((item) => desiredPolicyIds.has(item.policyId) && !item.revokedAt)
    .filter((item) => !desiredHashes.get(item.policyId)?.has(item.desiredHash));
}

function revokePolicyMaterializationsWithForbiddenRoleClosures(): PermissionPolicyMaterialization[] {
  return revokeMaterializations(findMaterializationsWithForbiddenRoleClosures());
}

function findMaterializationsWithForbiddenRoleClosures(): PermissionPolicyMaterialization[] {
  return listPermissionPolicyMaterializations().filter((item) => {
    if (item.revokedAt) return false;
    if (item.objectType !== ROLE_OBJECT_TYPE) return false;
    if (item.relation !== "member" && item.relation !== "constrain") return false;
    return findForbiddenRoleClosureOutputs(item.objectId, new Map()).length > 0;
  });
}

function revokeMaterializations(items: PermissionPolicyMaterialization[]): PermissionPolicyMaterialization[] {
  if (items.length === 0) return [];
  const db = getDb();
  const revoked: PermissionPolicyMaterialization[] = [];
  const now = Date.now();

  for (const item of items) {
    revokeRelationIfSource(
      item.subjectType,
      item.subjectId,
      item.relation,
      item.objectType,
      item.objectId,
      policySource(item.policyId),
    );
    db.prepare(
      `
      UPDATE permission_policy_materializations
      SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE id = ?
    `,
    ).run(now, now, item.id);
    revoked.push({ ...item, status: "revoked", revokedAt: now, updatedAt: now });
  }

  revokeRuntimeContextsForPolicyMaterializations(
    revoked.map((item) => ({
      subjectType: item.subjectType,
      subjectId: item.subjectId,
      relation: item.relation,
      objectType: item.objectType,
      objectId: item.objectId,
    })),
  );

  return revoked;
}

function resolvePossibleSubjectTypes(rule: PermissionPolicyRule, emit: z.infer<typeof PolicyEmitSchema>): string[] {
  if ("type" in emit.subject) return [emit.subject.type];
  try {
    const selectorAssetType = requireTagAssetType(rule.selector.assetType);
    return SUBJECT_FROM_ASSET_TYPES.has(selectorAssetType) ? [selectorAssetType] : [];
  } catch {
    return [];
  }
}

function isAllowedPolicyOutput(
  rule: PermissionPolicyRule,
  subjectType: string,
  relation: string,
  objectType: string,
  objectId: string,
): boolean {
  if (objectType === ROLE_OBJECT_TYPE && objectId.trim()) {
    if (relation === "member" && ["contact", "agent", "automation"].includes(subjectType)) return true;
    if (relation === "constrain" && ["chat", "session"].includes(subjectType)) return true;
  }

  if (relation.startsWith("delegate_") && ["agent", "chat"].includes(subjectType)) {
    return isValidPolicyRelation(relation);
  }

  if (objectType === "app" && ["chat", "session"].includes(subjectType)) {
    return relation === "use" || relation === "execute";
  }

  if (subjectType === ROLE_OBJECT_TYPE) {
    return rule.kind === "profile-definition" && isValidPolicyRelation(relation);
  }

  return false;
}

function findForbiddenRoleClosureOutputs(
  roleId: string,
  emittedRoleRelations: Map<string, Array<{ relation: string; objectType: string; objectId: string }>>,
  visited = new Set<string>(),
): Array<{ relation: string; objectType: string; objectId: string }> {
  if (visited.has(roleId)) return [];
  visited.add(roleId);

  const outputs: Array<{ relation: string; objectType: string; objectId: string }> = [];
  const relations = [
    ...listRelations({ subjectType: "role", subjectId: roleId }),
    ...(emittedRoleRelations.get(roleId) ?? []),
  ];
  for (const relation of relations) {
    if (relation.relation === "member" && relation.objectType === "role") {
      outputs.push(...findForbiddenRoleClosureOutputs(relation.objectId, emittedRoleRelations, visited));
      continue;
    }
    if (isForbiddenOutput(relation.relation, relation.objectType, relation.objectId)) {
      outputs.push({ relation: relation.relation, objectType: relation.objectType, objectId: relation.objectId });
    }
  }
  return outputs;
}

function isValidPolicyRelation(relation: string): boolean {
  if (VALID_RELATIONS.has(relation)) return true;
  if (relation.startsWith(DELEGATION_OVERRIDE_RELATION_PREFIX)) {
    const baseRelation = relation.slice(DELEGATION_OVERRIDE_RELATION_PREFIX.length);
    return Boolean(baseRelation && baseRelation !== "admin" && VALID_RELATIONS.has(baseRelation));
  }
  if (relation.startsWith(DENY_RELATION_PREFIX)) {
    const baseRelation = relation.slice(DENY_RELATION_PREFIX.length);
    return Boolean(baseRelation && VALID_RELATIONS.has(baseRelation));
  }
  return false;
}

function isForbiddenOutput(relation: string, objectType: string, objectId: string): boolean {
  if (relation === "delegate_admin") return true;
  const normalizedRelation = relation.startsWith(DELEGATION_OVERRIDE_RELATION_PREFIX)
    ? relation.slice(DELEGATION_OVERRIDE_RELATION_PREFIX.length)
    : relation.startsWith(DENY_RELATION_PREFIX)
      ? relation.slice(DENY_RELATION_PREFIX.length)
      : relation;
  const normalizedObjectId = objectId.includes("*") ? "*" : objectId;
  return FORBIDDEN_BROAD_OUTPUTS.some(
    (item) =>
      item.relation === normalizedRelation && item.objectType === objectType && item.objectId === normalizedObjectId,
  );
}

function validateBreakGlassForbiddenOutput(
  source: string,
  rule: PermissionPolicyRule,
): Array<{ source: string; error: string }> {
  const errors: Array<{ source: string; error: string }> = [];
  if (!rule.approval) {
    errors.push({
      source,
      error: `${rule.id}: breakGlass forbidden output requires approval record`,
    });
  }
  if (rule.grant.mode !== "temporary") {
    errors.push({
      source,
      error: `${rule.id}: breakGlass forbidden output must be temporary`,
    });
  }
  if (rule.grant.mode === "temporary") {
    try {
      const ttlMs = parseDurationMs(rule.grant.ttl ?? "1h");
      if (ttlMs > BREAK_GLASS_MAX_TTL_MS) {
        errors.push({
          source,
          error: `${rule.id}: breakGlass forbidden output ttl exceeds ${Math.round(BREAK_GLASS_MAX_TTL_MS / 60000)}m`,
        });
      }
    } catch (error) {
      errors.push({
        source,
        error: `${rule.id}: ${(error as Error).message}`,
      });
    }
  }
  return errors;
}

function policySource(policyId: string): string {
  return `${POLICY_SOURCE_PREFIX}${policyId}`;
}

function computePolicyVersion(rule: PermissionPolicyRule): string {
  const copy = { ...rule };
  delete copy.version;
  return `sha256:${digestStable(copy).slice(0, 16)}`;
}

function digestStable(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseDurationMs(value: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)(ms|s|m|h|d|w)?$/i.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid TTL duration: ${value}`);
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : unit === "d"
              ? 86_400_000
              : 604_800_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error(`Invalid TTL duration: ${value}`);
  }
  return duration || DEFAULT_TEMPORARY_TTL_MS;
}

function buildRunResult(
  mode: PermissionPolicyRunResult["mode"],
  validation: PermissionPolicyValidationResult,
  actions: PermissionPolicyAction[],
  revoked: PermissionPolicyMaterialization[],
): PermissionPolicyRunResult {
  const rules = validation.rules.map((loaded) => ({
    id: loaded.rule.id,
    version: loaded.rule.version!,
    enabled: loaded.rule.enabled,
    source: loaded.source,
  }));
  return {
    mode,
    valid: validation.valid,
    rules,
    errors: validation.errors,
    warnings: validation.warnings,
    actions,
    revoked,
    summary: {
      rules: rules.length,
      actions: actions.length,
      created: actions.filter((action) => action.status === "created" || action.status === "would_create").length,
      refreshed: actions.filter((action) => action.status === "refreshed" || action.status === "would_refresh").length,
      conflicts: actions.filter((action) => action.status === "conflict").length,
      skipped: actions.filter((action) => action.status === "skipped").length,
      invalid: actions.filter((action) => action.status === "invalid").length,
      revoked: revoked.length,
    },
  };
}
