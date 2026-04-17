import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultModelForProvider, listRuntimeModels, resolvePreferredRuntimeModel } from "./model-catalog.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("model catalog", () => {
  test("parses visible codex models sorted by priority", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-codex-models-"));
    tempDirs.push(dir);
    const cachePath = join(dir, "models_cache.json");

    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.3-codex",
            display_name: "gpt-5.3-codex",
            description: "Coding",
            visibility: "list",
            priority: 2,
          },
          { slug: "gpt-5.4", display_name: "gpt-5.4", description: "Latest", visibility: "list", priority: 0 },
          { slug: "hidden", display_name: "hidden", description: "Hidden", visibility: "hidden", priority: 1 },
        ],
      }),
    );

    const models = listRuntimeModels("codex", { codexCachePath: cachePath });
    expect(models.map((model) => model.id)).toEqual(["gpt-5.4", "gpt-5.3-codex"]);
    expect(getDefaultModelForProvider("codex", { codexCachePath: cachePath })).toBe("gpt-5.4");
  });

  test("normalizes full claude ids to aliases", () => {
    expect(resolvePreferredRuntimeModel("claude", "claude-opus-4-6")).toBe("opus");
    expect(resolvePreferredRuntimeModel("claude", "claude-sonnet-4-6")).toBe("sonnet");
  });

  test("falls back to provider default when model is incompatible", () => {
    const dir = mkdtempSync(join(tmpdir(), "ravi-codex-models-"));
    tempDirs.push(dir);
    const cachePath = join(dir, "models_cache.json");

    writeFileSync(
      cachePath,
      JSON.stringify({
        models: [{ slug: "gpt-5.2-codex", display_name: "gpt-5.2-codex", visibility: "list", priority: 0 }],
      }),
    );

    expect(resolvePreferredRuntimeModel("codex", "sonnet", { codexCachePath: cachePath })).toBe("gpt-5.2-codex");
  });
});
