import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAppManifests, getAppManifest } from "../service.js";

const repoRoot = join(import.meta.dir, "../../..");

describe("YouTube Ravi App manifest", () => {
  it("is discoverable and valid from the repository root", () => {
    const [check] = checkAppManifests("youtube", {
      cwd: repoRoot,
      env: { ...process.env, RAVI_STATE_DIR: join(repoRoot, ".test-state") },
    });
    expect(check?.ok).toBe(true);
    expect(check?.errors).toEqual([]);

    const app = getAppManifest("youtube", {
      cwd: repoRoot,
      env: { ...process.env, RAVI_STATE_DIR: join(repoRoot, ".test-state") },
    });
    expect(app.source).toBe("repo");
    expect(app.interfaceNames).toEqual(["cli", "ui"]);
    expect(app.permissions.optional).toEqual(["youtube:read", "youtube:analytics:read", "youtube:captions:read"]);
    expect(app.permissions.mutating).toEqual([
      "youtube:comments:write",
      "youtube:videos:write",
      "youtube:videos:delete",
      "youtube:playlists:write",
      "youtube:playlists:delete",
    ]);
  });

  it("separates read, write, destructive and financial operation classes", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "ravi.app.json"), "utf8")) as {
      operations: Record<string, { mutating: boolean; permission?: string; command?: string }>;
      operationClasses: Record<string, string[]>;
      storage: { sqlite: unknown[]; files: unknown[] };
      events: { emits: unknown[]; consumes: unknown[] };
    };

    expect(manifest.operationClasses.read).toContain("youtube.info");
    expect(manifest.operationClasses.analyticsRead).toContain("youtube.analytics-overview");
    expect(manifest.operationClasses.write).toContain("youtube.reply");
    expect(manifest.operationClasses.destructive).toContain("youtube.video-delete");
    expect(manifest.operationClasses.financial).toEqual([]);

    for (const operationId of manifest.operationClasses.write) {
      expect(manifest.operations[operationId]?.mutating).toBe(true);
      expect(manifest.operations[operationId]?.permission).toMatch(/:write$/);
    }
    for (const operationId of manifest.operationClasses.destructive) {
      expect(manifest.operations[operationId]?.mutating).toBe(true);
      expect(manifest.operations[operationId]?.permission).toMatch(/:delete$/);
    }
    for (const operation of Object.values(manifest.operations)) {
      if (operation.command) expect(operation.command).toContain("--json");
    }

    expect(manifest.storage).toEqual({ sqlite: [], files: [] });
    expect(manifest.events).toEqual({ emits: [], consumes: [] });
  });
});
