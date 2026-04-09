import { afterEach, describe, expect, it } from "bun:test";
import {
  dbCreateTagDefinition,
  dbDeleteTagBinding,
  dbFindTagBindings,
  dbGetTagDefinition,
  dbListTagDefinitions,
  dbUpsertTagBinding,
} from "./index.js";
import { getDb } from "../router/router-db.js";

const createdSlugs: string[] = [];

afterEach(() => {
  const db = getDb();
  while (createdSlugs.length > 0) {
    const slug = createdSlugs.pop();
    if (slug) {
      db.prepare("DELETE FROM tag_bindings WHERE tag_id IN (SELECT id FROM tag_definitions WHERE slug = ?)").run(slug);
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

    expect(agentBinding.tagSlug).toBe("core");
    expect(sessionBinding.assetType).toBe("session");
    expect(dbFindTagBindings({ slug: "core" })).toHaveLength(2);
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
    expect(dbFindTagBindings({ slug: "core" })).toHaveLength(1);
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
});
