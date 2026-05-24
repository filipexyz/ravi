import { describe, expect, it } from "bun:test";
import { getTriggerTopicCatalog, getTriggerTopicDiagnostic } from "../topic-catalog.js";

describe("trigger topic catalog", () => {
  it("registers the canonical inbound reaction subject", () => {
    expect(getTriggerTopicCatalog()).toContainEqual(
      expect.objectContaining({
        pattern: "ravi.inbound.reaction",
        payload: "{ targetMessageId, emoji, senderId }",
      }),
    );
  });

  it("warns about inferred channel reaction aliases", () => {
    expect(getTriggerTopicDiagnostic("whatsapp.*.reaction")).toMatchObject({
      level: "warning",
      suggestedPattern: "ravi.inbound.reaction",
    });
  });

  it("warns about inferred channel inbound aliases", () => {
    expect(getTriggerTopicDiagnostic("whatsapp.*.inbound")).toMatchObject({
      level: "warning",
    });
  });

  it("warns but allows custom publisher subjects", () => {
    expect(getTriggerTopicDiagnostic("doma.rdp.>")).toMatchObject({
      level: "warning",
      message: expect.stringContaining("custom NATS subject"),
    });
  });

  it("allows session CLI command subjects", () => {
    expect(getTriggerTopicDiagnostic("ravi.*.cli.contacts.*")).toBeUndefined();
  });
});
