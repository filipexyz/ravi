import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbCreateProject } from "../projects/project-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { attachTagToSelector, detachTagFromSelector } from "./service.js";
import { dbCreateTagDefinition, dbFindTagBindings, dbUpsertTagBinding } from "./tag-db.js";
import { resolveTagTargetSelector, TAG_TARGET_DESCRIPTORS } from "./targets.js";
import { TAG_ASSET_TYPES } from "./types.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("tag-targets-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("tag target registry", () => {
  it("has one descriptor for every canonical asset type", () => {
    expect(TAG_TARGET_DESCRIPTORS.map((descriptor) => descriptor.assetType).sort()).toEqual(
      [...TAG_ASSET_TYPES].sort(),
    );
    expect(new Set(TAG_TARGET_DESCRIPTORS.map((descriptor) => descriptor.flag)).size).toBe(
      TAG_TARGET_DESCRIPTORS.length,
    );
  });

  it("requires existing assets for attach but allows orphan lookup for cleanup", () => {
    expect(() => resolveTagTargetSelector({ artifact: "art_missing" }, { operation: "attach" })).toThrow(
      "Artifact not found: art_missing",
    );

    expect(resolveTagTargetSelector({ artifact: "art_missing" }, { operation: "detach" })).toMatchObject({
      assetType: "artifact",
      assetId: "art_missing",
      exists: false,
    });
  });

  it("normalizes generic target selectors through the descriptor resolver", () => {
    const project = dbCreateProject({
      title: "Registry Project",
      slug: "registry-project",
      summary: "Registry test project",
      hypothesis: "central target resolver",
      nextStep: "validate",
      lastSignalAt: Date.now(),
    });

    expect(resolveTagTargetSelector({ target: `project:${project.id}` }, { operation: "attach" })).toMatchObject({
      assetType: "project",
      assetId: "registry-project",
      exists: true,
    });
  });

  it("resolves virtual automation targets", () => {
    expect(resolveTagTargetSelector({ target: "automation:session-followup" }, { operation: "attach" })).toMatchObject({
      assetType: "automation",
      assetId: "session-followup",
      exists: true,
    });
  });

  it("keeps attach strict while detach can remove an existing orphan binding", () => {
    dbCreateTagDefinition({ slug: "orphan.cleanup", label: "Orphan Cleanup" });

    expect(() =>
      attachTagToSelector({
        slug: "orphan.cleanup",
        selector: { artifact: "art_missing" },
      }),
    ).toThrow("Artifact not found: art_missing");

    dbUpsertTagBinding({
      slug: "orphan.cleanup",
      assetType: "artifact",
      assetId: "art_missing",
    });

    const result = detachTagFromSelector({
      slug: "orphan.cleanup",
      selector: { artifact: "art_missing" },
    });

    expect(result.removed).toBe(true);
    expect(dbFindTagBindings({ slug: "orphan.cleanup" })).toHaveLength(0);
  });
});
