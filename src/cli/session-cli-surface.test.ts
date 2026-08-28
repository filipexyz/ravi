import { describe, expect, it } from "bun:test";
import { CLI_SESSION_BOOTSTRAP_EFFORT, DEFAULT_RUNTIME_EFFORT } from "../runtime/effort.js";
import {
  buildSessionSendPrompt,
  isCliWaitDestination,
  omitSkillVisibilityFromSessionJson,
  readThisTurnAssistantText,
  resolveCliSessionBootstrapEffort,
  sanitizeCliAssistantText,
  snapshotTranscriptCursor,
  waitForThisTurnAssistantText,
  type SessionSendPromptInput,
} from "./session-cli-surface.js";

describe("session CLI surface", () => {
  it("sends operator CLI-only prompts as raw user text", () => {
    expect(buildSessionSendPrompt({ prompt: "responde só: pong" })).toBe("responde só: pong");
    expect(buildSessionSendPrompt({ prompt: "hello", callerSessionKey: undefined })).toBe("hello");
  });

  it("keeps Inform wrapping for in-context agent-to-agent sends", () => {
    expect(buildSessionSendPrompt({ prompt: "hello", callerSessionKey: "agent:main:origin" })).toBe(
      "[System] Inform: [from: agent:main:origin] hello",
    );
  });

  it("does not invent a from field on sessions.send", () => {
    type HasFrom = "from" extends keyof SessionSendPromptInput ? true : false;
    const hasFrom: HasFrom = false;
    expect(hasFrom).toBe(false);
    expect(
      Object.keys({
        prompt: "hello",
        raw: true,
        callerSessionKey: "agent:main:origin",
      } satisfies SessionSendPromptInput).sort(),
    ).toEqual(["callerSessionKey", "prompt", "raw"]);
  });

  it("uses --raw as an escape hatch even for in-context sends", () => {
    expect(
      buildSessionSendPrompt({
        prompt: "hello",
        callerSessionKey: "agent:main:origin",
        raw: true,
      }),
    ).toBe("hello");
  });

  it("treats named CLI-only sessions as the wait destination", () => {
    expect(
      isCliWaitDestination({
        source: undefined,
        hasOutputAttachment: false,
      }),
    ).toBe(true);
  });

  it("keeps chat-attached waits on delivered channel output", () => {
    expect(
      isCliWaitDestination({
        channelOverride: "slack",
        toOverride: "C123",
      }),
    ).toBe(false);
    expect(
      isCliWaitDestination({
        source: { channel: "whatsapp", chatId: "5511" },
      }),
    ).toBe(false);
    expect(isCliWaitDestination({ hasOutputAttachment: true })).toBe(false);
  });

  it("does not treat @@SILENT@@ as CLI text", () => {
    expect(sanitizeCliAssistantText("@@SILENT@@")).toBe("");
    expect(sanitizeCliAssistantText("@@SILENT@@ pong")).toBe("pong");
  });

  it("reads this turn's assistant transcript and ignores previous turns", () => {
    const messages = [
      { id: 1, role: "user", content: "old" },
      { id: 2, role: "assistant", content: "previous" },
      { id: 3, role: "user", content: "responde só: pong" },
      { id: 4, role: "assistant", content: "pong" },
    ];
    expect(snapshotTranscriptCursor(messages.slice(0, 2))).toBe(2);
    expect(readThisTurnAssistantText(messages, 2)).toEqual({ text: "pong" });
    expect(readThisTurnAssistantText(messages.slice(0, 2), 2)).toBeNull();
  });

  it("waits when persist lags after turn.complete", async () => {
    const prior = [
      { id: 1, role: "user", content: "old" },
      { id: 2, role: "assistant", content: "previous" },
    ];
    const current = [
      ...prior,
      { id: 3, role: "user", content: "responde só: pong" },
      { id: 4, role: "assistant", content: "pong" },
    ];
    let reads = 0;

    const text = await waitForThisTurnAssistantText({
      afterId: 2,
      timeoutMs: 200,
      pollMs: 1,
      sleep: async () => {},
      readMessages: () => {
        reads += 1;
        return reads < 3 ? prior : current;
      },
    });

    expect(text).toBe("pong");
    expect(reads).toBeGreaterThanOrEqual(3);
  });

  it("strips the advertised skill catalog from default session JSON", () => {
    const session = omitSkillVisibilityFromSessionJson({
      sessionKey: "agent:grok-cli-probe:main",
      name: "grok-cli-probe",
      runtimeSessionParams: {
        sessionId: "sess-1",
        skillVisibility: {
          skills: [{ id: "ravi-system-events", state: "advertised" }],
          loadedSkills: [],
        },
      },
    });

    expect(session.runtimeSessionParams).toEqual({ sessionId: "sess-1" });
    expect(JSON.stringify(session)).not.toContain("skillVisibility");
    expect(JSON.stringify(session)).not.toContain("ravi-system-events");
  });

  it("does not inherit hardcoded xhigh for CLI-only bootstrap", () => {
    expect(DEFAULT_RUNTIME_EFFORT).toBe("xhigh");
    expect(CLI_SESSION_BOOTSTRAP_EFFORT).not.toBe(DEFAULT_RUNTIME_EFFORT);
    expect(
      resolveCliSessionBootstrapEffort({
        createdSession: true,
        cliDestination: true,
      }),
    ).toBe(CLI_SESSION_BOOTSTRAP_EFFORT);
    expect(
      resolveCliSessionBootstrapEffort({
        createdSession: true,
        cliDestination: true,
        explicitEffort: "low",
      }),
    ).toBe("low");
    expect(
      resolveCliSessionBootstrapEffort({
        createdSession: false,
        cliDestination: true,
      }),
    ).toBeUndefined();
  });
});
