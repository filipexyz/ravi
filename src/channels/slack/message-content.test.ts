import { describe, expect, it } from "bun:test";
import { extractSlackMessageText } from "./message-content.js";

describe("Slack message content", () => {
  it("keeps plain text when no blocks are supplied", () => {
    expect(extractSlackMessageText({ text: "hello\nworld" })).toBe("hello\nworld");
    expect(extractSlackMessageText({ text: "hello", blocks: [] })).toBe("hello");
  });

  it("reads all Markdown blocks without duplicating the notification fallback", () => {
    expect(
      extractSlackMessageText({
        text: "Opening sentence.",
        blocks: [
          { type: "markdown", text: "" },
          { type: "markdown", text: "Opening sentence." },
          { type: "markdown", text: "1. First\n2. Second\n3. Third" },
        ],
      }),
    ).toBe("Opening sentence.\n\n1. First\n2. Second\n3. Third");
  });

  it("preserves headers, section text and fields in their visible order", () => {
    expect(
      extractSlackMessageText({
        text: "Status summary",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Status" } },
          { type: "divider" },
          {
            type: "section",
            text: { type: "mrkdwn", text: "Build completed." },
            fields: [
              { type: "plain_text", text: "Tests: 12 passed" },
              { type: "mrkdwn", text: "<https://example.com/build|Build log>" },
            ],
          },
        ],
      }),
    ).toBe("Status\n\nBuild completed.\nTests: 12 passed\n<https://example.com/build|Build log>");
  });

  it("uses the complete fallback for a layout it cannot fully interpret", () => {
    const text = "Opening and the complete rich-text content.";
    expect(
      extractSlackMessageText({
        text,
        blocks: [
          { type: "markdown", text: "Opening" },
          { type: "rich_text", elements: [{ type: "rich_text_section", elements: [] }] },
        ],
      }),
    ).toBe(text);
  });

  it("does not turn malformed blocks or action metadata into message text", () => {
    for (const block of [
      null,
      "not a block",
      { type: "markdown", text: { hidden: "not content" } },
      { type: "section", text: { type: "unknown", text: "not content" } },
      { type: "section", fields: "not fields" },
      { type: "section", fields: [{ type: "mrkdwn", text: 123 }] },
      { type: "actions", elements: [{ value: "not content" }] },
    ]) {
      expect(extractSlackMessageText({ text: "Readable fallback", blocks: [block] })).toBe("Readable fallback");
      expect(extractSlackMessageText({ blocks: [block] })).toBe("");
    }
  });

  it("keeps the fallback when a section accessory has visible content it cannot reconstruct", () => {
    const blocks = [
      { type: "markdown", text: "Status" },
      {
        type: "section",
        text: { type: "mrkdwn", text: "Selected environment:" },
        accessory: {
          type: "static_select",
          initial_option: { text: { type: "plain_text", text: "Production" }, value: "internal-env-id" },
        },
      },
    ];
    expect(extractSlackMessageText({ text: "Status: selected environment Production", blocks })).toBe(
      "Status: selected environment Production",
    );
    expect(extractSlackMessageText({ blocks })).toBe("");
  });

  it("keeps fallback and empty-message semantics when readable blocks are empty", () => {
    const blocks = [{ type: "markdown", text: " \n" }, { type: "section" }, { type: "divider" }];
    expect(extractSlackMessageText({ text: "Fallback", blocks })).toBe("Fallback");
    expect(extractSlackMessageText({ blocks })).toBe("");
  });
});
