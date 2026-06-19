import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAppManifests, discoverAppManifests, getAppManifest } from "./service.js";

const tempRoots: string[] = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.RAVI_STATE_DIR;

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-apps-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src", "apps"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
  process.env.RAVI_STATE_DIR = join(root, ".state");
  process.chdir(root);
  return root;
}

function writeManifest(root: string, id: string, body: Record<string, unknown>): string {
  const dir = join(root, "src", "apps", ...id.split("/"));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ravi.app.json");
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    },
    permissions: {
      required: [],
      optional: [],
      mutating: [],
    },
    health: {
      checks: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalStateDir === undefined) {
    delete process.env.RAVI_STATE_DIR;
  } else {
    process.env.RAVI_STATE_DIR = originalStateDir;
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe("Ravi app manifest service", () => {
  it("discovers and validates repo app manifests", () => {
    const root = makeRepo();
    writeManifest(root, "apps", validManifest());

    const apps = discoverAppManifests();
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      id: "apps",
      name: "Ravi Apps",
      source: "repo",
      valid: true,
      interfaceNames: ["cli"],
    });

    const app = getAppManifest("apps");
    expect(app.path).toEndWith("src/apps/apps/ravi.app.json");
  });

  it("reports duplicate app ids as hard conflicts", () => {
    const root = makeRepo();
    const stateDir = join(root, ".state");
    mkdirSync(join(stateDir, "apps", "apps-copy"), { recursive: true });
    writeManifest(root, "apps", validManifest());
    writeFileSync(join(stateDir, "apps", "apps-copy", "ravi.app.json"), JSON.stringify(validManifest(), null, 2));

    const apps = discoverAppManifests({ env: { ...process.env, RAVI_STATE_DIR: stateDir } });
    const duplicates = apps.filter((app) => app.id === "apps");
    expect(duplicates).toHaveLength(2);
    expect(duplicates.some((app) => app.errors.some((error) => error.includes("Duplicate app id")))).toBe(true);
  });

  it("does not execute declared health commands while checking manifests", () => {
    const root = makeRepo();
    const marker = join(root, "health-ran");
    writeManifest(
      root,
      "apps",
      validManifest({
        health: {
          checks: [{ type: "cli", command: `touch ${marker}` }],
        },
      }),
    );

    const results = checkAppManifests("apps");
    expect(results[0]?.ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects secret-like manifest content", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "apps",
      validManifest({
        authToken: "Bearer abcdefghijklmnopqrstuvwxyz",
      }),
    );

    const app = getAppManifest("apps");
    expect(app.valid).toBe(false);
    expect(app.errors.join("\n")).toContain("credential-like key");
  });

  it("accepts structured storage and event declarations", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "apps",
      validManifest({
        storage: {
          sqlite: [
            {
              id: "state",
              kind: "state",
              path: "$RAVI_STATE_DIR/apps/apps/state.db",
              tables: ["records"],
              migrations: "migrations/sqlite",
              retention: "durable",
            },
          ],
          files: [
            {
              path: "cache",
              kind: "cache",
              retention: "cache",
            },
          ],
        },
        events: {
          emits: [
            {
              topic: "ravi.apps.checked",
              when: "app manifest check completes",
              durability: "logged",
              schema: "events/apps-checked.v1.json",
            },
          ],
          consumes: [
            {
              topic: "ravi.context.updated",
              handler: "ravi apps sync",
              schema: "events/context-updated.v1.json",
              replay: true,
            },
          ],
        },
      }),
    );

    const app = getAppManifest("apps");
    expect(app.valid).toBe(true);
    expect(app.errors).toEqual([]);
  });

  it("accepts semantic UI and operation declarations", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "apps",
      validManifest({
        interfaces: {
          cli: {
            command: "ravi apps",
            json: true,
          },
          ui: {
            routes: [
              {
                id: "main",
                path: "/apps/apps",
                label: "Apps",
                icon: "boxes",
                view: "registry",
              },
            ],
            views: [
              {
                id: "registry",
                type: "table",
                title: "Apps",
                density: "compact",
                query: { operation: "apps.list" },
                refreshOn: ["ravi.apps.changed", "ravi.apps.checked"],
                actions: [
                  {
                    id: "check",
                    label: "Check",
                    icon: "shield-check",
                    operation: "apps.check",
                    placement: "toolbar",
                  },
                ],
              },
            ],
          },
        },
        operations: {
          "apps.list": {
            interface: "cli",
            command: "ravi apps list --json",
            mutating: false,
            outputSchema: "schemas/apps-list.v1.json",
          },
          "apps.check": {
            interface: "cli",
            command: "ravi apps check {id} --json",
            mutating: false,
          },
        },
      }),
    );

    const app = getAppManifest("apps");
    expect(app.valid).toBe(true);
    expect(app.interfaceNames).toEqual(["cli", "ui"]);
    expect(app.errors).toEqual([]);
  });

  it("accepts app permission provider metadata without executing the provider", () => {
    const root = makeRepo();
    const marker = join(root, "provider-ran");
    writeManifest(
      root,
      "apps",
      validManifest({
        operations: {
          "apps.permissions.decide": {
            interface: "cli",
            command: `touch ${marker} && echo '{"decision":"allow"}' --json`,
            mutating: false,
            inputSchema: "schemas/permission-request.v1.json",
            outputSchema: "schemas/permission-decision.v1.json",
          },
          "apps.list": {
            interface: "cli",
            command: "ravi apps list --json",
            mutating: false,
          },
        },
        permissions: {
          required: [],
          optional: [],
          mutating: [],
          provider: {
            id: "apps.local",
            version: "2026-06-13",
            interface: "cli",
            operation: "apps.permissions.decide",
            decisionSchema: "schemas/permission-decision.v1.json",
            requestSchema: "schemas/permission-request.v1.json",
            timeoutMs: 500,
            cacheTtlSec: 30,
            failClosed: true,
            scope: ["visibility", "operation", "resource"],
          },
        },
      }),
    );

    const app = getAppManifest("apps");
    expect(app.valid).toBe(true);
    expect(app.permissions.provider).toMatchObject({
      id: "apps.local",
      version: "2026-06-13",
      interface: "cli",
      operation: "apps.permissions.decide",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects malformed app permission provider declarations", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "apps",
      validManifest({
        operations: {
          "apps.create": {
            interface: "builtin",
            handler: "apps.stub.list",
            mutating: true,
            permission: "apps:write",
          },
        },
        permissions: {
          required: [],
          optional: [],
          mutating: [],
          provider: {
            id: "Bad Provider",
            interface: "stream",
            operation: "apps.create",
            timeoutMs: 60_000,
            cacheTtlSec: 10_000,
            failClosed: false,
            scope: "everything",
          },
        },
      }),
    );

    const app = getAppManifest("apps");
    const errors = app.errors.join("\n");
    expect(app.valid).toBe(false);
    expect(errors).toContain("permissions.provider.id");
    expect(errors).toContain("permissions.provider.version");
    expect(errors).toContain("permissions.provider.interface");
    expect(errors).toContain("permissions.provider.operation must reference an operation with interface stream");
    expect(errors).toContain("permissions.provider.operation must not reference a mutating operation");
    expect(errors).toContain("permissions.provider.operation must not reference an operation that declares permission");
    expect(errors).toContain("permissions.provider.decisionSchema");
    expect(errors).toContain("permissions.provider.requestSchema");
    expect(errors).toContain("permissions.provider.timeoutMs");
    expect(errors).toContain("permissions.provider.cacheTtlSec");
    expect(errors).toContain("permissions.provider.failClosed");
    expect(errors).toContain("permissions.provider.scope");
  });

  it("rejects malformed storage and event declarations", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "apps",
      validManifest({
        storage: {
          sqlite: [
            {
              id: "State",
              kind: "unknown",
              path: "/Users/luis/private/state.db",
              tables: "records",
              migrations: "../migrations",
              retention: "not a valid policy",
            },
          ],
          files: [
            {
              path: "../escape",
              retention: 123,
            },
          ],
        },
        events: {
          emits: [
            {
              topic: "bad topic",
              durability: "forever",
            },
          ],
          consumes: [
            {
              topic: "ravi",
              replay: "yes",
            },
          ],
        },
      }),
    );

    const app = getAppManifest("apps");
    const errors = app.errors.join("\n");
    expect(app.valid).toBe(false);
    expect(errors).toContain("storage.sqlite[0].id");
    expect(errors).toContain("storage.sqlite[0].kind");
    expect(errors).toContain("storage.sqlite[0].path");
    expect(errors).toContain("storage.sqlite[0].tables");
    expect(errors).toContain("storage.sqlite[0].migrations");
    expect(errors).toContain("storage.sqlite[0].retention");
    expect(errors).toContain("storage.files[0].path");
    expect(errors).toContain("storage.files[0].retention");
    expect(errors).toContain("events.emits[0].topic");
    expect(errors).toContain("events.emits[0].durability");
    expect(errors).toContain("events.consumes[0].topic");
    expect(errors).toContain("events.consumes[0].replay");
  });

  it("rejects malformed UI and operation declarations", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "apps",
      validManifest({
        interfaces: {
          ui: {
            routes: [
              {
                id: "Main",
                path: "/bad",
                label: "",
                icon: "BadIcon",
                view: "missing",
              },
            ],
            views: [
              {
                id: "registry",
                type: "hero",
                className: "custom-card",
                query: { operation: "apps.missing" },
                refreshOn: ["bad-topic"],
                actions: [
                  {
                    id: "Run",
                    label: "",
                    operation: "bad",
                    placement: "floating",
                  },
                ],
              },
            ],
          },
        },
        operations: {
          "bad operation": {
            interface: "browser",
            mutating: "sometimes",
          },
          "apps.check": {
            interface: "cli",
            command: "",
            mutating: false,
            authorization: {
              resource: {
                type: "",
                idFromArg: -1,
                idFromOption: "",
                ownerFrom: "title",
              },
              input: {
                includeArgs: "yes",
                includeOptions: "all",
              },
            },
          },
        },
      }),
    );

    const app = getAppManifest("apps");
    const errors = app.errors.join("\n");
    expect(app.valid).toBe(false);
    expect(errors).toContain("interfaces.ui.routes[0].id");
    expect(errors).toContain("interfaces.ui.routes[0].path");
    expect(errors).toContain("interfaces.ui.routes[0].label");
    expect(errors).toContain("interfaces.ui.routes[0].icon");
    expect(errors).toContain("interfaces.ui.routes[0].view");
    expect(errors).toContain("interfaces.ui.views[0].type");
    expect(errors).toContain("interfaces.ui.views[0].className");
    expect(errors).toContain("interfaces.ui.views[0].query.operation");
    expect(errors).toContain("interfaces.ui.views[0].refreshOn[0]");
    expect(errors).toContain("interfaces.ui.views[0].actions[0].id");
    expect(errors).toContain("interfaces.ui.views[0].actions[0].label");
    expect(errors).toContain("interfaces.ui.views[0].actions[0].operation");
    expect(errors).toContain("interfaces.ui.views[0].actions[0].placement");
    expect(errors).toContain("operations.bad operation");
    expect(errors).toContain("operations.bad operation.interface");
    expect(errors).toContain("operations.bad operation.mutating");
    expect(errors).toContain("operations.apps.check.interface");
    expect(errors).toContain("operations.apps.check.command");
    expect(errors).toContain("operations.apps.check.authorization.resource.type");
    expect(errors).toContain("operations.apps.check.authorization.resource.idFromArg");
    expect(errors).toContain("operations.apps.check.authorization.resource.idFromOption");
    expect(errors).toContain("operations.apps.check.authorization.resource.ownerFrom");
    expect(errors).toContain("operations.apps.check.authorization.input.includeArgs");
    expect(errors).toContain("operations.apps.check.authorization.input.includeOptions");
  });

  it("validates UI artifact references", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "ui-artifacts-valid",
      validManifest({
        id: "ui-artifacts-valid",
        name: "UI Artifacts Valid",
        interfaces: {
          ui: {
            views: [
              {
                id: "artifact-feed",
                type: "timeline",
                uiArtifact: {
                  kind: "ui.spec",
                  artifactId: "art_ui_spec_123",
                  version: 3,
                },
              },
            ],
          },
        },
      }),
    );

    expect(getAppManifest("ui-artifacts-valid").valid).toBe(true);

    writeManifest(
      root,
      "ui-artifacts-invalid",
      validManifest({
        id: "ui-artifacts-invalid",
        name: "UI Artifacts Invalid",
        interfaces: {
          ui: {
            views: [
              {
                id: "artifact-feed",
                type: "timeline",
                uiArtifact: {
                  kind: "ui.render",
                  artifactId: "not-artifact",
                  version: 0,
                },
              },
            ],
          },
        },
      }),
    );

    const invalid = getAppManifest("ui-artifacts-invalid");
    const errors = invalid.errors.join("\n");
    expect(invalid.valid).toBe(false);
    expect(errors).toContain("interfaces.ui.views[0].uiArtifact.kind");
    expect(errors).toContain("interfaces.ui.views[0].uiArtifact.artifactId");
    expect(errors).toContain("interfaces.ui.views[0].uiArtifact.version");
  });

  it("accepts builtin operations and rejects recursive dynamic app commands", () => {
    const root = makeRepo();
    writeManifest(
      root,
      "khal-tasks",
      validManifest({
        id: "khal-tasks",
        name: "Khal Tasks",
        interfaces: {
          cli: {
            command: "ravi khal-tasks",
            json: true,
            health: "ravi khal-tasks check --json",
          },
        },
        operations: {
          "khal-tasks.list": {
            interface: "builtin",
            handler: "apps.stub.list",
            mutating: false,
          },
          "khal-tasks.check": {
            interface: "builtin",
            handler: "apps.manifest.check",
            mutating: false,
          },
        },
        health: {
          checks: [{ type: "builtin", handler: "apps.manifest.check" }],
        },
      }),
    );

    expect(getAppManifest("khal-tasks").valid).toBe(true);

    writeManifest(
      root,
      "recursive-app",
      validManifest({
        id: "recursive-app",
        name: "Recursive App",
        interfaces: {
          cli: {
            command: "ravi recursive-app",
            json: true,
            health: "ravi recursive-app list --json",
          },
        },
        operations: {
          "recursive-app.check": {
            interface: "cli",
            command: "ravi recursive-app check --json",
            mutating: false,
          },
        },
        health: {
          checks: [{ type: "cli", command: "ravi recursive-app list --json" }],
        },
      }),
    );

    const recursive = getAppManifest("recursive-app");
    const errors = recursive.errors.join("\n");
    expect(recursive.valid).toBe(false);
    expect(errors).toContain("interfaces.cli.health");
    expect(errors).toContain("operations.recursive-app.check.command");
    expect(errors).toContain("health.checks[0].command");
  });
});
