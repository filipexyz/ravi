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
    expect(report.unusedDefinitions.map((row) => row.slug)).toContain(slug);

    dbUpsertTagBinding({ slug, assetType: "contact", assetId: `${PREFIX}-c1` });
    report = buildTagDoctorReport({ limit: 500, loadTagRules: noRules, materializeContact: noPower });
    expect(report.unusedDefinitions.map((row) => row.slug)).not.toContain(slug);
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
    expect(report.unusedDefinitions.length).toBe(1);
    expect(report.summary.unusedDefinitions).toBeGreaterThanOrEqual(slugs.length);
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
});
