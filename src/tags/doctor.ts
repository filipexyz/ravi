/**
 * Read-only health report for the unified tag registry (`ravi tags doctor`).
 *
 * The report answers five questions without mutating anything:
 * - which definitions have no current binding (detached ones included);
 * - which bindings point to assets that no longer exist (only for asset types
 *   whose table lives in the Ravi DB; the rest are listed as unchecked);
 * - which bound tags have no behavior consumer (observer rule, tag rule,
 *   permission provider or chat-tag grant scope), so they only serve list
 *   filters;
 * - which contacts get capabilities from their tags (registry bindings or the
 *   contact policy), and which of those are break-glass;
 * - which bindings come from legacy mirrors, and how much rewrite churn each
 *   source produces.
 *
 * It never writes tag definitions, bindings or events. Opening the Ravi DB runs
 * the same schema bootstrap as any other CLI command.
 */
import { breakGlassCapabilities, isPermissionProfileDefinition } from "../permissions/break-glass.js";
import { isPermissionPolicyTag } from "../permissions/permission-tags.js";
import { getDb } from "../router/router-db.js";
import { dbListObserverRules } from "../runtime/observation-plane.js";
import { loadTagRulesFromDirectory } from "../tag-rules/loader.js";
import { ensureTagSchema, tryNormalizeTagSlug } from "./tag-db.js";

/** Asset types whose existence can be checked in the Ravi DB, and how. */
export const TAG_DOCTOR_ASSET_CHECKS: ReadonlyArray<{ assetType: string; table: string; columns: readonly string[] }> =
  [
    { assetType: "task", table: "tasks", columns: ["id"] },
    { assetType: "agent", table: "agents", columns: ["id"] },
    // A session binding stores the name, or the key for unnamed sessions (tags/targets.ts).
    { assetType: "session", table: "sessions", columns: ["name", "session_key"] },
    { assetType: "artifact", table: "artifacts", columns: ["id"] },
  ];

/** Binding sources that mirror another store instead of being written as tags. */
export const TAG_DOCTOR_LEGACY_MIRROR_SOURCES: readonly string[] = [
  "contacts_v2.tags",
  "contact_policies.tags_json",
  "artifacts.tags_json",
  "task_profile.defaulttags",
  "devin.remote_tags",
];

export type TagDoctorConsumerKind = "observer_rule" | "tag_rule" | "permission_provider";

export interface TagDoctorReport {
  generatedAt: number;
  summary: {
    definitions: number;
    bindings: number;
    unboundDefinitions: number;
    orphanBindings: number;
    boundTagsWithoutConsumer: number;
    contactsWithCapabilities: number;
    contactsWithBreakGlass: number;
    legacyMirrorBindings: number;
  };
  bindingsByAssetType: Array<{ assetType: string; bindings: number; assets: number; tags: number }>;
  unboundDefinitions: Array<{ slug: string; kind: string; source: string; createdAt: number }>;
  orphanBindings: {
    checked: Array<{ assetType: string; bindings: number; orphans: number; sampleAssetIds: string[] }>;
    uncheckedAssetTypes: string[];
  };
  consumers: Array<{ slug: string; kinds: TagDoctorConsumerKind[]; enabled: boolean }>;
  tagsWithoutConsumer: Array<{ slug: string; bindings: number; assetTypes: string[] }>;
  powerTags: Array<{ contactId: string; capabilities: string[]; breakGlass: string[]; sources: string[] }>;
  legacyMirrors: Array<{ source: string; bindings: number; rewrites: number }>;
  tagRuleErrors: Array<{ source: string; error: string }>;
  limit: number;
}

export interface TagDoctorOptions {
  /** Max items per list section (every list); counts in `summary` are never truncated. */
  limit?: number;
  now?: number;
  /**
   * Capability materialization for one contact. Injected by the caller (the CLI
   * passes the contact-policy provider) to keep this module out of the
   * permissions provider import cycle.
   */
  materializeContact: (
    contactId: string,
  ) => Array<{ permission: string; objectType: string; objectId: string; source?: string }>;
  /**
   * Contacts whose contact policy carries tags, wherever the policy lives.
   * Union-ed with contacts that have registry bindings, so a policy tag with
   * no binding still shows its power.
   */
  listPolicyContactIds?: () => string[];
  /** Test seam: tag rules (defaults to the state-dir rule files). */
  loadTagRules?: () => {
    rules: Array<{ rule: unknown }>;
    errors: Array<{ source: string; error: string }>;
  };
}

const DEFAULT_LIMIT = 50;

function tableColumns(table: string): Set<string> {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!exists) return new Set();
  const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
  return new Set(columns.map((entry) => entry.name));
}

/** Every tag slug a rule mentions: apply actions and any tag-valued condition key. */
function collectRuleTagSlugs(value: unknown, out: Set<string>, keyIsTag = false): void {
  if (typeof value === "string") {
    if (keyIsTag) {
      const slug = tryNormalizeTagSlug(value);
      if (slug) out.add(slug);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRuleTagSlugs(item, out, keyIsTag);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectRuleTagSlugs(child, out, /tag/i.test(key));
    }
  }
}

