import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  assertCanRunAppOperation,
  assertCanUseApp,
  canExecuteApp,
  canUseApp,
  filterVisibleAppManifests,
} from "./permissions.js";

let stateDir: string | null = null;

const AGENT_CONTEXT: ToolContext = { agentId: "dev" };
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

function appCapability(permission: string, appId: string): ContextCapability {
  return { permission, objectType: "app", objectId: appId };
}

function contextWith(capabilities: ContextCapability[]): ToolContext {
  const context: ContextRecord = {
    contextId: "ctx_apps_permissions",
    contextKey: "ctx_key_apps_permissions",
    kind: "test-runtime",
    agentId: "dev",
    capabilities,
    metadata: {},
    createdAt: 0,
  };
  return { agentId: "dev", context };
}

describe("app permission gate", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-app-permissions-test-");
    for (const key of CONTEXT_ENV_KEYS) delete process.env[key];
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
    for (const key of CONTEXT_ENV_KEYS) {
      const value = originalContextEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("allows everything for a direct operator with no agent principal", () => {
    expect(canUseApp("apps")).toBe(true);
    expect(canExecuteApp("apps")).toBe(true);
  });

  it("denies an agent with no app grant (fail closed)", () => {
    runWithContext(AGENT_CONTEXT, () => {
      expect(canUseApp("apps")).toBe(false);
      expect(canExecuteApp("apps")).toBe(false);
      expect(() => assertCanUseApp("apps")).toThrow("App not found: apps");
    });
  });

  it("separates use from execute", () => {
    runWithContext(contextWith([appCapability("use", "apps")]), () => {
      expect(canUseApp("apps")).toBe(true);
      // use does not imply execute (mutating)
      expect(canExecuteApp("apps")).toBe(false);
    });
  });

  it("grants mutating operations only with execute", () => {
    runWithContext(contextWith([appCapability("execute", "apps")]), () => {
      expect(canExecuteApp("apps")).toBe(true);
      expect(() => assertCanRunAppOperation("apps", "do-thing", true)).not.toThrow();
    });
  });

  it("requires use for non-mutating ops and execute for mutating ops", () => {
    runWithContext(contextWith([appCapability("use", "apps")]), () => {
      expect(() => assertCanRunAppOperation("apps", "list", false)).not.toThrow();
      expect(() => assertCanRunAppOperation("apps", "delete", true)).toThrow(/requires execute on app:apps/);
    });
  });

  it("normalizes the app id before checking", () => {
    runWithContext(contextWith([appCapability("use", "music/player")]), () => {
      // mixed case + whitespace resolves to the normalized grant
      expect(canUseApp("  Music/Player ")).toBe(true);
    });
  });

  it("honors a wildcard app grant", () => {
    runWithContext(contextWith([appCapability("use", "*")]), () => {
      expect(canUseApp("apps")).toBe(true);
      expect(canUseApp("music/player")).toBe(true);
    });
  });

  it("filters discovery to visible apps", () => {
    const records = [
      { id: "apps", manifest: { id: "apps" } },
      { id: "secret", manifest: { id: "secret" } },
    ] as any;
    runWithContext(contextWith([appCapability("use", "apps")]), () => {
      const visible = filterVisibleAppManifests(records);
      expect(visible.map((r: { id: string }) => r.id)).toEqual(["apps"]);
    });
  });

  it("enforces against a delegated runtime context snapshot", () => {
    const delegated: ToolContext = {
      agentId: "dev",
      context: {
        contextId: "ctx_d",
        contextKey: "rctx_d",
        kind: "turn-runtime",
        agentId: "dev",
        capabilities: [{ permission: "use", objectType: "app", objectId: "apps" }],
        metadata: { authorityMode: "delegated" },
        createdAt: 0,
      } as any,
    };
    runWithContext(delegated, () => {
      expect(canUseApp("apps")).toBe(true);
      expect(canExecuteApp("apps")).toBe(false);
      expect(canUseApp("secret")).toBe(false);
    });
  });
});
