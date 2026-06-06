import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";

import { listPermissionDenials, recordPermissionDenial, setPermissionDenialNotifierForTest } from "./denials.js";
import { grantRelation } from "./relations.js";

let prompts: Array<{ sessionName: string; payload: Record<string, unknown> }> = [];
let stateDir: string | null = null;

describe("permission denial ledger", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permission-denials-test-");
    prompts = [];
    setPermissionDenialNotifierForTest(async (sessionName: string, payload: Record<string, unknown>) => {
      prompts.push({ sessionName, payload });
    });
  });

  afterEach(async () => {
    setPermissionDenialNotifierForTest();
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
    prompts = [];
  });

  it("records a denied session and notifies that session when the exact grant is added", () => {
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "worker",
      agentId: "worker",
      sessionKey: "agent:worker:group",
      sessionName: "worker-group",
      contextId: "ctx_worker",
      relation: "execute",
      objectType: "group",
      objectId: "contacts",
      reason: "Permission denied: agent:worker requires execute on group:contacts",
      command: "contacts add",
    });

    expect(denial).toMatchObject({
      subjectId: "worker",
      sessionName: "worker-group",
      contextId: "ctx_worker",
    });
    expect(denial?.resolvedAt).toBeNull();

    grantRelation("agent", "worker", "execute", "group", "contacts", "manual");

    const denials = listPermissionDenials({ subjectType: "agent", subjectId: "worker" });
    expect(denials).toHaveLength(1);
    expect(denials[0].resolvedAt).toBeNumber();
    expect(denials[0].notifiedAt).toBeNumber();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].sessionName).toBe("worker-group");
    expect(prompts[0].payload.event).toBe("ravi.permissions.grant.resolved");
    expect(String(prompts[0].payload.prompt)).toContain("execute group:contacts");
  });

  it("keeps grant resolution isolated to the denied agent and session", () => {
    recordPermissionDenial({
      agentId: "worker-a",
      sessionName: "session-a",
      relation: "execute",
      objectType: "group",
      objectId: "agents_create",
    });
    recordPermissionDenial({
      agentId: "worker-b",
      sessionName: "session-b",
      relation: "execute",
      objectType: "group",
      objectId: "agents_create",
    });

    grantRelation("agent", "worker-a", "execute", "group", "agents_*", "manual");

    const a = listPermissionDenials({ subjectType: "agent", subjectId: "worker-a" });
    const b = listPermissionDenials({ subjectType: "agent", subjectId: "worker-b" });
    expect(a[0].resolvedAt).toBeNumber();
    expect(b[0].resolvedAt).toBeNull();
    expect(prompts.map((entry) => entry.sessionName)).toEqual(["session-a"]);
  });

  it("resolves tool denials when a covering toolgroup is granted", () => {
    recordPermissionDenial({
      agentId: "reader",
      sessionName: "reader-session",
      relation: "use",
      objectType: "tool",
      objectId: "Read",
    });

    grantRelation("agent", "reader", "use", "toolgroup", "read-only", "manual");

    expect(listPermissionDenials({ subjectType: "agent", subjectId: "reader" })[0].resolvedAt).toBeNumber();
    expect(prompts.map((entry) => entry.sessionName)).toEqual(["reader-session"]);
  });
});
