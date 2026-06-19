import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { listPermissionDenials, recordPermissionDenial } from "./denials.js";

let stateDir: string | null = null;

describe("permission denials", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-permission-denials-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("records and lists denied permission checks", () => {
    const denial = recordPermissionDenial({
      subjectType: "agent",
      subjectId: "worker",
      relation: "execute",
      objectType: "group",
      objectId: "contacts",
      agentId: "worker",
      sessionKey: "agent:worker:main",
      sessionName: "worker-main",
      contextId: "ctx_worker",
      reason: "missing capability",
      command: "ravi contacts list",
      detail: { authorityMode: "delegated" },
    });

    expect(denial).toMatchObject({
      subjectType: "agent",
      subjectId: "worker",
      relation: "execute",
      objectType: "group",
      objectId: "contacts",
      resolvedAt: null,
      resolvedRelationId: null,
      notifiedAt: null,
    });
    expect(listPermissionDenials({ subjectType: "agent", subjectId: "worker", resolved: false })).toHaveLength(1);
  });

  it("fails closed for incomplete denial records", () => {
    expect(
      recordPermissionDenial({
        subjectType: "agent",
        subjectId: "",
        relation: "execute",
        objectType: "group",
        objectId: "contacts",
      }),
    ).toBeNull();
    expect(listPermissionDenials()).toEqual([]);
  });
});
