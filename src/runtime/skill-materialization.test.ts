import { describe, expect, test } from "bun:test";
import { spawn } from "bun";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { materializeSkillSnapshot } from "./skill-materialization.js";
import type { SkillCatalogEntry, SkillPolicySnapshot } from "./skill-policy.js";

function fixture(): { root: string; plugin: string; cache: string } {
  const root = mkdtempSync(join(tmpdir(), "ravi-skill-materialization-"));
  const plugin = join(root, "personal-plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "example", hooks: "./hooks" }));
  writeFileSync(join(plugin, ".mcp.json"), '{"mcpServers":{"private":{}}}');
  mkdirSync(join(plugin, "hooks"));
  writeFileSync(join(plugin, "hooks", "hook.sh"), "private hook");
  return { root, plugin, cache: join(root, "materializations") };
}

function skill(plugin: string, name: string): SkillCatalogEntry {
  const path = join(plugin, "skills", name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: ${name} instructions\n---\nUse ${name}.\n`);
  return {
    id: `example:${name}`,
    aliases: [name, `example-${name}`],
    name,
    description: `${name} instructions`,
    resource: { path, pluginPath: plugin },
  };
}

function snapshot(skills: readonly SkillCatalogEntry[], agentId = "restricted"): SkillPolicySnapshot {
  return {
    contractVersion: 1,
    id: `snapshot-${agentId}`,
    status: skills.length ? "ready" : "empty",
    scope: { agentId, executionId: "turn-1", contextKey: `agent:${agentId}:main` },
    revisions: { policy: "p1", catalog: "c1", permissions: "a1", toolSurface: "t1" },
    skills,
    provenance: {},
    diagnostics: [],
  };
}

function filesUnder(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("materializeSkillSnapshot", () => {
  test("does not persist the runtime context bearer credential in materialized metadata", () => {
    const { plugin, cache } = fixture();
    const original = snapshot([skill(plugin, "allowed")]);
    const contextKey = "rctx_materialization-private-bearer";
    const result = materializeSkillSnapshot({ ...original, scope: { ...original.scope, contextKey } }, cache);
    const manifest = readFileSync(join(result.root, ".ravi-skill-snapshot.json"), "utf8");
    expect(manifest.includes(contextKey)).toBe(false);
  });
  test("exposes only the selected skill with its resources, aliases and executable script", () => {
    const { plugin, cache } = fixture();
    const allowed = skill(plugin, "allowed");
    const denied = skill(plugin, "denied");
    const resourceRoot = dirname(allowed.resource.path);
    mkdirSync(join(resourceRoot, "scripts"));
    mkdirSync(join(resourceRoot, "references"));
    writeFileSync(join(resourceRoot, "scripts", "run.sh"), "#!/bin/sh\nprintf allowed\n", { mode: 0o755 });
    writeFileSync(join(resourceRoot, "references", "data.bin"), Buffer.from([0, 255, 128, 65]));

    const result = materializeSkillSnapshot(snapshot([allowed]), cache);
    const path = result.skillPaths[allowed.id];
    expect(result.snapshotId).toBe("snapshot-restricted");
    expect(result.plugins).toHaveLength(1);
    expect(result.skillPaths.allowed).toBe(path);
    expect(result.skillPaths["example-allowed"]).toBe(path);
    expect(result.nativeNames).toEqual({ "example:allowed": "example:allowed" });
    expect(readFileSync(path, "utf8")).toBe(readFileSync(allowed.resource.path, "utf8"));
    expect(readFileSync(join(dirname(path), "references", "data.bin"))).toEqual(Buffer.from([0, 255, 128, 65]));
    expect(readFileSync(join(dirname(path), "scripts", "run.sh"), "utf8")).toContain("printf allowed");
    const exposedSkills = filesUnder(result.root).filter((file) => file.endsWith("SKILL.md"));
    expect(exposedSkills).toEqual([path]);
    for (const prepared of result.plugins) {
      expect(existsSync(join(prepared.path, "hooks"))).toBe(false);
      expect(existsSync(join(prepared.path, ".mcp.json"))).toBe(false);
      const manifest = JSON.parse(readFileSync(join(prepared.path, ".claude-plugin", "plugin.json"), "utf8"));
      expect(Object.keys(manifest).sort()).toEqual(["name"]);
    }
    expect(readFileSync(denied.resource.path, "utf8")).toContain("Use denied.");
    expect(readFileSync(join(plugin, "hooks", "hook.sh"), "utf8")).toBe("private hook");
  });

  test("keeps an explicit empty snapshot empty without changing a broad materialization", () => {
    const { plugin, cache } = fixture();
    const allowed = skill(plugin, "allowed");
    const broad = materializeSkillSnapshot(snapshot([allowed], "admin"), cache);
    const empty = materializeSkillSnapshot(snapshot([]), cache);
    expect(empty.plugins).toEqual([]);
    expect(Object.keys(empty.skillPaths)).toEqual([]);
    expect(filesUnder(empty.root).filter((file) => file.endsWith("SKILL.md"))).toEqual([]);
    expect(readFileSync(broad.skillPaths[allowed.id], "utf8")).toContain("Use allowed.");
    expect(empty.root).not.toBe(broad.root);
  });

  test("keys immutable materializations by scope and every policy revision", () => {
    const { plugin, cache } = fixture();
    const first = snapshot([skill(plugin, "allowed")]);
    const original = materializeSkillSnapshot(first, cache);
    expect(materializeSkillSnapshot(first, cache)).toEqual(original);
    const variants: SkillPolicySnapshot[] = [
      { ...first, scope: { ...first.scope, executionId: "turn-2" } },
      { ...first, scope: { ...first.scope, contextKey: "other-context" } },
      ...["policy", "catalog", "permissions", "toolSurface"].map((key) => ({
        ...first,
        revisions: { ...first.revisions, [key]: "next" },
      })),
    ];
    for (const changed of variants) {
      expect(materializeSkillSnapshot(changed, cache).root).not.toBe(original.root);
    }
  });

  test("materializes packaged files even when the original skill is not on disk", () => {
    const { root, cache } = fixture();
    const packaged: SkillCatalogEntry = {
      id: "built-in:packaged",
      aliases: ["packaged"],
      name: "packaged",
      description: "Packaged instructions",
      resource: {
        path: join(root, "missing", "SKILL.md"),
        files: [
          { path: "SKILL.md", content: "---\nname: packaged\n---\nRead references/note.md\n" },
          { path: "references/note.md", content: "Bundled reference" },
        ],
      },
    };
    const result = materializeSkillSnapshot(snapshot([packaged]), cache);
    expect(readFileSync(join(dirname(result.skillPaths[packaged.id]), "references", "note.md"), "utf8")).toBe(
      "Bundled reference",
    );
  });

  test.each(["../outside.md", "..\\outside.md", "/outside.md", "C:\\outside.md", "a/../../outside.md", "x:stream"])(
    "rejects packaged path traversal %s before publication",
    (path) => {
      const { plugin, cache } = fixture();
      const original = skill(plugin, "allowed");
      const unsafe = { ...original, resource: { ...original.resource, files: [{ path, content: "unsafe" }] } };
      expect(() => materializeSkillSnapshot(snapshot([unsafe]), cache)).toThrow();
    },
  );

  test("rejects aliases shared by different skills", () => {
    const { plugin, cache } = fixture();
    const first = skill(plugin, "first");
    const second = { ...skill(plugin, "second"), aliases: ["first"] };
    expect(() => materializeSkillSnapshot(snapshot([first, second]), cache)).toThrow(/identity|alias/i);
  });

  test("rejects source symlinks instead of copying a denied skill through a resource directory", () => {
    const { plugin, cache } = fixture();
    const allowed = skill(plugin, "allowed");
    const denied = skill(plugin, "denied");
    symlinkSync(dirname(denied.resource.path), join(dirname(allowed.resource.path), "references"), "junction");
    expect(() => materializeSkillSnapshot(snapshot([allowed]), cache)).toThrow(/symlink|symbolic/i);
    expect(readFileSync(denied.resource.path, "utf8")).toContain("Use denied.");
  });

  test("does not copy a resource SKILL.md as another implicitly authorized native skill", () => {
    const { plugin, cache } = fixture();
    const allowed = skill(plugin, "allowed");
    const nested = join(dirname(allowed.resource.path), "references", "denied");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "SKILL.md"), "---\nname: denied\n---\nPrivate instructions");
    expect(() => materializeSkillSnapshot(snapshot([allowed]), cache)).toThrow(/nested|unauthorized/i);
  });

  test("does not copy a source outside its declared plugin boundary", () => {
    const { plugin, cache } = fixture();
    const foreign = skill(fixture().plugin, "private");
    const escaped = { ...foreign, resource: { ...foreign.resource, pluginPath: plugin } };
    expect(() => materializeSkillSnapshot(snapshot([escaped]), cache)).toThrow(/outside|boundary/i);
  });

  test("rejects a symlinked output root without writing into personal files", () => {
    const { plugin, cache } = fixture();
    const allowed = skill(plugin, "allowed");
    symlinkSync(plugin, cache, "junction");
    const before = filesUnder(plugin);
    expect(() => materializeSkillSnapshot(snapshot([allowed]), cache)).toThrow(/symlink|symbolic/i);
    expect(filesUnder(plugin)).toEqual(before);
  });

  test("detects changed or newly injected files before reusing a materialization", () => {
    const { plugin, cache } = fixture();
    const allowed = skill(plugin, "allowed");
    const resolved = snapshot([allowed]);
    const result = materializeSkillSnapshot(resolved, cache);
    chmodSync(result.skillPaths[allowed.id], 0o600);
    writeFileSync(result.skillPaths[allowed.id], "tampered");
    expect(() => materializeSkillSnapshot(resolved, cache)).toThrow(/integrity|changed|tamper/i);
    expect(readFileSync(result.skillPaths[allowed.id], "utf8")).toBe("tampered");
  });

  test("rejects a new skill injected into an otherwise valid snapshot directory", () => {
    const { plugin, cache } = fixture();
    const resolved = snapshot([skill(plugin, "allowed")]);
    const result = materializeSkillSnapshot(resolved, cache);
    const injected = join(result.plugins[0].path, "skills", "denied");
    mkdirSync(injected);
    writeFileSync(join(injected, "SKILL.md"), "Injected private instructions");
    expect(() => materializeSkillSnapshot(resolved, cache)).toThrow(/integrity|changed|tamper/i);
  });

  test("publishes concurrent admin and restricted snapshots independently across processes", async () => {
    const { plugin, cache } = fixture();
    const allowed = skill(plugin, "allowed");
    const denied = skill(plugin, "denied");
    const narrow = snapshot([allowed]);
    const wide = snapshot([allowed, denied], "admin");
    const script = `const {materializeSkillSnapshot}=await import(process.argv[1]); console.log(JSON.stringify(materializeSkillSnapshot(JSON.parse(process.argv[2]),process.argv[3])));`;
    const children = [wide, narrow, narrow].map((resolved) =>
      spawn(
        [
          process.execPath,
          "-e",
          script,
          new URL("./skill-materialization.ts", import.meta.url).href,
          JSON.stringify(resolved),
          cache,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    );
    for (const child of children) {
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    }
    const restricted = materializeSkillSnapshot(narrow, cache);
    const admin = materializeSkillSnapshot(wide, cache);
    expect(filesUnder(restricted.root).filter((path) => path.endsWith("SKILL.md"))).toHaveLength(1);
    expect(filesUnder(admin.root).filter((path) => path.endsWith("SKILL.md"))).toHaveLength(2);
    expect(relative(restricted.root, admin.root).startsWith("..")).toBe(true);
  });
});
