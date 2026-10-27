import { describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { assertNoUserOverlayAutomationWrite } from "./user-overlay-automation.js";

function turn(actorAuthorizationMode: string): ToolContext {
  return {
    contextId: "ctx_turn",
    agentId: "crm",
    context: {
      contextId: "ctx_turn",
      contextKey: "rctx_turn",
      kind: "turn-runtime",
      agentId: "crm",
      capabilities: [],
      metadata: { actorAuthorizationMode },
      createdAt: 0,
    },
  };
}

describe("automation writes from a contact-narrowed turn", () => {
  it("refuses them, so they never run later with the agent's full authority", () => {
    expect(() =>
      runWithContext(turn("user-overlay"), () => assertNoUserOverlayAutomationWrite("triggers add")),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("leaves other turns and the terminal alone", () => {
    expect(() =>
      runWithContext(turn("invoke-only"), () => assertNoUserOverlayAutomationWrite("triggers add")),
    ).not.toThrow();
    expect(() => assertNoUserOverlayAutomationWrite("triggers add")).not.toThrow();
  });
});
