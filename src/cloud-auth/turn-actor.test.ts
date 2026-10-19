import { describe, expect, it } from "bun:test";

import { runWithContext } from "../cli/context.js";
import { inRuntimeTurn, turnActorContactId } from "./turn-actor.js";

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

describe("inRuntimeTurn", () => {
  it("covers commands the daemon gateway runs for a turn, whose process has no RAVI_CONTEXT_KEY", () => {
    expect(inRuntimeTurn({})).toBe(false);
    expect(inRuntimeTurn({ RAVI_CONTEXT_KEY: "ctx_1" })).toBe(true);
    expect(runWithContext({ transport: "gateway" }, () => inRuntimeTurn({}))).toBe(true);
    expect(runWithContext({ transport: "tool" }, () => inRuntimeTurn({}))).toBe(true);
    expect(runWithContext({}, () => inRuntimeTurn({}))).toBe(false);
  });
});