function capabilityString(cap: { permission: string; objectType: string; objectId: string }): string {
  return `${cap.permission}:${cap.objectType}:${cap.objectId}`;
}

export function buildTagDoctorReport(options: TagDoctorOptions): TagDoctorReport {
  ensureTagSchema();
  const db = getDb();
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT));

  const definitions = db
    .prepare("SELECT id, slug, kind, source, metadata_json, created_at FROM tag_definitions ORDER BY slug")
    .all() as Array<{
    id: string;
    slug: string;
    kind: string;
    source: string;
    metadata_json: string | null;
    created_at: number;
  }>;
  const bindingStats = db
    .prepare(
      `SELECT d.slug AS slug, b.asset_type AS assetType, COUNT(*) AS n
         FROM tag_bindings b JOIN tag_definitions d ON d.id = b.tag_id
        GROUP BY d.slug, b.asset_type`,
    )
    .all() as Array<{ slug: string; assetType: string; n: number }>;
  const totalBindings = (db.prepare("SELECT COUNT(*) AS n FROM tag_bindings").get() as { n: number }).n;

  const byAssetType = db
    .prepare(
      `SELECT asset_type AS assetType, COUNT(*) AS bindings, COUNT(DISTINCT asset_id) AS assets, COUNT(DISTINCT tag_id) AS tags
         FROM tag_bindings GROUP BY asset_type ORDER BY bindings DESC, asset_type`,
    )
    .all() as TagDoctorReport["bindingsByAssetType"];

  const boundCount = new Map<string, number>();
  const boundTypes = new Map<string, Set<string>>();
  for (const row of bindingStats) {
    boundCount.set(row.slug, (boundCount.get(row.slug) ?? 0) + row.n);
    const types = boundTypes.get(row.slug) ?? new Set<string>();
    types.add(row.assetType);
    boundTypes.set(row.slug, types);
  }

  const unused = definitions
    .filter((definition) => !boundCount.has(definition.slug))
    .map((definition) => ({
      slug: definition.slug,
      kind: definition.kind,
      source: definition.source,
      createdAt: definition.created_at,
    }));

  // Orphans: only where the asset table lives in this DB.
  const checkedTypes = new Set<string>();
  const checked: TagDoctorReport["orphanBindings"]["checked"] = [];
  for (const check of TAG_DOCTOR_ASSET_CHECKS) {
    const available = tableColumns(check.table);
    const columns = check.columns.filter((column) => available.has(column));
    if (columns.length === 0) continue;
    checkedTypes.add(check.assetType);
    const match = columns.map((column) => `a.${JSON.stringify(column)} = b.asset_id`).join(" OR ");
    const orphanWhere = `b.asset_type = ? AND NOT EXISTS (SELECT 1 FROM ${JSON.stringify(check.table)} a WHERE ${match})`;
    const bindings = (
      db.prepare("SELECT COUNT(*) AS n FROM tag_bindings WHERE asset_type = ?").get(check.assetType) as { n: number }
    ).n;
    const orphans = (
      db.prepare(`SELECT COUNT(*) AS n FROM tag_bindings b WHERE ${orphanWhere}`).get(check.assetType) as {
        n: number;
      }
    ).n;
    const sample = db
      .prepare(`SELECT DISTINCT b.asset_id AS id FROM tag_bindings b WHERE ${orphanWhere} ORDER BY b.asset_id LIMIT ?`)
      .all(check.assetType, Math.min(limit, 10)) as Array<{ id: string }>;
    checked.push({ assetType: check.assetType, bindings, orphans, sampleAssetIds: sample.map((row) => row.id) });
  }
  const uncheckedAssetTypes = byAssetType
    .map((row) => row.assetType)
    .filter((assetType) => !checkedTypes.has(assetType))
    .sort();

  // Behavior consumers.
  const consumerKinds = new Map<string, Set<TagDoctorConsumerKind>>();
  const consumerEnabled = new Map<string, boolean>();
  const addConsumer = (slug: string, kind: TagDoctorConsumerKind, enabled: boolean) => {
    const kinds = consumerKinds.get(slug) ?? new Set<TagDoctorConsumerKind>();
    kinds.add(kind);
    consumerKinds.set(slug, kinds);
    consumerEnabled.set(slug, (consumerEnabled.get(slug) ?? false) || enabled);
  };
  for (const rule of dbListObserverRules()) {
    if (rule.scope === "tag" && rule.tagSlug) addConsumer(rule.tagSlug, "observer_rule", rule.enabled);
  }
  const tagRules = (options.loadTagRules ?? (() => loadTagRulesFromDirectory()))();
  for (const { rule } of tagRules.rules) {
    const enabled = (rule as { enabled?: boolean } | null)?.enabled !== false;
    const slugs = new Set<string>();
    collectRuleTagSlugs(rule, slugs);
    for (const slug of slugs) addConsumer(slug, "tag_rule", enabled);
  }
  for (const definition of definitions) {
    if (isPermissionProfileDefinition({ kind: definition.kind, source: definition.source })) {
      addConsumer(definition.slug, "permission_provider", true);
    }
  }
  // Chat tags that scope a contact grant (`permissions allow --chat-tag`).
  if (tableColumns("permission_contact_chat_grants").has("scope_type")) {
    const scoped = db
      .prepare("SELECT DISTINCT scope_id AS slug FROM permission_contact_chat_grants WHERE scope_type = 'chat_tag'")
      .all() as Array<{ slug: string }>;
    for (const row of scoped) {
      const slug = tryNormalizeTagSlug(row.slug);
      if (slug) addConsumer(slug, "permission_provider", true);
    }
  }
  // Contact tags the permission provider reads in any spelling (permission.admin, permission-owner).
  for (const row of bindingStats) {
    if (row.assetType === "contact" && isPermissionPolicyTag(row.slug)) {
      addConsumer(row.slug, "permission_provider", true);
    }
  }

  const consumers = [...consumerKinds.entries()]
    .map(([slug, kinds]) => ({ slug, kinds: [...kinds].sort(), enabled: consumerEnabled.get(slug) ?? false }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const withoutConsumer = [...boundCount.entries()]
    .filter(([slug]) => !consumerKinds.has(slug))
    .map(([slug, bindings]) => ({ slug, bindings, assetTypes: [...(boundTypes.get(slug) ?? [])].sort() }))
    .sort((a, b) => b.bindings - a.bindings || a.slug.localeCompare(b.slug));

  // Contacts whose tags materialize capabilities.
  const materialize = options.materializeContact;
  const contactIds = [
    ...new Set([
      ...(
        db.prepare("SELECT DISTINCT asset_id AS id FROM tag_bindings WHERE asset_type = 'contact'").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
      ...(options.listPolicyContactIds?.() ?? []),
    ]),
  ].sort();
  const powerTags: TagDoctorReport["powerTags"] = [];
  for (const contactId of contactIds) {
    const capabilities = materialize(contactId);
    if (capabilities.length === 0) continue;
    powerTags.push({
      contactId,
      capabilities: capabilities.map(capabilityString).sort(),
      breakGlass: breakGlassCapabilities(capabilities).sort(),
      sources: [...new Set(capabilities.map((cap) => cap.source).filter((s): s is string => Boolean(s)))].sort(),
    });
  }
  powerTags.sort((a, b) => b.breakGlass.length - a.breakGlass.length || a.contactId.localeCompare(b.contactId));

  // Legacy mirrors and rewrite churn.
  const bySource = new Map(
    (
      db.prepare("SELECT source, COUNT(*) AS n FROM tag_bindings GROUP BY source").all() as Array<{
        source: string;
        n: number;
      }>
    ).map((row) => [row.source, row.n]),
  );
  const rewrites = new Map(
    (
      db
        .prepare(
          "SELECT source, COUNT(*) AS n FROM tag_events WHERE event_type = 'tag.binding.updated' GROUP BY source",
        )
        .all() as Array<{ source: string; n: number }>
    ).map((row) => [row.source, row.n]),
  );
  const legacyMirrors = TAG_DOCTOR_LEGACY_MIRROR_SOURCES.map((source) => ({
    source,
    bindings: bySource.get(source) ?? 0,
    rewrites: rewrites.get(source) ?? 0,
  })).filter((row) => row.bindings > 0 || row.rewrites > 0);

  const orphanTotal = checked.reduce((sum, row) => sum + row.orphans, 0);
  return {
    generatedAt: options.now ?? Date.now(),
    summary: {
      definitions: definitions.length,
      bindings: totalBindings,
      unboundDefinitions: unused.length,
      orphanBindings: orphanTotal,
      boundTagsWithoutConsumer: withoutConsumer.length,
      contactsWithCapabilities: powerTags.length,
      contactsWithBreakGlass: powerTags.filter((row) => row.breakGlass.length > 0).length,
      legacyMirrorBindings: legacyMirrors.reduce((sum, row) => sum + row.bindings, 0),
    },
    bindingsByAssetType: byAssetType.slice(0, limit),
    unboundDefinitions: unused.slice(0, limit),
    orphanBindings: { checked: checked.slice(0, limit), uncheckedAssetTypes: uncheckedAssetTypes.slice(0, limit) },
    consumers: consumers.slice(0, limit),
    tagsWithoutConsumer: withoutConsumer.slice(0, limit),
    powerTags: powerTags.slice(0, limit),
    legacyMirrors: legacyMirrors.slice(0, limit),
    tagRuleErrors: tagRules.errors.slice(0, limit),
    limit,
  };
}
