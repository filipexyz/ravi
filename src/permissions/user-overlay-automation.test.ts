import { describe, expect, it } from "bun:test";
import { runWithContext, type ToolContext } from "../cli/context.js";
import type { CliExpectedError } from "../cli/expected-error.js";
import {
  assertAutomationStoreWrite,
  assertNoUserOverlayAutomationWrite,
  automationHoldCause,
} from "./user-overlay-automation.js";

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

  it("leaves the operator's own relay alone, and holds it again if anything withholds from it", () => {
    // A thread the operator asked for carries relayNarrowing as a lineage ceiling and holds the agent's authority.
    const operatorRelay = { relayNarrowing: true, relayCallerUnrestricted: true };
    expect(() =>
      runWithContext(turn("invoke-only", operatorRelay), () => assertNoUserOverlayAutomationWrite("triggers add")),
    ).not.toThrow();
    expect(() =>
      runWithContext(turn("invoke-only", operatorRelay), () => assertAutomationStoreWrite("trigger")),
    ).not.toThrow();
    // The stamp never outranks a withheld break-glass or an overlay.
    expect(() =>
      runWithContext(turn("invoke-only", { ...operatorRelay, actorBreakGlassWithheld: ["admin:system:*"] }), () =>
        assertAutomationStoreWrite("trigger"),
      ),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    expect(() =>
      runWithContext(turn("user-overlay", operatorRelay), () => assertAutomationStoreWrite("trigger")),
    ).toThrow(expect.objectContaining({ code: "PERMISSION_DENIED" }));
    // A relay without the stamp (older context, a chain through a held turn) stays held.
    expect(() =>
      runWithContext(turn("invoke-only", { relayNarrowing: true }), () => assertAutomationStoreWrite("trigger")),
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

describe("the refusal names its cause", () => {
  const withheld = { actorBreakGlassWithheld: ["admin:system:*", "execute:executable:*"] };

  function refusal(ctx: ToolContext, write: () => void): CliExpectedError {
    try {
      runWithContext(ctx, write);
    } catch (error) {
      return error as CliExpectedError;
    }
    throw new Error("expected a refusal");
  }

  it("names a held relay as a relay, never as a contact's chat permissions", () => {
    // 24/11: a thread's return refused as "limited to a contact's chat permissions" led the main
    // session to ask full access for the operator, who already held it.
    // Also a thread opened from a governed chat: narrowed to the contact's grants and a held relay.
    for (const ctx of [
      turn("invoke-only", { relayNarrowing: true }),
      turn("invoke-only", { relayNarrowing: true, ...withheld }),
      turn("user-overlay", { relayNarrowing: true }),
    ]) {
      expect(automationHoldCause(ctx.context)).toBe("held-relay");
      const command = refusal(ctx, () => assertNoUserOverlayAutomationWrite("cron add"));
      expect(command).toMatchObject({ code: "PERMISSION_DENIED", details: { automationHold: "held-relay" } });
      expect(command.message).toContain("cron add is not available in a relayed turn");
      expect(command.message).not.toContain("contact's chat permissions");
      expect(command.suggestedAction).toContain("requesting access for a contact does not lift it");
      const store = refusal(ctx, () => assertAutomationStoreWrite("cron job"));
      expect(store.message).toContain("(a relay whose caller does not carry the agent's whole authority)");
      expect(store).toMatchObject({
        suggestedAction: command.suggestedAction,
        details: { automationHold: "held-relay" },
      });
    }
  });

  it("names a contact-narrowed turn and a person with no grant in the chat, and sends neither to ask access", () => {
    const overlay = refusal(turn("user-overlay"), () => assertNoUserOverlayAutomationWrite("triggers add"));
    expect(overlay.message).toBe(
      "triggers add is not available in a turn limited to a contact's chat permissions: it would run later with the agent's full authority.",
    );
    expect(overlay).toMatchObject({ details: { automationHold: "contact-chat-grants" } });
    expect(overlay.suggestedAction).toContain("More chat permissions do not lift this");
    expect(refusal(turn("user-overlay"), () => assertAutomationStoreWrite("trigger")).message).toContain(
      "(a contact's chat permissions)",
    );
    const person = turn("invoke-only", withheld);
    expect(automationHoldCause(person.context)).toBe("person-without-chat-grant");
    const command = refusal(person, () => assertNoUserOverlayAutomationWrite("triggers add"));
    expect(command.message).toContain("the turn of a person with no grant in this chat");
    expect(command).toMatchObject({ details: { automationHold: "person-without-chat-grant" } });
    // Approving full access for that person makes the chat governed: their next turn is an overlay
    // turn, still refused. So the advice never points at a grant (Devin on #972).
    expect(command.suggestedAction).toBe("Ask the operator to set it up.");
    expect(refusal(person, () => assertAutomationStoreWrite("trigger")).message).toContain(
      "(a person with no grant in this chat)",
    );
  });

  it("finds no cause in the operator's relay, a plain turn or outside a turn", () => {
    const operatorRelay = turn("invoke-only", { relayNarrowing: true, relayCallerUnrestricted: true });
    expect(automationHoldCause(operatorRelay.context)).toBeNull();
    expect(automationHoldCause(turn("invoke-only").context)).toBeNull();
    expect(automationHoldCause()).toBeNull();
  });
});
