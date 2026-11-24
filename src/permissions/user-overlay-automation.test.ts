import { describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import { assertAutomationStoreWrite, assertNoUserOverlayAutomationWrite } from "./user-overlay-automation.js";

function turn(actorAuthorizationMode: string, extra: Record<string, unknown> = {}): ToolContext {
  return {
    contextId: "ctx_turn",
    agentId: "crm",
    context: {
      contextId: "ctx_turn",
      contextKey: "rctx_turn",
      kind: "turn-runtime",
      agentId: "crm",
      capabilities: [],
      metadata: { actorAuthorizationMode, ...extra },
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

  it("refuses them in a turn relayed from a contact-narrowed turn", () => {
    expect(() =>
      runWithContext(turn("invoke-only", { relayNarrowing: true }), () =>
        assertNoUserOverlayAutomationWrite("triggers add"),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("refuses them in a person's turn held below the agent's break-glass (ungoverned chat)", () => {
    for (const op of ["triggers add", "session-followups add", "hooks create", "signals raise", "tasks"]) {
      expect(() =>
        runWithContext(
          turn("invoke-only", { actorBreakGlassWithheld: ["admin:system:*", "execute:executable:*"] }),
          () => assertNoUserOverlayAutomationWrite(op),
        ),
      ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    }
  });

  it("leaves other turns and the terminal alone", () => {
    expect(() =>
      runWithContext(turn("invoke-only"), () => assertNoUserOverlayAutomationWrite("triggers add")),
    ).not.toThrow();
    expect(() => assertNoUserOverlayAutomationWrite("triggers add")).not.toThrow();
  });
});

describe("automation store guard (sink)", () => {
  const withheld = { actorBreakGlassWithheld: ["admin:system:*", "execute:executable:*"] };

  it("refuses a store write from a person's turn held below break-glass, whatever the caller", () => {
    expect(() => runWithContext(turn("invoke-only", withheld), () => assertAutomationStoreWrite("trigger"))).toThrow(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
  });

  it("does not let a cron binding to the overlay chat excuse a person held below break-glass", () => {
    expect(() =>
      runWithContext(turn("invoke-only", withheld), () =>
        assertAutomationStoreWrite("cron job", { bindableToOverlayChat: true }),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
  });

  it("lets an overlay turn write a cron job bound to its chat, and anyone disable", () => {
    expect(() =>
      runWithContext(turn("user-overlay"), () =>
        assertAutomationStoreWrite("cron job", { bindableToOverlayChat: true }),
      ),
    ).not.toThrow();
    expect(() =>
      runWithContext(turn("invoke-only", withheld), () =>
        assertAutomationStoreWrite("trigger", { disablesOnly: true }),
      ),
    ).not.toThrow();
  });

  it("leaves turns without limits and code outside a turn alone", () => {
    expect(() => runWithContext(turn("invoke-only"), () => assertAutomationStoreWrite("trigger"))).not.toThrow();
    expect(() => assertAutomationStoreWrite("trigger")).not.toThrow();
  });
});
