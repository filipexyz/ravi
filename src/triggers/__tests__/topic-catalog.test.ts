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

  it("rejects inferred channel reaction aliases", () => {
    expect(getTriggerTopicDiagnostic("whatsapp.*.reaction")).toMatchObject({
      level: "error",
      suggestedPattern: "ravi.inbound.reaction",
    });
  });

  it("rejects inferred channel inbound aliases", () => {
    expect(getTriggerTopicDiagnostic("whatsapp.*.inbound")).toMatchObject({
      level: "error",
    });
  });

  it("allows custom publisher subjects", () => {
    expect(getTriggerTopicDiagnostic("doma.rdp.>")).toBeUndefined();
  });

  it("allows session CLI command subjects", () => {
    expect(getTriggerTopicDiagnostic("ravi.*.cli.contacts.*")).toBeUndefined();
  });
});
