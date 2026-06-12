import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { grantRelation } from "../permissions/relations.js";
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

function grant(relation: string, appId: string) {
  grantRelation("agent", "dev", relation, "app", appId, "manual", { permanent: true });
}

describe("app permission gate", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-app-permissions-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
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
    grant("use", "apps");
    runWithContext(AGENT_CONTEXT, () => {
      expect(canUseApp("apps")).toBe(true);
      // use does not imply execute (mutating)
      expect(canExecuteApp("apps")).toBe(false);
    });
  });

  it("grants mutating operations only with execute", () => {
    grant("execute", "apps");
    runWithContext(AGENT_CONTEXT, () => {
      expect(canExecuteApp("apps")).toBe(true);
      expect(() => assertCanRunAppOperation("apps", "do-thing", true)).not.toThrow();
    });
  });

  it("requires use for non-mutating ops and execute for mutating ops", () => {
    grant("use", "apps");
    runWithContext(AGENT_CONTEXT, () => {
      expect(() => assertCanRunAppOperation("apps", "list", false)).not.toThrow();
      expect(() => assertCanRunAppOperation("apps", "delete", true)).toThrow(/requires execute on app:apps/);
    });
  });

  it("normalizes the app id before checking", () => {
    grant("use", "music/player");
    runWithContext(AGENT_CONTEXT, () => {
      // mixed case + whitespace resolves to the normalized grant
      expect(canUseApp("  Music/Player ")).toBe(true);
    });
  });

  it("honors a wildcard app grant", () => {
    grant("use", "*");
    runWithContext(AGENT_CONTEXT, () => {
      expect(canUseApp("apps")).toBe(true);
      expect(canUseApp("music/player")).toBe(true);
    });
  });

  it("filters discovery to visible apps", () => {
    grant("use", "apps");
    const records = [
      { id: "apps", manifest: { id: "apps" } },
      { id: "secret", manifest: { id: "secret" } },
    ] as any;
    runWithContext(AGENT_CONTEXT, () => {
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
