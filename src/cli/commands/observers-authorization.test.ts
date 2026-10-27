import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../context.js";
import { getOrCreateSession } from "../../router/sessions.js";
import { dbListObserverRules } from "../../runtime/observation-plane.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { ObserverCommands, ObserverRuleCommands } from "./observers.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-observers-authz-");
  getOrCreateSession("agent:crm:main", "crm", "/tmp/crm");
  getOrCreateSession("agent:main:main", "main", "/tmp/main");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

const CRM: ToolContext = {
  contextId: "ctx_crm",
  agentId: "crm",
  sessionKey: "agent:crm:main",
  sessionName: "agent:crm:main",
  context: {
    contextId: "ctx_crm",
    contextKey: "rctx_crm",
    kind: "agent-runtime",
    agentId: "crm",
    sessionKey: "agent:crm:main",
    sessionName: "agent:crm:main",
    capabilities: [{ permission: "execute", objectType: "group", objectId: "observers", source: "test" }],
    createdAt: 0,
  },
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { envelope?: () => { error: { code: string } } }).envelope?.().error.code;
  }
  return undefined;
}

function setRule(id: string, observerAgentId: string, scope: string, sourceSession?: string) {
  return new ObserverRuleCommands().set(
    id,
    observerAgentId,
    undefined,
    scope,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    sourceSession,
  );
}

describe("observer rules stay inside the caller's sessions", () => {
  it("refuses wide scopes, other agents' sessions and other observer agents", () => {
    runWithContext(CRM, () => {
      expect(codeOf(() => setRule("wide", "crm", "global"))).toBe("PERMISSION_DENIED");
      expect(codeOf(() => setRule("peek", "crm", "session", "agent:main:main"))).toBe("SESSION_NOT_FOUND");
      expect(codeOf(() => setRule("proxy", "main", "session", "agent:crm:main"))).toBe("PERMISSION_DENIED");
      expect(codeOf(() => new ObserverCommands().refresh("agent:main:main"))).toBe("SESSION_NOT_FOUND");
    });
    expect(dbListObserverRules()).toEqual([]);
  });
});
