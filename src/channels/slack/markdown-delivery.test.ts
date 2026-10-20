import { describe, expect, it, mock } from "bun:test";
import { slackClientMessageId } from "./client-message-id.js";
import { SlackApiError } from "./client.js";
import { postSlackMarkdown, postSlackMrkdwn, updateSlackMarkdown } from "./markdown-delivery.js";

const DOC = ["# Plano de rollout", "", ...Array.from({ length: 45 }, (_, i) => `- passo ${i}`)].join("\n");
const REPLY = ["Feito. O plano está pronto.", "", "```markdown", DOC, "```", "", "Revisa e me diz."].join("\n");

function fakeClient(overrides: Record<string, unknown> = {}) {
  let ts = 0;
  return {
    postMessage: mock(async (_input: Record<string, unknown>) => {
      ts += 1;
      const value = `1713000000.00010${ts}`;
      return { channel: "C123", ts: value, messageId: value, raw: { ok: true } };
    }),
    updateMessage: mock(async (_input: Record<string, unknown>) => ({
      channel: "C123",
      ts: "1713000000.000100",
      messageId: "1713000000.000100",
      raw: { ok: true },
    })),
    canvasesCreate: mock(async (_input: Record<string, unknown>) => ({ ok: true, canvas_id: "F0CANVAS" })),
    canvasesAccessSet: mock(async (_input: Record<string, unknown>) => ({ ok: true })),
    canvasesDelete: mock(async (_input: Record<string, unknown>) => ({ ok: true })),
    filesInfo: mock(async (_input: Record<string, unknown>) => ({
      ok: true,
      file: { permalink: "https://acme.slack.com/docs/T1/F0CANVAS" },
    })),
    uploadTextFile: mock(async (_input: Record<string, unknown>) => ({ fileId: "F0FILE", raw: { ok: true } })),
    ...overrides,
  };
}

describe("postSlackMarkdown", () => {
  it("publishes a long document as a canvas the channel can read and links it from the message", async () => {
    const client = fakeClient();
    const result = await postSlackMarkdown(client as never, {
      channel: "C123",
      threadTs: "1712999999.000100",
      markdown: REPLY,
      idempotencyKey: "emit-1",
    });

    expect(client.canvasesCreate).toHaveBeenCalledWith({ title: "Plano de rollout", markdown: DOC });
    expect(client.canvasesAccessSet).toHaveBeenCalledWith({
      canvasId: "F0CANVAS",
      accessLevel: "read",
      channelIds: ["C123"],
    });
    expect(client.postMessage).toHaveBeenCalledTimes(1);
    expect(client.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "Feito. O plano está pronto.",
      blocks: [
        {
          type: "markdown",
          text: "Feito. O plano está pronto.\n\n📄 [Plano de rollout](https://acme.slack.com/docs/T1/F0CANVAS)\n\nRevisa e me diz.",
        },
      ],
      threadTs: "1712999999.000100",
      clientMsgId: slackClientMessageId("emit-1"),
    });
    expect(client.uploadTextFile).not.toHaveBeenCalled();
    expect(result.documents).toEqual([{ title: "Plano de rollout", delivery: "canvas", id: "F0CANVAS" }]);
  });

  it("sends the document as a file in the thread when the app cannot make a canvas", async () => {
    const client = fakeClient({
      canvasesCreate: mock(async () => {
        throw new SlackApiError("canvases.create", "missing_scope");
      }),
    });
    const result = await postSlackMarkdown(client as never, {
      channel: "C123",
      threadTs: "1712999999.000100",
      markdown: REPLY,
    });

    const posted = client.postMessage.mock.calls[0]?.[0] as { blocks: Array<{ text: string }> };
    expect(posted.blocks[0]?.text).toContain("📎 **Plano de rollout**");
    expect(client.uploadTextFile).toHaveBeenCalledWith({
      channel: "C123",
      threadTs: "1712999999.000100",
      filename: "plano-de-rollout.md",
      title: "Plano de rollout",
      content: DOC,
    });
    expect(result.documents).toEqual([{ title: "Plano de rollout", delivery: "file", id: "F0FILE" }]);
  });

  it("deletes a canvas it could not share and falls back to the file", async () => {
    const client = fakeClient({
      canvasesAccessSet: mock(async () => {
        throw new SlackApiError("canvases.access.set", "channel_not_found");
      }),
    });
    await postSlackMarkdown(client as never, { channel: "D123", markdown: REPLY });

    expect(client.canvasesDelete).toHaveBeenCalledWith({ canvasId: "F0CANVAS" });
    expect(client.uploadTextFile).toHaveBeenCalledTimes(1);
  });

  it("keeps everything in the messages when documents are off", async () => {
    const client = fakeClient();
    await postSlackMarkdown(client as never, { channel: "C123", markdown: REPLY, allowDocuments: false });

    expect(client.canvasesCreate).not.toHaveBeenCalled();
    expect(client.uploadTextFile).not.toHaveBeenCalled();
    const posted = client.postMessage.mock.calls[0]?.[0] as { blocks: Array<{ text: string }> };
    expect(posted.blocks[0]?.text).toBe(REPLY);
  });

  it("keeps images as links when unfurling is off", async () => {
    const client = fakeClient();
    const markdown = "Chart:\n\n![Usage](https://example.com/usage.png)";
    await postSlackMarkdown(client as never, { channel: "C123", markdown, unfurlLinks: false });

    expect(client.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "Chart:",
      blocks: [{ type: "markdown", text: markdown }],
      unfurlLinks: false,
      unfurlMedia: false,
    });
  });

  it("falls back to mrkdwn when Slack refuses the blocks", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = fakeClient({
      postMessage: mock(async (input: Record<string, unknown>) => {
        calls.push(input);
        if (input.blocks) throw new SlackApiError("chat.postMessage", "invalid_blocks");
        return { channel: "C123", ts: "1713000000.000500", messageId: "1713000000.000500", raw: { ok: true } };
      }),
    });
    const result = await postSlackMarkdown(client as never, {
      channel: "C123",
      markdown: "## Status\n\nUse **bold** and [docs](https://example.com).",
      idempotencyKey: "emit-2",
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({
      channel: "C123",
      text: "*Status*\n\nUse *bold* and <https://example.com|docs>.",
      clientMsgId: slackClientMessageId("emit-2:part:mrkdwn:0"),
    });
    expect(result.first.ts).toBe("1713000000.000500");
  });
});

