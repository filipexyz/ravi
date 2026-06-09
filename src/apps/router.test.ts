import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithContext } from "../cli/context.js";
import { grantRelation } from "../permissions/relations.js";
import { cleanupIsolatedRaviState } from "../test/ravi-state.js";
import { maybeRunAppAliasRoute, resolveAppAliasInvocation, runAppOperation } from "./router.js";

const tempRoots: string[] = [];
const tempStateDirs: string[] = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.RAVI_STATE_DIR;
const CONTEXT_ENV_KEYS = [
  "RAVI_CONTEXT_KEY",
  "RAVI_SESSION_KEY",
  "RAVI_SESSION_NAME",
  "RAVI_AGENT_ID",
  "RAVI_CHANNEL",
  "RAVI_ACCOUNT_ID",
  "RAVI_CHAT_ID",
] as const;
const originalContextEnv = new Map<string, string | undefined>(CONTEXT_ENV_KEYS.map((key) => [key, process.env[key]]));

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-app-router-"));
  tempRoots.push(root);
  mkdirSync(join(root, "src", "apps"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "test-repo" }));
  const stateDir = join(root, ".state");
  tempStateDirs.push(stateDir);
  process.env.RAVI_STATE_DIR = stateDir;
  for (const key of CONTEXT_ENV_KEYS) delete process.env[key];
  process.chdir(root);
  return root;
}

function writeManifest(root: string, id: string, body: Record<string, unknown>): void {
  const dir = join(root, "src", "apps", ...id.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ravi.app.json"), JSON.stringify(body, null, 2));
}

function manifest(id: string): Record<string, unknown> {
  const prefix = id.replace(/\//g, ".");
  return {
    schema: "ravi.app/v1",
    id,
    name: "Khal Tasks",
    version: "0.1.0",
    description: "Manage Khal tasks.",
    interfaces: {
      cli: {
        command: `ravi ${id.split("/").join(" ")}`,
        json: true,
        health: `ravi apps run ${id} check --json`,
      },
    },
    operations: {
      [`${prefix}.list`]: {
        interface: "builtin",
        handler: "apps.stub.list",
        mutating: false,
      },
      [`${prefix}.check`]: {
        interface: "builtin",
        handler: "apps.manifest.check",
        mutating: false,
      },
      [`${prefix}.create`]: {
        interface: "builtin",
        handler: "apps.stub.list",
        mutating: true,
        permission: `${id}:write`,
      },
    },
    permissions: {
      required: [],
      optional: [],
      mutating: [],
    },
    health: {
      checks: [{ type: "builtin", handler: "apps.manifest.check" }],
    },
  };
}

async function captureJson(fn: () => Promise<unknown>): Promise<unknown> {
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
  if (originalStateDir === undefined) {
    delete process.env.RAVI_STATE_DIR;
  } else {
    process.env.RAVI_STATE_DIR = originalStateDir;
  }
  for (const key of CONTEXT_ENV_KEYS) {
    const value = originalContextEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
  process.exitCode = undefined;
});

describe("Ravi app router", () => {
  it("runs builtin app operations through the canonical app route", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const result = await runAppOperation({
      appId: "khal-tasks",
      operation: "check",
      json: true,
    });

    expect(result).toMatchObject({
      ok: true,
      appId: "khal-tasks",
      operation: "check",
      operationId: "khal-tasks.check",
      interface: "builtin",
      handler: "apps.manifest.check",
    });
    expect(result.result).toMatchObject({ ok: true, checked: 1 });
  });

  it("resolves dynamic root aliases without stealing static root commands", () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));
    writeManifest(root, "apps", manifest("apps"));

    expect(
      resolveAppAliasInvocation(["khal-tasks", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toEqual({
      appId: "khal-tasks",
      operation: "check",
      args: [],
      json: true,
    });
    expect(
      resolveAppAliasInvocation(["apps", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toBe(null);
    expect(
      resolveAppAliasInvocation(["unknown", "check"], {
        staticRootCommands: new Set(["apps"]),
      }),
    ).toBe(null);
  });

  it("runs dynamic root aliases as JSON when an app id is discovered", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const payload = (await captureJson(() =>
      maybeRunAppAliasRoute(["khal-tasks", "check", "--json"], {
        staticRootCommands: new Set(["apps"]),
      }),
    )) as { ok: boolean; appId: string; operationId: string };

    expect(payload).toMatchObject({
      ok: true,
      appId: "khal-tasks",
      operationId: "khal-tasks.check",
    });
  });

  it("requires app use permission in agent context", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));

    const denied = await runWithContext({ agentId: "app-agent" }, () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "check",
        json: true,
      }),
    );

    expect(denied).toMatchObject({
      ok: false,
      appId: "khal-tasks",
    });
    expect(denied.error).toContain("requires use on app:khal-tasks");

    grantRelation("agent", "app-agent", "use", "app", "khal-tasks", "test");

    const allowed = await runWithContext({ agentId: "app-agent" }, () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "check",
        json: true,
      }),
    );

    expect(allowed.ok).toBe(true);
  });

  it("requires app execute permission for mutating app operations", async () => {
    const root = makeRepo();
    writeManifest(root, "khal-tasks", manifest("khal-tasks"));
    grantRelation("agent", "app-agent", "use", "app", "khal-tasks", "test");

    const denied = await runWithContext({ agentId: "app-agent" }, () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "create",
        json: true,
      }),
    );

    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("requires execute on app:khal-tasks");

    grantRelation("agent", "app-agent", "execute", "app", "khal-tasks", "test");

    const allowed = await runWithContext({ agentId: "app-agent" }, () =>
      runAppOperation({
        appId: "khal-tasks",
        operation: "create",
        json: true,
      }),
    );

    expect(allowed.ok).toBe(true);
  });
});
