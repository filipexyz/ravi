import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RuntimePlugin } from "../runtime/types.js";
import { syncCodexSkills } from "./codex-skills.js";
import { materializeInternalPluginsSnapshot } from "./index.js";
import type { InternalPlugin } from "./internal-loader.js";

const tempRoots = new Set<string>();

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots.clear();
});

describe("internal plugin snapshots", () => {
  it("keeps an older snapshot readable after publishing changed plugin content", () => {
    const root = makeTempRoot();
    const cacheDir = join(root, "cache");
    const firstSnapshot = materializeInternalPluginsSnapshot([createInternalPlugin("first")], { cacheDir });
    const secondSnapshot = materializeInternalPluginsSnapshot([createInternalPlugin("second")], { cacheDir });

    expect(secondSnapshot).not.toBe(firstSnapshot);
    expect(basename(firstPluginPath(firstSnapshot))).toBe("ravi-system");
    expect(readFileSync(join(firstSnapshot, "ravi-system", "skills", "slack", "SKILL.md"), "utf8")).toContain("first");
    expect(readFileSync(join(secondSnapshot, "ravi-system", "skills", "slack", "SKILL.md"), "utf8")).toContain(
      "second",
    );

    const firstPlugin: RuntimePlugin = {
      type: "local",
      path: firstPluginPath(firstSnapshot),
    };
    const synced = syncCodexSkills([firstPlugin], {
      codexSkillsDir: join(root, "codex", "skills"),
      manifestPath: join(root, "codex", "manifest.json"),
    });

    expect(synced).toEqual(["ravi-system-slack"]);
  });

  it("stays readable while a legacy process replaces the flat cache path", () => {
    const root = makeTempRoot();
    const cacheDir = join(root, "cache");
    const snapshotDir = materializeInternalPluginsSnapshot([createInternalPlugin("snapshot")], { cacheDir });
    const snapshotSkill = join(snapshotDir, "ravi-system", "skills", "slack", "SKILL.md");
    const legacyPluginDir = join(cacheDir, "ravi-system");

    mkdirSync(join(legacyPluginDir, "skills", "slack"), { recursive: true });
    writeFileSync(join(legacyPluginDir, "skills", "slack", "SKILL.md"), "legacy-before");
    rmSync(legacyPluginDir, { recursive: true, force: true });
    mkdirSync(join(legacyPluginDir, "skills", "slack"), { recursive: true });
    writeFileSync(join(legacyPluginDir, "skills", "slack", "SKILL.md"), "legacy-after");

    expect(readFileSync(snapshotSkill, "utf8")).toContain("snapshot");
  });

  it("does not accept or publish over an incomplete snapshot", () => {
    const root = makeTempRoot();
    const cacheDir = join(root, "cache");
    const plugins = [createInternalPlugin("partial")];
    const snapshotDir = materializeInternalPluginsSnapshot(plugins, { cacheDir });

    rmSync(join(snapshotDir, ".complete"));

    expect(() => materializeInternalPluginsSnapshot(plugins, { cacheDir })).toThrow();
    expect(readdirSync(join(cacheDir, ".snapshots")).filter((entry) => entry.startsWith(".staging-"))).toEqual([]);
  });

  it("rejects an internal plugin without its on-disk manifest", () => {
    const root = makeTempRoot();
    const plugin = createInternalPlugin("missing-manifest");
    plugin.files = plugin.files.filter((file) => file.path !== ".claude-plugin/plugin.json");

    expect(() => materializeInternalPluginsSnapshot([plugin], { cacheDir: join(root, "cache") })).toThrow(
      "missing .claude-plugin/plugin.json",
    );
  });

  it("publishes one complete snapshot when multiple Bun processes extract concurrently", async () => {
    const root = makeTempRoot();
    const cacheDir = join(root, "cache");
    const indexModule = new URL("./index.ts", import.meta.url).href;
    const loaderModule = new URL("./internal-loader.ts", import.meta.url).href;
    const script = [
      `const { materializeInternalPluginsSnapshot } = await import(${JSON.stringify(indexModule)});`,
      `const { loadInternalPlugins } = await import(${JSON.stringify(loaderModule)});`,
      "const snapshot = materializeInternalPluginsSnapshot(loadInternalPlugins(), { cacheDir: process.env.RAVI_TEST_PLUGIN_CACHE });",
      "process.stdout.write(snapshot);",
    ].join("\n");

    const snapshots = await Promise.all(Array.from({ length: 6 }, () => runBunMaterializer(script, cacheDir)));

    expect(new Set(snapshots).size).toBe(1);
    const snapshotDir = snapshots[0];
    expect(snapshotDir).toBeDefined();
    expect(snapshotDir).toContain(join(cacheDir, ".snapshots"));
    expect(existsSync(join(snapshotDir as string, ".complete"))).toBe(true);
    expect(existsSync(join(snapshotDir as string, "ravi-system", "skills", "slack", "SKILL.md"))).toBe(true);
    expect(readdirSync(join(cacheDir, ".snapshots")).filter((entry) => entry.startsWith(".staging-"))).toEqual([]);
  }, 20_000);
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-plugin-snapshot-"));
  tempRoots.add(root);
  return root;
}

function createInternalPlugin(label: string): InternalPlugin {
  return {
    name: "ravi-system",
    manifest: { name: "ravi-system" },
    files: [
      {
        path: ".claude-plugin/plugin.json",
        content: JSON.stringify({ name: "ravi-system" }),
      },
      {
        path: "skills/slack/SKILL.md",
        content: `---\nname: slack\ndescription: ${label}\n---\n`,
      },
    ],
  };
}

function firstPluginPath(snapshotDir: string): string {
  return join(snapshotDir, "ravi-system");
}

function runBunMaterializer(script: string, cacheDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", script], {
      env: {
        ...process.env,
        RAVI_LOG_LEVEL: "error",
        RAVI_TEST_PLUGIN_CACHE: cacheDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(`snapshot materializer exited ${code}: ${stderr.trim()}`));
    });
  });
}
