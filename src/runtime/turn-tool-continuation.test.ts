import { describe, expect, it } from "bun:test";
import {
  PROVIDER_ENDED_AFTER_TOOLS_USER_MESSAGE,
  PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE,
} from "./public-failure.js";
import {
  createTurnToolContinuationLedger,
  listOpenTurnToolNames,
  noteTurnPostToolAssistant,
  noteTurnToolStarted,
  noteTurnToolTerminal,
  resolveHostTurnCompleteAfterTools,
  resolveTurnAfterTools,
  RUNTIME_POST_TOOL_CONTINUE_PROMPT,
} from "./turn-tool-continuation.js";

describe("turn-after-tools continuation invariant", () => {
  it("completes text-only turns and post-tool model replies", () => {
    expect(
      resolveTurnAfterTools({
        issuedTools: false,
        openToolNames: [],
        postToolAssistantChars: 0,
        locallyAborted: false,
        promptCompletedOk: true,
        continueAttempted: false,
      }),
    ).toEqual({ action: "complete" });

    expect(
      resolveTurnAfterTools({
        issuedTools: true,
        openToolNames: [],
        postToolAssistantChars: 12,
        locallyAborted: false,
        promptCompletedOk: true,
        continueAttempted: false,
      }),
    ).toEqual({ action: "complete" });
  });

  it("interrupts only when the host locally aborted and the prompt did not complete ok", () => {
    expect(
      resolveTurnAfterTools({
        issuedTools: false,
        openToolNames: [],
        postToolAssistantChars: 0,
        locallyAborted: true,
        promptCompletedOk: false,
        continueAttempted: false,
      }),
    ).toEqual({ action: "interrupt" });

    expect(
      resolveTurnAfterTools({
        issuedTools: true,
        openToolNames: [],
        postToolAssistantChars: 0,
        locallyAborted: true,
        promptCompletedOk: true,
        continueAttempted: false,
      }).action,
    ).toBe("continue");
  });

  it("fails the 15:52 open-Bash timeline instead of completing", () => {
    const ledger = createTurnToolContinuationLedger();
    noteTurnPostToolAssistant(ledger, 24);
    noteTurnToolStarted(ledger, "call_read", "Read");
    noteTurnToolTerminal(ledger, "call_read", "Read");
    noteTurnToolStarted(ledger, "call_bash", "Bash");

    expect(listOpenTurnToolNames(ledger)).toEqual(["Bash"]);
    expect(ledger.postToolAssistantChars).toBe(0);

    const decision = resolveTurnAfterTools({
      issuedTools: ledger.issued,
      openToolNames: listOpenTurnToolNames(ledger),
      postToolAssistantChars: ledger.postToolAssistantChars,
      locallyAborted: false,
      promptCompletedOk: true,
      continueAttempted: false,
    });

    expect(decision).toEqual({
      action: "fail",
      code: "open_tools",
      error: PROVIDER_ENDED_WITH_OPEN_TOOLS_USER_MESSAGE,
      recoverable: true,
    });
    expect(decision.action === "fail" ? decision.error : "").not.toMatch(/\+55|@g\.us|jid/i);
  });

  it("does not complete the 15:52 tools-then-silence shape even when Bash is synthetically terminal", () => {
    const ledger = createTurnToolContinuationLedger();
    noteTurnToolStarted(ledger, "call_read", "Read");
    noteTurnToolTerminal(ledger, "call_read", "Read");
    noteTurnToolStarted(ledger, "call_bash", "Bash");
    noteTurnToolTerminal(ledger, "call_bash", "Bash");

    const first = resolveTurnAfterTools({
      issuedTools: true,
      openToolNames: listOpenTurnToolNames(ledger),
      postToolAssistantChars: 0,
      locallyAborted: false,
      promptCompletedOk: true,
      continueAttempted: false,
    });
    expect(first).toEqual({ action: "continue", reason: "no_post_tool_continuation" });
    expect(RUNTIME_POST_TOOL_CONTINUE_PROMPT).toContain("Do not repeat completed tools");

    const afterContinue = resolveTurnAfterTools({
      issuedTools: true,
      openToolNames: [],
      postToolAssistantChars: 0,
      locallyAborted: false,
      promptCompletedOk: true,
      continueAttempted: true,
    });
    expect(afterContinue).toEqual({
      action: "fail",
      code: "no_post_tool_continuation",
      error: PROVIDER_ENDED_AFTER_TOOLS_USER_MESSAGE,
      recoverable: true,
    });
  });

  it("never continues while a tool is still open", () => {
    expect(
      resolveTurnAfterTools({
        issuedTools: true,
        openToolNames: ["Bash"],
        postToolAssistantChars: 0,
        locallyAborted: false,
        promptCompletedOk: true,
        continueAttempted: false,
      }).action,
    ).toBe("fail");
  });

  it("refuses host turn.complete for Grok tools-then-silence and for any open tool", () => {
    expect(
      resolveHostTurnCompleteAfterTools({
        provider: "grok",
        issuedTools: true,
        openToolNames: ["Bash"],
        postToolAssistantChars: 0,
      }),
    ).toMatchObject({ action: "fail", code: "open_tools" });

    expect(
      resolveHostTurnCompleteAfterTools({
        provider: "grok",
        issuedTools: true,
        openToolNames: [],
        postToolAssistantChars: 0,
      }),
    ).toMatchObject({ action: "fail", code: "no_post_tool_continuation" });

    expect(
      resolveHostTurnCompleteAfterTools({
        provider: "codex",
        issuedTools: true,
        openToolNames: [],
        postToolAssistantChars: 0,
      }),
    ).toBeNull();

    expect(
      resolveHostTurnCompleteAfterTools({
        provider: "codex",
        issuedTools: true,
        openToolNames: ["Bash"],
        postToolAssistantChars: 0,
      }),
    ).toMatchObject({ action: "fail", code: "open_tools" });
  });
});
