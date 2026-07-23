import { describe, expect, it } from "bun:test";
import {
  buildSlackBlockKitShowcasePayload,
  normalizeSlackBlockKitMessagePayload,
  normalizeSlackBlockKitValidationPayload,
} from "./block-kit.js";

describe("Slack Block Kit helpers", () => {
  it("normalizes message payloads from a blocks array or message object", () => {
    const blocks = [
      {
        type: "section",
        block_id: "intro",
        text: { type: "mrkdwn", text: "hello" },
      },
    ];

    expect(normalizeSlackBlockKitMessagePayload(blocks, "fallback")).toEqual({
      text: "fallback",
      blocks,
    });
    expect(normalizeSlackBlockKitMessagePayload({ text: "from file", blocks })).toEqual({
      text: "from file",
      blocks,
    });
  });

  it("rejects invalid message block limits and action identifiers locally", () => {
    expect(() => normalizeSlackBlockKitMessagePayload({ text: "x", blocks: [] })).toThrow("at least one block");
    expect(() =>
      normalizeSlackBlockKitMessagePayload({
        text: "x",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Missing action id" },
              },
            ],
          },
        ],
      }),
    ).toThrow("action_id is required");
    expect(() =>
      normalizeSlackBlockKitMessagePayload({
        text: "x",
        blocks: Array.from({ length: 51 }, () => ({ type: "divider" })),
      }),
    ).toThrow("at most 50 blocks");
  });

  it("builds validate requests for blocks, messages and views", () => {
    expect(normalizeSlackBlockKitValidationPayload([{ type: "divider" }], "blocks")).toEqual({
      target: "blocks",
      blocks: [{ type: "divider" }],
    });
    expect(
      normalizeSlackBlockKitValidationPayload(
        {
          type: "modal",
          title: { type: "plain_text", text: "Ravi" },
          blocks: [{ type: "divider" }],
        },
        "view",
      ),
    ).toMatchObject({
      target: "view",
      view: {
        type: "modal",
      },
    });
  });

  it("builds a showcase with interactive action ids", () => {
    const payload = buildSlackBlockKitShowcasePayload();

    expect(payload.text).toContain("Block Kit");
    expect(JSON.stringify(payload.blocks)).toContain("ravi_blockkit_approve");
    expect(() => normalizeSlackBlockKitMessagePayload(payload)).not.toThrow();
  });
});
