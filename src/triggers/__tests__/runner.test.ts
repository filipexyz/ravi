import { describe, expect, it } from "bun:test";
import { buildCliAuditPayload } from "../../cli/audit.js";
import { runWithContext } from "../../cli/context.js";
import {
  getTriggerEventDedupeKey,
  isTriggerOriginatedEvent,
  planTriggerTopicRefresh,
  shouldRetryTriggerTopic,
} from "../runner.js";

describe("trigger runner subscription refresh", () => {
  it("retains unchanged topics and applies only the incremental diff", () => {
    expect(planTriggerTopicRefresh(["topic.keep", "topic.remove"], ["topic.keep", "topic.add"])).toEqual({
      keep: ["topic.keep"],
      add: ["topic.add"],
      remove: ["topic.remove"],
    });
  });

  it("uses canonical provenance while retaining legacy anti-loop markers", () => {
    expect(isTriggerOriginatedEvent("custom.topic", { _turnProvenance: { origin: "trigger" } })).toBe(true);
    expect(isTriggerOriginatedEvent("custom.topic", { _turnProvenance: { origin: "human" } })).toBe(false);
    expect(isTriggerOriginatedEvent("ravi.agent:main:trigger:abc.result", {})).toBe(true);
    expect(isTriggerOriginatedEvent("custom.topic", { _trigger: true })).toBe(true);
  });

  it("skips the audit event of a command run in a trigger's own session, and no other session's", () => {
    const audit = (sessionKey?: string) => ({
      tool: "sessions_inform",
      sessionKey: "_cli",
      cliInvocation: { raviContext: { hasContextKey: true, ...(sessionKey ? { sessionKey } : {}) } },
    });
    const topic = "ravi._cli.cli.sessions.inform";
    expect(isTriggerOriginatedEvent(topic, audit("agent:main:trigger:ab12cd34:own"))).toBe(true);
    // Commands run anywhere else fire triggers as before: a chat, the terminal,
    // and the plain or named session of a trigger.
    for (const sessionKey of [
      undefined,
      "agent:main:main",
      "agent:main:whatsapp:dm:5511999999999",
      "agent:main:trigger:ab12cd34",
      "agent:main:trigger:ab12cd34:key:0123456789abcdef01234567",
    ]) {
      expect(isTriggerOriginatedEvent(topic, audit(sessionKey))).toBe(false);
    }
    expect(isTriggerOriginatedEvent(topic, { cliInvocation: "agent:main:trigger:ab12cd34:own" })).toBe(false);
  });

  it("recognizes the audit event the CLI really publishes for a command run in an own session", () => {
    const auditIn = (sessionKey: string) =>
      runWithContext({ agentId: "main", sessionKey, sessionName: sessionKey }, () =>
        buildCliAuditPayload({ group: "sessions", name: "inform", input: { target: "luis-dm" } }),
      );
    const topic = "ravi._cli.cli.sessions.inform";
    expect(isTriggerOriginatedEvent(topic, auditIn("agent:main:trigger:ab12cd34:own"))).toBe(true);
    expect(isTriggerOriginatedEvent(topic, auditIn("agent:main:whatsapp:dm:5511999999999"))).toBe(false);

    // A turn's command goes through the gateway, which builds the event outside
    // the command's context and says itself that it ran in an own session.
    const gateway = (fromTriggerOwnSession?: boolean) =>
      buildCliAuditPayload({
        group: "sessions",
        name: "inform",
        input: { target: "luis-dm" },
        contextId: "ctx_turn",
        agentId: "main",
        fromTriggerOwnSession,
      });
    expect(isTriggerOriginatedEvent(topic, gateway(true))).toBe(true);
    expect(isTriggerOriginatedEvent(topic, gateway(false))).toBe(false);
    expect(isTriggerOriginatedEvent(topic, gateway())).toBe(false);
  });

  it("does not let a delayed retry revive a topic removed from desired state", () => {
    expect(shouldRetryTriggerTopic("topic.retry", true, new Set(["topic.retry"]), new Map())).toBe(true);
    expect(shouldRetryTriggerTopic("topic.retry", true, new Set(), new Map())).toBe(false);
    expect(shouldRetryTriggerTopic("topic.retry", true, new Set(["topic.retry"]), new Map([["topic.retry", {}]]))).toBe(
      false,
    );
  });
});

describe("trigger runner event dedupe", () => {
  it("keys local inbox mail events by trigger, topic, and message identity", () => {
    const trigger = { id: "trg_mail" };
    const event = {
      topic: "ravi.inbox.mail.received",
      data: {
        inboxItemId: "inbox_1",
        sourceId: "mail_msg_1",
        mail: {
          messageId: "mail_msg_1",
          subject: "Invoice",
        },
      },
    };

    expect(getTriggerEventDedupeKey(trigger, event)).toBe(
      ["trg_mail", "ravi.inbox.mail.received", "inbox_1"].join("\0"),
    );
    expect(
      getTriggerEventDedupeKey(trigger, {
        ...event,
        data: {
          ...event.data,
          inboxItemId: "inbox_2",
          sourceId: "mail_msg_2",
          mail: { messageId: "mail_msg_2", subject: "Invoice" },
        },
      }),
    ).not.toBe(getTriggerEventDedupeKey(trigger, event));
  });

  it("falls back to a stable payload hash when the event has no explicit id", () => {
    const trigger = { id: "trg_custom" };
    const first = getTriggerEventDedupeKey(trigger, {
      topic: "custom.topic",
      data: { b: 2, a: { z: true, y: "same" } },
    });
    const second = getTriggerEventDedupeKey(trigger, {
      topic: "custom.topic",
      data: { a: { y: "same", z: true }, b: 2 },
    });

    expect(first).toBe(second);
    expect(first).toStartWith("trg_custom\0custom.topic\0payload:");
  });
});
