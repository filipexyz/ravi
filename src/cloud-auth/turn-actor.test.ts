import { describe, expect, it } from "bun:test";

import { runWithContext } from "../cli/context.js";
import { inRuntimeTurn, isUnattributedTurn, turnActorContactId } from "./turn-actor.js";

describe("turnActorContactId", () => {
  it("is null outside a runtime turn, without classifying anything", () => {
    expect(turnActorContactId({})).toBeNull();
    expect(turnActorContactId({ RAVI_CONTEXT_KEY: "  " })).toBeNull();
  });

  it("names the contact only when someone other than the operator wrote the turn", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    expect(turnActorContactId(env, { actor: { kind: "contact", contactId: "c_ana" } })).toBe("c_ana");
    expect(turnActorContactId(env, { actor: { kind: "operator" } })).toBeNull();
    expect(
      turnActorContactId(env, { actor: { kind: "refused", message: "unknown speaker", actorPrincipal: "agent:x" } }),
    ).toBeNull();
  });

  it("keeps a relay a contact's turn produced attributed to that contact", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    const refused = { kind: "refused" as const, message: "agent relay", actorPrincipal: "agent:x" };
    const relayed = {
      context: {
        contextId: "ctx_relay",
        contextKey: "rctx_relay",
        kind: "turn-runtime",
        capabilities: [],
        createdAt: 0,
        metadata: { relayCallerContactId: "c_ana" },
      },
    };
    expect(runWithContext(relayed, () => turnActorContactId(env, { actor: refused }))).toBe("c_ana");
    expect(runWithContext(relayed, () => turnActorContactId(env, { actor: { kind: "operator" } }))).toBeNull();
  });

  it("is null when the turn cannot be classified", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    const throwing = {
      readCredentials: () => {
        throw new Error("credentials unreadable");
      },
    };
    expect(turnActorContactId(env, throwing)).toBeNull();
  });
});

describe("isUnattributedTurn", () => {
  const refused = { kind: "refused" as const, message: "unknown speaker", actorPrincipal: "agent:x" };

  it("is true only for a runtime turn Ravi cannot attribute, or cannot classify", () => {
    const env = { RAVI_CONTEXT_KEY: "ctx_1" };
    expect(isUnattributedTurn(env, { actor: refused })).toBe(true);
    expect(isUnattributedTurn(env, { actor: { kind: "operator" } })).toBe(false);
    expect(isUnattributedTurn(env, { actor: { kind: "contact", contactId: "c_ana" } })).toBe(false);
    const throwing = {
      readCredentials: () => {
        throw new Error("credentials unreadable");
      },
    };
    expect(isUnattributedTurn(env, throwing)).toBe(true);
  });

  it("is false outside a runtime turn (the terminal, the daemon's own calls)", () => {
    expect(isUnattributedTurn({})).toBe(false);
    expect(runWithContext({}, () => isUnattributedTurn({}))).toBe(false);
  });
});

describe("inRuntimeTurn", () => {
  it("covers commands the daemon gateway runs for a turn, whose process has no RAVI_CONTEXT_KEY", () => {
    expect(inRuntimeTurn({})).toBe(false);
    expect(inRuntimeTurn({ RAVI_CONTEXT_KEY: "ctx_1" })).toBe(true);
    expect(runWithContext({ transport: "gateway" }, () => inRuntimeTurn({}))).toBe(true);
    expect(runWithContext({ transport: "tool" }, () => inRuntimeTurn({}))).toBe(true);
    expect(runWithContext({}, () => inRuntimeTurn({}))).toBe(false);
  });
});
