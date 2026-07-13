import { describe, expect, it } from "bun:test";
import {
  normalizeSlackNativeWorkObjectDetailMetadata,
  normalizeSlackNativeWorkObjectMessagePayload,
  normalizeSlackNativeWorkObjectMetadata,
  normalizeSlackNativeWorkObjectUnfurlPayload,
} from "./work-objects.js";

describe("Slack native Work Objects metadata", () => {
  it("accepts notification metadata with entities", () => {
    const metadata = normalizeSlackNativeWorkObjectMetadata(sampleMessage().metadata);

    expect(metadata.entities).toHaveLength(1);
  });

  it("normalizes postMessage payloads", () => {
    const payload = normalizeSlackNativeWorkObjectMessagePayload(sampleMessage());

    expect(payload.text).toBe("Native Work Object smoke");
    expect(JSON.stringify(payload.metadata)).toContain("slack#/entities/task");
  });

  it("adds app_unfurl_url for unfurl payloads", () => {
    const payload = normalizeSlackNativeWorkObjectUnfurlPayload(sampleMessage(), "https://example.com/tasks/native-1");
    const first = (payload.metadata?.entities as Record<string, unknown>[])[0];

    expect(first.app_unfurl_url).toBe("https://example.com/tasks/native-1");
  });

  it("converts entity-array metadata to detail metadata", () => {
    const detail = normalizeSlackNativeWorkObjectDetailMetadata(sampleMessage().metadata);

    expect(detail.entity_type).toBe("slack#/entities/task");
    expect("entities" in detail).toBe(false);
  });

  it("rejects the old Ravi task shorthand", () => {
    expect(() => normalizeSlackNativeWorkObjectMetadata({ type: "task", id: "task-1" })).toThrow("entities array");
  });
});

function sampleMessage() {
  return {
    text: "Native Work Object smoke",
    metadata: {
      entities: [
        {
          url: "https://example.com/tasks/native-1",
          external_ref: { id: "native-1", type: "task" },
          entity_type: "slack#/entities/task",
          entity_payload: {
            attributes: {
              title: { text: "Native Work Object smoke" },
              display_type: "Task",
              product_name: "Ravi",
              metadata_last_modified: 1783910000,
            },
            fields: {
              status: { value: "open", tag_color: "blue" },
              priority: { value: "high", tag_color: "red" },
            },
            display_order: ["status", "priority"],
          },
        },
      ],
    },
  };
}
