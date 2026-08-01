import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runWithContext } from "../context.js";
import { getCommandsMetadata } from "../decorators.js";
import { cleanupIsolatedRaviState } from "../../test/ravi-state.js";
import { evaluateRaviAppsContract } from "../../apps/contract-eval.js";
import { RAVI_APPS_COMMAND_GUIDANCE } from "../../apps/guide.js";
import { AppsCommands } from "./apps.js";
import type { ContextCapability, ContextRecord } from "../../router/router-db.js";

const tempRoots: string[] = [];
const tempStateDirs: string[] = [];
const originalCwd = process.cwd();
const originalHome = process.env.HOME;
const originalStateDir = process.env.RAVI_STATE_DIR;
const contextEnvKeys = ["RAVI_CONTEXT_KEY", "RAVI_SESSION_KEY", "RAVI_SESSION_NAME", "RAVI_AGENT_ID"] as const;
const originalContextEnv = new Map<(typeof contextEnvKeys)[number], string | undefined>(
  contextEnvKeys.map((key) => [key, process.env[key]]),
);
const appsContractFiles = [
  "src/plugins/internal/ravi-system/skills/apps/SKILL.md",
  "src/plugins/internal/ravi-dev/skills/app-creator/SKILL.md",
  "src/plugins/internal/ravi-dev/skills/app-creator/references/acceptance-cases.md",
  ".ravi/specs/apps/SPEC.md",
  ".ravi/specs/apps/builder/SPEC.md",
] as const;

function makeAppsContractFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-apps-contract-"));
  tempRoots.push(root);
  restoreAppsContractFixture(root);
  return root;
}

function restoreAppsContractFixture(root: string): void {
  for (const relativePath of appsContractFiles) {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(originalCwd, relativePath), "utf8"));
  }
}

function removeContractText(root: string, relativePath: (typeof appsContractFiles)[number], text: string): void {
  const path = join(root, relativePath);
  const content = readFileSync(path, "utf8");
  expect(content).toContain(text);
  writeFileSync(path, content.replaceAll(text, "removed-by-contract-drift-test"));
}

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-apps-cli-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src", "apps", "apps"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
  process.env.HOME = join(root, ".home");
  process.env.RAVI_STATE_DIR = join(root, ".state");
  tempStateDirs.push(process.env.RAVI_STATE_DIR);
  for (const key of contextEnvKeys) {
    delete process.env[key];
  }
  writeFileSync(
    join(root, "src", "apps", "apps", "ravi.app.json"),
    JSON.stringify(
      {
        schema: "ravi.app/v1",
        id: "apps",
        name: "Ravi Apps",
        version: "0.1.0",
        description: "Discover and validate app manifests.",
        interfaces: {
          cli: {
            command: "ravi apps",
            json: true,
          },
          sdk: {
            namespace: "apps",
          },
        },
        context: {
          allow: [],
        },
        permissions: {
          required: [],
          optional: [],
          mutating: [],
        },
        health: {
          checks: [],
        },
      },
      null,
      2,
    ),
  );
  process.chdir(root);
  return root;
}

function captureJson(fn: () => unknown): unknown {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    fn();
    return JSON.parse(logs.join("\n"));
  } finally {
    console.log = originalLog;
  }
}

function contextWithCapabilities(capabilities: ContextCapability[]): ContextRecord {
  return {
    kind: "test-runtime",
    agentId: "app-agent",
    capabilities,
  } as ContextRecord;
}

async function captureJsonAsync(fn: () => Promise<unknown>): Promise<unknown> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (value?: unknown) => {
    if (typeof value === "string") logs.push(value);
  };
  try {
    await fn();
    return JSON.parse(logs.join("\n"));
  } finally {
    console.log = originalLog;
  }
}

