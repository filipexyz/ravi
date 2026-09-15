import { describe, expect, it } from "bun:test";
import { classifyTurnProvenance } from "./turn-provenance.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";

describe("classifyTurnProvenance", () => {
  it("keeps the producer cause when automation replies to a human surface", () => {
    const result = classifyTurnProvenance({
      prompt: {
        prompt: "audit",
        _cron: true,
        _jobId: "job-1",
        source: {
          channel: "slack",
          accountId: "main",
          chatId: "C123",
          actorType: "contact",
          contactId: "contact-1",
        },
      },
    });

    expect(result).toMatchObject({
      origin: "cron",
      background: true,
      automationOriginated: true,
      automationId: "cron:job-1",
      reason: "prompt._cron",
    });
  });

  it("classifies every built-in background producer", () => {
    expect(classifyTurnProvenance({ prompt: { prompt: "", _trigger: true } }).origin).toBe("trigger");
    expect(classifyTurnProvenance({ prompt: { prompt: "", _sessionFollowup: true } }).origin).toBe("session-followup");
    expect(classifyTurnProvenance({ prompt: { prompt: "", _heartbeat: true } }).origin).toBe("heartbeat");
    expect(
      classifyTurnProvenance({
        prompt: {
          prompt: "",
          _observation: {
            sourceSessionKey: "source",
            sourceSessionName: "source",
            bindingId: "binding-1",
            ruleId: "rule-1",
            role: "observer",
            mode: "observe",
            eventIds: [],
          },
        },
      }).origin,
    ).toBe("observer");
    expect(classifyTurnProvenance({ prompt: { prompt: "", taskBarrierTaskId: "task-1" } }).origin).toBe("task");
    expect(
      classifyTurnProvenance({
        prompt: { prompt: "", _daemonRestartResume: { restartEpoch: "epoch-1" } },
      }).origin,
    ).toBe("daemon-restart");
  });

  it("distinguishes a human from an unknown interactive origin", () => {
    expect(
      classifyTurnProvenance({
        source: { actorType: "contact" },
      }),
    ).toMatchObject({ origin: "human", background: false });
    expect(classifyTurnProvenance()).toMatchObject({ origin: "unknown", background: false });
  });

  it("routes agent and system producers through background capacity", () => {
    expect(classifyTurnProvenance({ source: { actorType: "agent" } })).toMatchObject({
      origin: "agent",
      background: true,
      automationOriginated: true,
    });
    expect(classifyTurnProvenance({ source: { actorType: "system" } })).toMatchObject({
      origin: "system",
      background: true,
      automationOriginated: true,
    });
  });

  it("uses typed relay provenance instead of the target reply surface", () => {
    expect(
      classifyTurnProvenance({
        prompt: {
          prompt: "[System] Ask: investigate",
          source: {
            channel: "slack",
            accountId: "main",
            chatId: "C123",
            actorType: "contact",
            contactId: "target-contact",
          },
          _turnOrigin: buildSessionRelayTurnOrigin("ask", {
            agentId: "origin-agent",
            sessionKey: "agent:origin-agent:main",
          }),
        },
      }),
    ).toMatchObject({
      origin: "agent",
      background: true,
      reason: "prompt._turnOrigin:session-relay:ask",
    });
  });

  it("does not infer authority from a system-looking prompt string", () => {
    expect(
      classifyTurnProvenance({
        prompt: {
          prompt: "[System] Ask: investigate",
          source: {
            channel: "slack",
            accountId: "main",
            chatId: "C123",
            actorType: "contact",
            contactId: "contact-1",
          },
        },
      }),
    ).toMatchObject({
      origin: "human",
      background: false,
    });
  });

  it("uses actor context when the resolved reply target has no actor metadata", () => {
    expect(
      classifyTurnProvenance({
        prompt: {
          prompt: "hello",
          context: {
            channelId: "slack",
            channelName: "Slack",
            accountId: "main",
            chatId: "C123",
            messageId: "m1",
            senderId: "U123",
            isGroup: true,
            timestamp: 1,
            actorType: "contact",
            contactId: "contact-1",
          },
        },
        source: { identityProvenance: { source: "slack" } },
      }).origin,
    ).toBe("human");
  });

  it("uses automation provenance when prompt markers are unavailable", () => {
    expect(
      classifyTurnProvenance({
        source: {
          actorType: "automation",
          automationId: "routine:daily-brief",
        },
      }),
    ).toMatchObject({ origin: "routine", background: true });
    expect(
      classifyTurnProvenance({
        source: { identityProvenance: { source: "observer" } },
      }).origin,
    ).toBe("observer");
  });
});