describe("postSlackMrkdwn", () => {
  it("posts short legacy mrkdwn as it is", async () => {
    const client = fakeClient();
    await postSlackMrkdwn(client as never, { channel: "C123", text: "*done*", idempotencyKey: "emit-3" });

    expect(client.postMessage).toHaveBeenCalledWith({
      channel: "C123",
      text: "*done*",
      clientMsgId: slackClientMessageId("emit-3"),
    });
  });

  it("splits long legacy mrkdwn between blocks before Slack cuts it", async () => {
    const client = fakeClient();
    const text = Array.from({ length: 12 }, (_, i) => `*Part ${i}*\n${"word ".repeat(80)}`).join("\n\n");
    const result = await postSlackMrkdwn(client as never, { channel: "C123", text, idempotencyKey: "emit-4" });

    expect(result.messages.length).toBeGreaterThan(1);
    expect(client.postMessage.mock.calls[1]?.[0]).toMatchObject({ clientMsgId: slackClientMessageId("emit-4:part:1") });
  });
});

describe("updateSlackMarkdown", () => {
  it("updates one message with a markdown block", async () => {
    const client = fakeClient();
    await updateSlackMarkdown(client as never, {
      channel: "C123",
      ts: "1713000000.000100",
      markdown: "Fixed **copy**",
    });

    expect(client.updateMessage).toHaveBeenCalledWith({
      channel: "C123",
      ts: "1713000000.000100",
      text: "Fixed *copy*",
      blocks: [{ type: "markdown", text: "Fixed **copy**" }],
    });
  });

  it("clears the blocks and sends mrkdwn when Slack refuses them", async () => {
    const client = fakeClient({
      updateMessage: mock(async (input: Record<string, unknown>) => {
        if (Array.isArray(input.blocks) && input.blocks.length > 0) {
          throw new SlackApiError("chat.update", "invalid_blocks");
        }
        return { channel: "C123", ts: "1713000000.000100", messageId: "1713000000.000100", raw: { ok: true } };
      }),
    });
    await updateSlackMarkdown(client as never, {
      channel: "C123",
      ts: "1713000000.000100",
      markdown: "Fixed **copy**",
    });

    expect(client.updateMessage).toHaveBeenLastCalledWith({
      channel: "C123",
      ts: "1713000000.000100",
      text: "Fixed *copy*",
      blocks: [],
    });
  });
});