afterEach(async () => {
  process.chdir(originalCwd);
  while (tempStateDirs.length > 0) {
    await cleanupIsolatedRaviState(tempStateDirs.pop());
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateDir === undefined) delete process.env.RAVI_STATE_DIR;
  else process.env.RAVI_STATE_DIR = originalStateDir;
  for (const key of contextEnvKeys) {
    const value = originalContextEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe("AppsCommands", () => {
  it("evaluates registry, guide, specs, and skills as one drift-sensitive contract", () => {
    const registryCommands = getCommandsMetadata(AppsCommands).map((command) => command.name);
    const result = evaluateRaviAppsContract(registryCommands, { cwd: originalCwd });

    expect(result.ok).toBe(true);
    expect(result.drift).toEqual([]);
    expect(result.registryCommands).toEqual(result.documentedCommands);

    const driftedGuidance = RAVI_APPS_COMMAND_GUIDANCE.filter((entry) => entry.command !== "show");
    const drifted = evaluateRaviAppsContract(registryCommands, {
      cwd: originalCwd,
      guidance: driftedGuidance,
    });

    expect(drifted.ok).toBe(false);
    expect(drifted.drift).toContainEqual(
      expect.objectContaining({
        surface: "guide",
        code: "registry_command_missing_guidance",
      }),
    );
  });

  it("detects command, builder-link, and acceptance-case drift outside the guide", () => {
    const registryCommands = getCommandsMetadata(AppsCommands).map((command) => command.name);
    const fixture = makeAppsContractFixture();

    removeContractText(fixture, "src/plugins/internal/ravi-system/skills/apps/SKILL.md", "ravi apps show");
    expect(evaluateRaviAppsContract(registryCommands, { cwd: fixture }).drift).toContainEqual(
      expect.objectContaining({ surface: "system-skill", code: "command_missing" }),
    );

    restoreAppsContractFixture(fixture);
    removeContractText(fixture, ".ravi/specs/apps/SPEC.md", "ravi apps show");
    expect(evaluateRaviAppsContract(registryCommands, { cwd: fixture }).drift).toContainEqual(
      expect.objectContaining({ surface: "apps-spec", code: "command_missing" }),
    );

    restoreAppsContractFixture(fixture);
    removeContractText(fixture, ".ravi/specs/apps/builder/SPEC.md", "ravi-dev-app-creator");
    expect(evaluateRaviAppsContract(registryCommands, { cwd: fixture }).drift).toContainEqual(
      expect.objectContaining({
        surface: "builder-spec",
        code: "builder_skill_link_missing",
      }),
    );

    restoreAppsContractFixture(fixture);
    removeContractText(
      fixture,
      "src/plugins/internal/ravi-dev/skills/app-creator/references/acceptance-cases.md",
      "Open-Meteo Forecast",
    );
    expect(evaluateRaviAppsContract(registryCommands, { cwd: fixture }).drift).toContainEqual(
      expect.objectContaining({
        surface: "acceptance-cases",
        code: "second_reference_case_missing",
      }),
    );
  });

  it("lists, shows, and checks app manifests as JSON", () => {
    makeRepo();
    const commands = new AppsCommands();

    const list = captureJson(() => commands.list(undefined, true)) as {
      total: number;
      apps: Array<{ id: string; valid: boolean; interfaceNames: string[] }>;
    };
    expect(list.total).toBe(1);
    expect(list.apps[0]).toMatchObject({ id: "apps", valid: true, interfaceNames: ["cli", "sdk"] });

    const show = captureJson(() => commands.show("apps", true)) as {
      app: { id: string; manifest: { schema: string } };
    };
    expect(show.app.id).toBe("apps");
    expect(show.app.manifest.schema).toBe("ravi.app/v1");

    const check = captureJson(() => commands.check("apps", true)) as {
      ok: boolean;
      checked: number;
      results: Array<{ id: string; ok: boolean }>;
    };
    expect(check).toMatchObject({ ok: true, checked: 1 });
    expect(check.results[0]).toMatchObject({ id: "apps", ok: true });
  });

  it("filters app discovery by app use permission in agent context", () => {
    makeRepo();
    const commands = new AppsCommands();

    const hiddenList = runWithContext({ agentId: "app-agent" }, () =>
      captureJson(() => commands.list(undefined, true)),
    ) as {
      total: number;
      apps: Array<{ id: string }>;
    };
    expect(hiddenList.total).toBe(0);
    expect(hiddenList.apps).toEqual([]);

    expect(() =>
      runWithContext({ agentId: "app-agent" }, () => captureJson(() => commands.show("apps", true))),
    ).toThrow(/App not found: apps/);

    const appContext = contextWithCapabilities([
      { permission: "use", objectType: "app", objectId: "apps", source: "test" },
    ]);

    const visibleList = runWithContext({ agentId: "app-agent", context: appContext }, () =>
      captureJson(() => commands.list(undefined, true)),
    ) as {
      total: number;
      apps: Array<{ id: string }>;
    };
    expect(visibleList.total).toBe(1);
    expect(visibleList.apps.map((app) => app.id)).toEqual(["apps"]);

    const visibleCheck = runWithContext({ agentId: "app-agent", context: appContext }, () =>
      captureJson(() => commands.check(undefined, true)),
    ) as {
      checked: number;
      results: Array<{ id: string }>;
    };
    expect(visibleCheck.checked).toBe(1);
    expect(visibleCheck.results.map((result) => result.id)).toEqual(["apps"]);
  });

  it("prints guide and app-specific prompts as JSON", () => {
    makeRepo();
    const commands = new AppsCommands();

    const guide = captureJson(() => commands.guide(undefined, true)) as {
      skill: string;
      skillGate: { group: string; skill: string };
      builder: { skill: string; spec: string; reviewChecklist: string[] };
      prompts: Array<{ id: string; commands: string[] }>;
    };

    expect(guide.skill).toBe("ravi-system-apps");
    expect(guide.skillGate).toEqual({ group: "apps", skill: "ravi-system-apps" });
    expect(guide.builder).toMatchObject({
      skill: "ravi-dev-app-creator",
      spec: "apps/builder",
    });
    expect(guide.builder.reviewChecklist.length).toBeGreaterThan(5);
    expect(guide.prompts.map((prompt) => prompt.id)).toContain("build");
    expect(guide.prompts.find((prompt) => prompt.id === "operate")?.commands).toContain(
      "ravi <app-id> <operation> --json",
    );
    expect(guide.prompts.find((prompt) => prompt.id === "skill-gate")?.commands).toContain(
      "ravi skills show ravi-system-apps --json",
    );

    const prompts = captureJson(() => commands.prompts("apps", true)) as {
      appId: string;
      app: { id: string };
      prompts: Array<{ id: string; prompt: string }>;
    };

    expect(prompts.appId).toBe("apps");
    expect(prompts.app.id).toBe("apps");
    expect(prompts.prompts.find((prompt) => prompt.id === "selected-app")?.prompt).toContain("Selected app: apps.");
  });

  it("scaffolds a valid app manifest, spec, and skill", () => {
    const root = makeRepo();
    const commands = new AppsCommands();

    const dryRun = captureJson(() =>
      commands.scaffold(
        "music",
        "Music",
        "Manage music.",
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ) as {
      dryRun: boolean;
      manifestPath: string;
      files: Array<{ kind: string; action: string }>;
    };

    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.files.every((file) => file.action === "planned")).toBe(true);
    expect(existsSync(dryRun.manifestPath)).toBe(false);

    const created = captureJson(() =>
      commands.scaffold(
        "music",
        "Music",
        "Manage music.",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ) as {
      id: string;
      cliPath: string;
      manifestPath: string;
      specPath: string;
      skillPath: string;
      skill: string;
      files: Array<{ kind: string; action: string }>;
      manifest: {
        context: { allow: string[] };
        operations: Record<string, unknown>;
        interfaces: Record<string, { command?: string }>;
      };
      builder: { skill: string; spec: string; reviewChecklist: string[] };
      nextCommands: string[];
    };

    expect(created.id).toBe("music");
    expect(created.skill).toBe("ravi-system-music");
    expect(created.files.map((file) => file.action)).toEqual(["created", "created", "created", "created"]);
    expect(Object.hasOwn(created.manifest.operations, "music.list")).toBe(true);
    expect(created.manifest.operations["music.list"]).toMatchObject({
      interface: "cli",
      command: "bun cli.ts list {args} --json",
    });
    expect(created.manifest.operations["music.check"]).toMatchObject({
      interface: "builtin",
      handler: "apps.manifest.check",
    });
    expect(created.manifest.interfaces.cli).toMatchObject({ command: "bun cli.ts", json: true });
    expect(created.manifest.context.allow).toEqual([]);
    expect(created.builder).toMatchObject({
      skill: "ravi-dev-app-creator",
      spec: "apps/builder",
    });
    expect(created.builder.reviewChecklist.length).toBeGreaterThan(5);
    expect(created.manifest.interfaces).toHaveProperty("ui");
    expect(existsSync(created.cliPath)).toBe(true);
    expect(readFileSync(created.cliPath, "utf8")).toContain("RAVI_CONTEXT_KEY");
    expect(readFileSync(created.cliPath, "utf8")).toContain("execute:group:<group>");
    expect(existsSync(created.manifestPath)).toBe(true);
    expect(existsSync(created.specPath)).toBe(true);
    expect(existsSync(created.skillPath)).toBe(true);
    expect(readFileSync(created.skillPath, "utf8")).toContain("ravi apps show music --json");
    expect(readFileSync(created.skillPath, "utf8")).toContain("ravi music check --json");
    expect(created.nextCommands).toContain("ravi apps guide music --json");
    expect(created.nextCommands).toContain("ravi skills show ravi-dev-app-creator --json");
    expect(created.nextCommands).toContain("ravi music check --json");
    expect(created.nextCommands).toContain("ravi music list --json");
    expect(created.nextCommands.some((command) => command.includes("ravi skills show music --source "))).toBe(true);
    expect(created.nextCommands).not.toContain("ravi skills show ravi-system-music --json");

    const manifest = JSON.parse(readFileSync(join(root, "src", "apps", "music", "ravi.app.json"), "utf8")) as {
      id: string;
      skills: string[];
    };
    expect(manifest).toMatchObject({ id: "music", skills: ["ravi-system-music"] });

    const check = captureJson(() => commands.check("music", true)) as {
      ok: boolean;
      results: Array<{ id: string; ok: boolean; errors: string[] }>;
    };
    expect(check.ok).toBe(true);
    expect(check.results[0]).toMatchObject({ id: "music", ok: true, errors: [] });

    const authoredCli = "// Authored implementation: scaffold must preserve this file.\n";
    writeFileSync(created.cliPath, authoredCli, "utf8");
    const forced = captureJson(() =>
      commands.scaffold(
        "music",
        "Music",
        "Manage music.",
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ) as {
      files: Array<{ kind: string; action: string }>;
    };
    expect(forced.files).toEqual([
      expect.objectContaining({ kind: "manifest", action: "overwritten" }),
      expect.objectContaining({ kind: "cli", action: "preserved" }),
      expect.objectContaining({ kind: "spec", action: "overwritten" }),
      expect.objectContaining({ kind: "skill", action: "overwritten" }),
    ]);
    expect(readFileSync(created.cliPath, "utf8")).toBe(authoredCli);

    const nested = captureJson(() =>
      commands.scaffold(
        "console/control",
        "Console Control",
        "Operate Console control surfaces.",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ) as {
      id: string;
      manifestPath: string;
      skill: string;
    };
    expect(nested.id).toBe("console/control");
    expect(nested.skill).toBe("ravi-system-console-control");
    expect(existsSync(nested.manifestPath)).toBe(true);

    const nestedCheck = captureJson(() => commands.check("console/control", true)) as {
      ok: boolean;
      results: Array<{ id: string; ok: boolean; errors: string[]; warnings: string[] }>;
    };
    expect(nestedCheck.ok).toBe(true);
    expect(nestedCheck.results[0]).toMatchObject({ id: "console/control", ok: true, errors: [] });
    expect(nestedCheck.results[0]?.warnings).not.toContain(
      'Manifest id "console/control" does not match path-derived id "control".',
    );

    const existingDryRun = captureJson(() =>
      commands.scaffold(
        "music",
        "Music",
        "Manage music.",
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ) as {
      dryRun: boolean;
      files: Array<{ action: string }>;
    };
    expect(existingDryRun.dryRun).toBe(true);
    expect(existingDryRun.files.every((file) => file.action === "planned")).toBe(true);
  });

  it("imports an external self-describing CLI as a draft app", () => {
    const root = makeRepo();
    const commands = new AppsCommands();
    const fakeCli = join(root, "fake-cli");
    writeFileSync(
      fakeCli,
      `#!/usr/bin/env bash
if [ "$1" = "manifest" ] && [ "$2" = "--json" ]; then
cat <<'JSON'
{
  "name": "Fake CLI",
  "description": "A fake self-describing CLI.",
  "command": "__FAKE_CLI__",
  "commands": [
    {
      "name": "list",
      "description": "List records",
      "command": "__FAKE_CLI__ list --json {args}",
      "json": true,
      "mutating": false
    },
    {
      "name": "delete",
      "description": "Delete a record",
      "command": "__FAKE_CLI__ delete --json {args}",
      "json": true,
      "mutating": true,
      "destructive": true
    },
    {
      "name": "watch",
      "description": "Watch records",
      "command": "__FAKE_CLI__ watch",
      "json": false,
      "streaming": true
    }
  ]
}
JSON
exit 0
fi
echo "unexpected invocation" >&2
exit 1
`.replace(/__FAKE_CLI__/g, fakeCli),
    );
    chmodSync(fakeCli, 0o755);

    const dryRun = captureJson(() =>
      commands.importCli(
        fakeCli,
        "fake-app",
        undefined,
        undefined,
        "manifest",
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ) as {
      id: string;
      source: string;
      confidence: string;
      manifestPath: string;
      operationCandidates: Array<{ id: string; mutating: boolean; destructive: boolean }>;
      debugCandidates: Array<{ id: string }>;
      manifest: {
        context: { allow: string[] };
        interfaces: Record<string, { command?: string }>;
        operations: Record<string, { interface: string; command?: string; permission?: string }>;
      };
      reviewRequired: string[];
      sourceCommand: string;
      command: string;
      builder: {
        skill: string;
        command: string;
        spec: string;
        reviewChecklist: string[];
      };
    };

    expect(dryRun).toMatchObject({ id: "fake-app", source: "manifest", confidence: "high" });
    expect(dryRun.sourceCommand).toBe(fakeCli);
    expect(dryRun.command).toBe(fakeCli);
    expect(dryRun.manifest.interfaces.cli).toMatchObject({
      command: fakeCli,
    });
    expect(dryRun.manifest.context.allow).toEqual([]);
    expect(dryRun.operationCandidates.map((candidate) => candidate.id)).toEqual(["list", "delete"]);
    expect(dryRun.debugCandidates.map((candidate) => candidate.id)).toEqual(["watch"]);
    expect(dryRun.manifest.operations["fake-app.list"]).toMatchObject({
      interface: "cli",
      command: `${fakeCli} list --json {args}`,
    });
    expect(dryRun.manifest.operations["fake-app.delete"]).toMatchObject({
      interface: "cli",
      permission: "fake-app:write",
    });
    expect(dryRun.reviewRequired.join("\n")).toContain("Confirm mutation risk");
    expect(dryRun.reviewRequired[0]).toContain("draft generator");
    expect(dryRun.builder).toMatchObject({
      skill: "ravi-dev-app-creator",
      command: "ravi skills show ravi-dev-app-creator --json",
      spec: "apps/builder",
    });
    expect(dryRun.builder.reviewChecklist.length).toBeGreaterThan(5);
    expect(existsSync(dryRun.manifestPath)).toBe(false);

    const created = captureJson(() =>
      commands.importCli(
        fakeCli,
        "fake-app",
        undefined,
        undefined,
        "manifest",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    ) as {
      manifestPath: string;
      files: Array<{ action: string }>;
      builder: { skill: string; spec: string; reviewChecklist: string[] };
    };

    expect(created.files.map((file) => file.action)).toEqual(["created", "created", "created"]);
    expect(created.builder).toMatchObject({
      skill: "ravi-dev-app-creator",
      spec: "apps/builder",
    });
    expect(created.builder.reviewChecklist.length).toBeGreaterThan(5);
    expect(existsSync(created.manifestPath)).toBe(true);

    const check = captureJson(() => commands.check("fake-app", true)) as {
      ok: boolean;
      results: Array<{ id: string; errors: string[] }>;
    };
    expect(check.ok).toBe(true);
    expect(check.results[0]).toMatchObject({ id: "fake-app", errors: [] });
  });

  it("imports first-party Ravi CLI groups from the decorated registry", () => {
    makeRepo();
    const commands = new AppsCommands();

    const imported = captureJson(() =>
      commands.importCli(
        "ravi apps",
        "imported-apps",
        undefined,
        undefined,
        "registry",
        true,
        undefined,
        true,
        true,
        true,
        true,
      ),
    ) as {
      source: string;
      confidence: string;
      operationCandidates: Array<{ id: string; command: string }>;
      manifest: {
        context: { allow: string[] };
        operations: Record<string, { command?: string }>;
      };
      files: Array<{ kind: string; path: string; action: string }>;
      reviewRequired: string[];
      warnings: string[];
    };

    expect(imported).toMatchObject({ source: "registry", confidence: "medium" });
    expect(imported.files).toEqual([{ kind: "manifest", path: expect.any(String), action: "planned" }]);
    expect(imported.operationCandidates.map((candidate) => candidate.id)).toContain("list");
    expect(imported.manifest.operations["imported-apps.list"]).toMatchObject({
      command: "ravi apps list {args} --json",
    });
    expect(imported.manifest.context.allow).toEqual(["execute:group:apps"]);
    expect(imported.reviewRequired.join("\n")).toContain("Review inferred child capability execute:group:apps");
    expect(imported.warnings.join("\n")).toContain("assumes generated operations should use --json");
  });

  it("runs scaffolded app operations through the explicit app router command", async () => {
    makeRepo();
    const commands = new AppsCommands();
    captureJson(() =>
      commands.scaffold(
        "music",
        "Music",
        "Manage music.",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );

    const check = (await captureJsonAsync(() => commands.run("music", "check", [], true))) as {
      ok: boolean;
      appId: string;
      operationId: string;
      result: { ok: boolean; checked: number };
    };

    expect(check).toMatchObject({
      ok: true,
      appId: "music",
      operationId: "music.check",
      result: { ok: true, checked: 1 },
    });

    const list = (await captureJsonAsync(() => commands.run("music", "list", ["alpha", "beta"], true))) as {
      ok: boolean;
      appId: string;
      operationId: string;
      interface: string;
      result: { items: unknown[]; total: number; args: string[] };
    };

    expect(list).toMatchObject({
      ok: true,
      appId: "music",
      operationId: "music.list",
      interface: "cli",
      result: { items: [], total: 0, args: ["alpha", "beta"] },
    });
  });
});
