import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInternalPluginsArtifact } from "./internal-loader.js";

let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe("internal plugin packaging", () => {
  it("embeds repo Ravi Apps in the ravi-system plugin artifact", () => {
    root = mkdtempSync(join(tmpdir(), "ravi-plugin-artifact-"));
    const output = join(root, "internal-plugins.json");
    buildInternalPluginsArtifact(output);

    const artifact = JSON.parse(readFileSync(output, "utf8")) as {
      plugins: Array<{ name: string; files: Array<{ path: string }> }>;
    };
    const system = artifact.plugins.find((plugin) => plugin.name === "ravi-system");
    const paths = system?.files.map((file) => file.path) ?? [];
    const developer = artifact.plugins.find((plugin) => plugin.name === "ravi-dev");
    const developerPaths = developer?.files.map((file) => file.path) ?? [];

    expect(paths).toContain("apps/apps/ravi.app.json");
    expect(paths).toContain("apps/youtube/ravi.app.json");
    expect(developerPaths).toContain("skills/app-creator/SKILL.md");
    expect(developerPaths).toContain("skills/app-creator/references/review-checklist.md");
    expect(developerPaths).toContain("skills/app-creator/references/acceptance-cases.md");
  });
});
