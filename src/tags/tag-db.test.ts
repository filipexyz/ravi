import { afterEach, describe, expect, it } from "bun:test";
import {
  dbCreateTagDefinition,
  dbDeleteTagBinding,
  dbFindTagBindings,
  dbGetTagDefinition,
  dbListTagEvents,
  dbListTagDefinitions,
  dbUpdateTagDefinition,
  dbUpsertTagBinding,
  replaceMirroredTagSlugsForAsset,
} from "./index.js";
import { getDb } from "../router/router-db.js";

const createdSlugs: string[] = [];

afterEach(() => {
  const db = getDb();
  while (createdSlugs.length > 0) {
    const slug = createdSlugs.pop();
    if (slug) {
      db.prepare("DELETE FROM tag_bindings WHERE tag_id IN (SELECT id FROM tag_definitions WHERE slug = ?)").run(slug);
      db.prepare("DELETE FROM tag_events WHERE tag_slug = ?").run(slug);
      db.prepare("DELETE FROM tag_definitions WHERE slug = ?").run(slug);
    }
  }
});

describe("tag-db", () => {
  it("creates tag definitions and counts bindings", () => {
    const tag = dbCreateTagDefinition({
      slug: "overlay",
      label: "Overlay",
      description: "Sessions and agents related to the overlay",
      metadata: { color: "green" },
    });
    createdSlugs.push(tag.slug);

    expect(dbGetTagDefinition("overlay")).toMatchObject({
      slug: "overlay",
      label: "Overlay",
      source: "ravi",
      metadata: { color: "green" },
    });

    const listed = dbListTagDefinitions();
    expect(listed.find((item) => item.slug === "overlay")?.bindingCount).toBe(0);
  });

  it("attaches and detaches tags across multiple asset types", () => {
    const tag = dbCreateTagDefinition({
      slug: "core",
      label: "Core",
    });
    createdSlugs.push(tag.slug);

    const agentBinding = dbUpsertTagBinding({
      slug: "core",
      assetType: "agent",
      assetId: "dev",
      metadata: { team: "platform" },
      createdBy: "main",
    });
    const sessionBinding = dbUpsertTagBinding({
      slug: "core",
      assetType: "session",
      assetId: "dev",
      metadata: { lane: "hot" },
      createdBy: "main",
    });
    const chatBinding = dbUpsertTagBinding({
      slug: "core",
      assetType: "chat",
      assetId: "chat_123",
      metadata: { surface: "whatsapp" },
      createdBy: "main",
    });
    const routeBinding = dbUpsertTagBinding({
      slug: "core",
      assetType: "route",
      assetId: "42",
      createdBy: "main",
    });
    const instanceBinding = dbUpsertTagBinding({
      slug: "core",
      assetType: "instance",
      assetId: "main",
      createdBy: "main",
    });

    expect(agentBinding.tagSlug).toBe("core");
    expect(sessionBinding.assetType).toBe("session");
    expect(chatBinding.assetType).toBe("chat");
    expect(routeBinding.assetId).toBe("42");
    expect(instanceBinding.assetType).toBe("instance");
    expect(dbFindTagBindings({ slug: "core" })).toHaveLength(5);
    expect(dbFindTagBindings({ assetType: "agent", assetId: "dev" })[0]?.metadata).toEqual({
      team: "platform",
    });

    expect(
      dbDeleteTagBinding({
        slug: "core",
        assetType: "session",
        assetId: "dev",
      }),
    ).toBe(true);
    expect(dbFindTagBindings({ slug: "core" })).toHaveLength(4);
  });

  it("updates an existing binding instead of duplicating it", () => {
    const tag = dbCreateTagDefinition({
      slug: "project.overlay",
      label: "Project Overlay",
    });
    createdSlugs.push(tag.slug);

    dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "session",
      assetId: "dev",
      metadata: { role: "investigation" },
      createdBy: "main",
    });
    const updated = dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "session",
      assetId: "dev",
      metadata: { role: "delivery", phase: "v1" },
      createdBy: "dev",
    });

    expect(dbFindTagBindings({ slug: tag.slug })).toHaveLength(1);
    expect(updated.metadata).toEqual({ role: "delivery", phase: "v1" });
  });

  it("preserves binding metadata and source when reattached without explicit updates", () => {
    const tag = dbCreateTagDefinition({
      slug: "provider.preserved",
      label: "Provider Preserved",
    });
    createdSlugs.push(tag.slug);

    dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "agent",
      assetId: "dev",
      source: "external.provider",
      metadata: { external: true },
      createdBy: "provider",
    });
    const reattached = dbUpsertTagBinding({
      slug: tag.slug,
      assetType: "agent",
      assetId: "dev",
      createdBy: "cli",
    });

    expect(dbFindTagBindings({ slug: tag.slug })).toHaveLength(1);
    expect(reattached.source).toBe("external.provider");
    expect(reattached.metadata).toEqual({ external: true });
    expect(reattached.updatedBy).toBe("cli");
  });

  it("filters and paginates definitions with a stable cursor", () => {
    const tags = ["page-test-a", "page-test-b", "page-test-c"].map((slug) =>
      dbCreateTagDefinition({
        slug,
        label: slug,
      }),
    );
    createdSlugs.push(...tags.map((tag) => tag.slug));

    const db = getDb();
    tags.forEach((tag, index) => {
      db.prepare("UPDATE tag_definitions SET updated_at = ? WHERE slug = ?").run(1000 + index, tag.slug);
    });

    const pageOne = dbListTagDefinitions({
      query: "page-test-",
      limit: 2,
      sort: "updated",
      order: "asc",
    });
    expect(pageOne.map((tag) => tag.slug)).toEqual(["page-test-a", "page-test-b"]);

    const pageTwo = dbListTagDefinitions({
      query: "page-test-",
      limit: 2,
      sort: "updated",
      order: "asc",
      cursor: {
        sort: "updated",
        order: "asc",
        value: pageOne[1].updatedAt,
        id: pageOne[1].id,
      },
    });
    expect(pageTwo.map((tag) => tag.slug)).toEqual(["page-test-c"]);
  });

  it("updates definition provenance with audit events", () => {
    const tag = dbCreateTagDefinition({
      slug: "needs-observer",
      label: "Needs Observer",
    });
    createdSlugs.push(tag.slug);

    const updated = dbUpdateTagDefinition({
      slug: tag.slug,
      source: "operator",
      metadata: { owner: "dev" },
      updatedBy: "dev",
    });

    expect(updated.source).toBe("operator");
    expect(updated.metadata).toEqual({ owner: "dev" });
    expect(updated.updatedBy).toBe("dev");
    expect(dbListTagDefinitions({ source: "operator" }).some((item) => item.slug === tag.slug)).toBe(true);
    expect(dbListTagEvents({ slug: tag.slug }).map((event) => event.type)).toContain("tag.definition.updated");
  });

  it("preserves canonical source for mirrored tag bindings and prunes stale mirrored tags", () => {
    const first = replaceMirroredTagSlugsForAsset({
      assetType: "devin_session",
      assetId: "devin-123",
      tags: ["provider.remote", "provider.stale"],
      source: "devin.remote_tags",
      createdBy: "devin.store",
      metadata: { external: true },
      definitionMetadata: { provider: "devin" },
    });
    createdSlugs.push("provider.remote", "provider.stale");

    expect(first.map((binding) => binding.source)).toEqual(["devin.remote_tags", "devin.remote_tags"]);
    expect(dbGetTagDefinition("provider.remote")).toMatchObject({
      source: "devin.remote_tags",
      metadata: { provider: "devin" },
    });

    replaceMirroredTagSlugsForAsset({
      assetType: "devin_session",
      assetId: "devin-123",
      tags: ["provider.remote"],
      source: "devin.remote_tags",
      createdBy: "devin.store",
    });

    expect(
      dbFindTagBindings({ assetType: "devin_session", assetId: "devin-123" }).map((binding) => binding.tagSlug),
    ).toEqual(["provider.remote"]);
  });
});
