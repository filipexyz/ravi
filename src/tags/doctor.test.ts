import { afterEach, describe, expect, it } from "bun:test";
import { getDb } from "../router/router-db.js";
import { buildTagDoctorReport } from "./doctor.js";
import { dbCreateTagDefinition, dbUpsertTagBinding } from "./index.js";

const PREFIX = "doctor-test";
const createdSlugs: string[] = [];

function createTag(slug: string, extra: { kind?: "system" | "user"; source?: string } = {}): string {
  const tag = dbCreateTagDefinition({ slug, label: slug, ...extra });
  createdSlugs.push(tag.slug);
  return tag.slug;
}

const noRules = () => ({ rules: [], errors: [] });
const noPower = () => [];

afterEach(() => {
  const db = getDb();
  while (createdSlugs.length > 0) {
    const slug = createdSlugs.pop();
    if (!slug) continue;
    db.prepare("DELETE FROM tag_bindings WHERE tag_id IN (SELECT id FROM tag_definitions WHERE slug = ?)").run(slug);
    db.prepare("DELETE FROM tag_events WHERE tag_slug = ?").run(slug);
    db.prepare("DELETE FROM tag_definitions WHERE slug = ?").run(slug);
  }
});

describe("buildTagDoctorReport", () => {
  it("lists a definition that was never bound and drops it once bound", () => {
    const slug = createTag(`${PREFIX}.unused`);
    let report = buildTagDoctorReport({ limit: 500, loadTagRules: noRules, materializeContact: noPower });
    expect(report.unboundDefinitions.map((row) => row.slug)).toContain(slug);

    dbUpsertTagBinding({ slug, assetType: "contact", assetId: `${PREFIX}-c1` });
    report = buildTagDoctorReport({ limit: 500, loadTagRules: noRules, materializeContact: noPower });
    expect(report.unboundDefinitions.map((row) => row.slug)).not.toContain(slug);
  });

  it("counts a binding to an agent that does not exist as orphan", () => {
    const slug = createTag(`${PREFIX}.orphan`);
    const ghost = `${PREFIX}-ghost-agent`;
    dbUpsertTagBinding({ slug, assetType: "agent", assetId: ghost });

    const report = buildTagDoctorReport({ limit: 500, loadTagRules: noRules, materializeContact: noPower });
    const agents = report.orphanBindings.checked.find((row) => row.assetType === "agent");
    expect(agents).toBeDefined();
    expect(agents?.orphans ?? 0).toBeGreaterThanOrEqual(1);
    expect(agents?.sampleAssetIds).toContain(ghost);
    expect(report.summary.orphanBindings).toBeGreaterThanOrEqual(1);
    expect(report.orphanBindings.uncheckedAssetTypes).not.toContain("agent");
  });

  it("separates tags with a behavior consumer from tags only used by list filters", () => {
    const ruled = createTag(`${PREFIX}.ruled`);
    const permission = createTag(`${PREFIX}-perm`);
    const permissionTag = createTag(`permission.${PREFIX}`);
    const idle = createTag(`${PREFIX}.idle`);
    for (const slug of [ruled, permission, permissionTag, idle]) {
      dbUpsertTagBinding({ slug, assetType: "contact", assetId: `${PREFIX}-c2` });
    }
    getDb()
      .prepare("UPDATE tag_definitions SET kind = 'system', source = 'permissions' WHERE slug = ?")
      .run(permission);

    const report = buildTagDoctorReport({
      limit: 500,
      materializeContact: noPower,
      loadTagRules: () => ({ rules: [{ rule: { apply: [{ tag: ruled }] } }], errors: [] }),
    });
    const consumerOf = (slug: string) => report.consumers.find((row) => row.slug === slug)?.kinds ?? [];
    expect(consumerOf(ruled)).toEqual(["tag_rule"]);
    expect(consumerOf(permission)).toEqual(["permission_provider"]);
    expect(consumerOf(permissionTag)).toEqual(["permission_provider"]);

    const without = report.tagsWithoutConsumer.map((row) => row.slug);
    expect(without).toContain(idle);
    expect(without).not.toContain(ruled);
    expect(without).not.toContain(permission);
    expect(without).not.toContain(permissionTag);
  });

  it("flags a contact whose tags materialize break-glass power", () => {
    const slug = createTag(`${PREFIX}.admin-holder`);
    const powerful = `${PREFIX}-admin-contact`;
    const plain = `${PREFIX}-plain-contact`;
    dbUpsertTagBinding({ slug, assetType: "contact", assetId: powerful });
    dbUpsertTagBinding({ slug, assetType: "contact", assetId: plain });

    const report = buildTagDoctorReport({
      limit: 500,
      loadTagRules: noRules,
      materializeContact: (contactId) =>
        contactId === powerful
          ? [
              {
                permission: "admin",
                objectType: "system",
                objectId: "*",
                source: `contact-policy:contact:${powerful}:admin-tag`,
              },
            ]
          : [],
    });
    const row = report.powerTags.find((entry) => entry.contactId === powerful);
    expect(row?.breakGlass).toEqual(["admin:system:*"]);
    expect(row?.sources).toEqual([`contact-policy:contact:${powerful}:admin-tag`]);
    expect(report.powerTags.find((entry) => entry.contactId === plain)).toBeUndefined();
    expect(report.summary.contactsWithBreakGlass).toBeGreaterThanOrEqual(1);
  });

  it("reports legacy mirror sources with their rewrite churn", () => {
    const slug = createTag(`${PREFIX}.mirror`);
    dbUpsertTagBinding({ slug, assetType: "contact", assetId: `${PREFIX}-c3`, source: "contacts_v2.tags" });
    dbUpsertTagBinding({ slug, assetType: "contact", assetId: `${PREFIX}-c3`, source: "contacts_v2.tags" });

    const report = buildTagDoctorReport({ limit: 500, loadTagRules: noRules, materializeContact: noPower });
    const mirror = report.legacyMirrors.find((row) => row.source === "contacts_v2.tags");
    expect(mirror?.bindings ?? 0).toBeGreaterThanOrEqual(1);
    expect(mirror?.rewrites ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("truncates list sections to the limit but never the summary counts", () => {
    const slugs = [createTag(`${PREFIX}.cap-a`), createTag(`${PREFIX}.cap-b`), createTag(`${PREFIX}.cap-c`)];
    const report = buildTagDoctorReport({ limit: 1, loadTagRules: noRules, materializeContact: noPower });
    expect(report.unboundDefinitions.length).toBe(1);
    expect(report.summary.unboundDefinitions).toBeGreaterThanOrEqual(slugs.length);
    expect(report.limit).toBe(1);
  });

  it("never writes: tag tables are unchanged after a report", () => {
    const slug = createTag(`${PREFIX}.readonly`);
    dbUpsertTagBinding({ slug, assetType: "agent", assetId: `${PREFIX}-ghost-2` });
    const db = getDb();
    const snapshot = () =>
      JSON.stringify({
        d: db.prepare("SELECT COUNT(*) AS n FROM tag_definitions").get(),
        b: db.prepare("SELECT COUNT(*) AS n FROM tag_bindings").get(),
        e: db.prepare("SELECT COUNT(*) AS n FROM tag_events").get(),
      });
    const before = snapshot();
    buildTagDoctorReport({ loadTagRules: noRules, materializeContact: noPower });
    expect(snapshot()).toBe(before);
  });

  it("counts tags a rule only checks in conditions, in any spelling, as consumed", () => {
    const checked = createTag(`${PREFIX}.cond`);
    const spelled = createTag(`${PREFIX}.spelled`);
    for (const slug of [checked, spelled]) {
      dbUpsertTagBinding({ slug, assetType: "contact", assetId: `${PREFIX}-c4` });
    }
    const report = buildTagDoctorReport({
      limit: 500,
      materializeContact: noPower,
      loadTagRules: () => ({
        rules: [
          {
            rule: {
              conditions: [{ "has-chat-with": { "has-any-tag": [checked] } }],
              apply: [{ tag: `  ${spelled.toUpperCase()} ` }],
            },
          },
        ],
        errors: [],
      }),
    });
    const without = report.tagsWithoutConsumer.map((row) => row.slug);
    expect(without).not.toContain(checked);
    expect(without).not.toContain(spelled);
  });

  it("counts a chat tag that scopes a contact grant as consumed", () => {
    const slug = createTag(`${PREFIX}.chat-scope`);
    dbUpsertTagBinding({ slug, assetType: "chat", assetId: `${PREFIX}-chat` });
    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS permission_contact_chat_grants (
      id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, profile_slug TEXT NOT NULL,
      scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, created_by TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    const grantId = `${PREFIX}-grant`;
    db.prepare(
      "INSERT INTO permission_contact_chat_grants (id, contact_id, profile_slug, scope_type, scope_id, created_at, updated_at) VALUES (?, ?, ?, 'chat_tag', ?, 0, 0)",
    ).run(grantId, `${PREFIX}-c5`, "permission-family", slug);
    try {
      const report = buildTagDoctorReport({ limit: 500, loadTagRules: noRules, materializeContact: noPower });
      expect(report.consumers.find((row) => row.slug === slug)?.kinds).toEqual(["permission_provider"]);
      expect(report.tagsWithoutConsumer.map((row) => row.slug)).not.toContain(slug);
    } finally {
      db.prepare("DELETE FROM permission_contact_chat_grants WHERE id = ?").run(grantId);
    }
  });

  it("shows power from a contact policy tag that has no registry binding", () => {
    const policyOnly = `${PREFIX}-policy-only`;
    const report = buildTagDoctorReport({
      limit: 500,
      loadTagRules: noRules,
      listPolicyContactIds: () => [policyOnly],
      materializeContact: (contactId) =>
        contactId === policyOnly
          ? [{ permission: "admin", objectType: "system", objectId: "*", source: "admin-tag" }]
          : [],
    });
    expect(report.powerTags.find((row) => row.contactId === policyOnly)?.breakGlass).toEqual(["admin:system:*"]);
  });

  it("does not count a session binding stored under the session key as orphan", () => {
    const db = getDb();
    const columns = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((row) => row.name),
    );
    if (!columns.has("session_key") || !columns.has("name")) return;
    const key = `agent:${PREFIX}:main`;
    const slug = createTag(`${PREFIX}.session-key`);
    const required = (
      db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string; notnull: number; dflt_value: unknown }>
    ).filter((row) => row.notnull && row.dflt_value === null && row.name !== "session_key");
    const values: Record<string, unknown> = { session_key: key };
    for (const row of required) values[row.name] = row.name.endsWith("_at") ? 0 : `${PREFIX}-${row.name}`;
    if ("name" in values) values.name = null;
    const names = Object.keys(values);
    db.prepare(`INSERT INTO sessions (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(
      ...names.map((name) => values[name] as never),
    );
    dbUpsertTagBinding({ slug, assetType: "session", assetId: key });
    try {
      const report = buildTagDoctorReport({ limit: 500, loadTagRules: noRules, materializeContact: noPower });
      const sessions = report.orphanBindings.checked.find((row) => row.assetType === "session");
      expect(sessions?.sampleAssetIds ?? []).not.toContain(key);
    } finally {
      db.prepare("DELETE FROM sessions WHERE session_key = ?").run(key);
    }
  });

  it("applies the limit to every list section, break-glass contacts first", () => {
    const report = buildTagDoctorReport({
      limit: 1,
      loadTagRules: () => ({
        rules: [],
        errors: [
          { source: "a", error: "x" },
          { source: "b", error: "y" },
        ],
      }),
      listPolicyContactIds: () => [`${PREFIX}-p1`, `${PREFIX}-p2`],
      materializeContact: (contactId) =>
        contactId === `${PREFIX}-p2`
          ? [{ permission: "admin", objectType: "system", objectId: "*" }]
          : [{ permission: "read", objectType: "skills", objectId: "show" }],
    });
    expect(report.powerTags.map((row) => row.contactId)).toEqual([`${PREFIX}-p2`]);
    expect(report.summary.contactsWithCapabilities).toBe(2);
    expect(report.tagRuleErrors.length).toBe(1);
    expect(report.bindingsByAssetType.length).toBeLessThanOrEqual(1);
    expect(report.legacyMirrors.length).toBeLessThanOrEqual(1);
  });
});
