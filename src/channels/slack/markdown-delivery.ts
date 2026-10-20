/**
 * Post agent Markdown to Slack as Block Kit (see markdown-layout.ts).
 *
 * Long documents go to a canvas the channel can read, or, when the app cannot
 * make one (no `canvases:write`, a free workspace, a DM), to a file in the
 * same thread; failing both, they stay in the messages. When Slack refuses the
 * blocks, the same Markdown goes out as mrkdwn split where Slack would not cut.
 */

import { logger } from "../../utils/logger.js";
import type { SlackBlockKitBlock } from "./block-kit.js";
import type { SlackPostMessageResult, SlackWebApiClient } from "./client.js";
import {
  planSlackMessageLayout,
  renderSlackMarkdownMessages,
  renderSlackMrkdwnParts,
  SLACK_MRKDWN_PART_LIMIT,
  type SlackLayoutDocument,
  type SlackRenderedMessage,
  slackDocumentFileLine,
  slackDocumentLinkLine,
} from "./markdown-layout.js";
import { markdownToSlackMrkdwn } from "./mrkdwn.js";
import { slackClientMessageId } from "./client-message-id.js";
import { isSlackInvalidBlocksError } from "./thread-card.js";

const log = logger.child("channels:slack:markdown");

export type SlackMarkdownClient = Pick<
  SlackWebApiClient,
  "postMessage" | "updateMessage" | "canvasesCreate" | "canvasesAccessSet" | "canvasesDelete" | "filesInfo"
> &
  Partial<Pick<SlackWebApiClient, "uploadTextFile">>;

export interface SlackMarkdownPostInput {
  readonly channel: string;
  readonly markdown: string;
  readonly threadTs?: string;
  /** Seeds Slack's client_msg_id duplicate suppression; the first message keeps it as is. */
  readonly idempotencyKey?: string;
  /** False keeps everything in the messages: no canvas, no file. */
  readonly allowDocuments?: boolean;
  readonly unfurlLinks?: boolean;
}

export interface SlackMarkdownDocumentOutcome {
  readonly title: string;
  readonly delivery: "canvas" | "file" | "inline";
  readonly id?: string;
}

export interface SlackMarkdownPostResult {
  /** The first message: the reply's receipt and what later edits address. */
  readonly first: SlackPostMessageResult;
  readonly messages: readonly SlackPostMessageResult[];
  readonly documents: readonly SlackMarkdownDocumentOutcome[];
}

export async function postSlackMarkdown(
  client: SlackMarkdownClient,
  input: SlackMarkdownPostInput,
): Promise<SlackMarkdownPostResult> {
  const plan = planSlackMessageLayout(input.markdown, { allowDocuments: input.allowDocuments });
  let body = plan.body;
  const outcomes: SlackMarkdownDocumentOutcome[] = [];
  const files: SlackLayoutDocument[] = [];

  for (const document of plan.documents) {
    const canvas = await publishSlackCanvas(client, input.channel, document).catch((error) => {
      log.info("Slack canvas unavailable for a long document", { channel: input.channel, error: errorMessage(error) });
      return undefined;
    });
    if (canvas) {
      body = body.replace(document.placeholder, () => slackDocumentLinkLine(document, canvas.url));
      outcomes.push({ title: document.title, delivery: "canvas", id: canvas.id });
      continue;
    }
    if (client.uploadTextFile) {
      body = body.replace(document.placeholder, () => slackDocumentFileLine(document));
      files.push(document);
      continue;
    }
    body = body.replace(document.placeholder, () => document.inline);
    outcomes.push({ title: document.title, delivery: "inline" });
  }

  const rendered = renderSlackMarkdownMessages(body);
  if (rendered.length === 0) throw new Error("Slack text is required");
  const messages: SlackPostMessageResult[] = [];
  for (const [index, message] of rendered.entries()) {
    messages.push(...(await postRenderedMessage(client, input, message, partKey(input.idempotencyKey, index))));
  }

  for (const document of files) {
    try {
      const uploaded = await client.uploadTextFile!({
        channel: input.channel,
        ...(input.threadTs ? { threadTs: input.threadTs } : {}),
        filename: document.filename,
        title: document.title,
        content: document.content,
      });
      outcomes.push({ title: document.title, delivery: "file", id: uploaded.fileId });
    } catch (error) {
      log.warn("Slack file upload failed for a long document; sending it as messages", {
        channel: input.channel,
        error: errorMessage(error),
      });
      for (const [index, message] of renderSlackMarkdownMessages(document.inline).entries()) {
        const key = partKey(input.idempotencyKey, `doc:${document.filename}:${index}`);
        messages.push(...(await postRenderedMessage(client, input, message, key)));
      }
      outcomes.push({ title: document.title, delivery: "inline" });
    }
  }

  return { first: messages[0]!, messages, documents: outcomes };
}

/**
 * Post text already in mrkdwn (jobs queued before Markdown rendering existed),
 * split between blocks when it is long enough for Slack to cut it itself.
 */
export async function postSlackMrkdwn(
  client: Pick<SlackWebApiClient, "postMessage">,
  input: Omit<SlackMarkdownPostInput, "markdown" | "allowDocuments"> & { readonly text: string },
): Promise<SlackMarkdownPostResult> {
  const parts =
    input.text.length > SLACK_MRKDWN_PART_LIMIT ? renderSlackMrkdwnParts(input.text, { converted: true }) : [];
  const texts = parts.length > 0 ? parts : [input.text];
  const messages: SlackPostMessageResult[] = [];
  for (const [index, text] of texts.entries()) {
    messages.push(await post(client, input, { text }, partKey(input.idempotencyKey, index)));
  }
  return { first: messages[0]!, messages, documents: [] };
}

/**
 * Replace one message's content with `markdown`. An edit cannot add messages,
 * so content that needs more than one goes out as mrkdwn in the one message.
 */
export async function updateSlackMarkdown(
  client: Pick<SlackWebApiClient, "updateMessage">,
  input: { readonly channel: string; readonly ts: string; readonly markdown: string },
): Promise<SlackPostMessageResult> {
  const rendered = renderSlackMarkdownMessages(input.markdown);
  const mrkdwn = () =>
    // An empty `blocks` clears the blocks a Markdown post left; without it Slack keeps them.
    client.updateMessage({
      channel: input.channel,
      ts: input.ts,
      text: markdownToSlackMrkdwn(input.markdown),
      blocks: [],
    });
  const only = rendered.length === 1 ? rendered[0] : undefined;
  if (!only) return mrkdwn();
  try {
    return await client.updateMessage({ channel: input.channel, ts: input.ts, text: only.text, blocks: only.blocks });
  } catch (error) {
    if (!isSlackInvalidBlocksError(error)) throw error;
    log.warn("Slack refused the Markdown blocks of an edit; sending mrkdwn", { error: errorMessage(error) });
    return mrkdwn();
  }
}

async function postRenderedMessage(
  client: SlackMarkdownClient,
  input: SlackMarkdownPostInput,
  message: SlackRenderedMessage,
  key: string | undefined,
): Promise<SlackPostMessageResult[]> {
  try {
    return [await post(client, input, { text: message.text, blocks: message.blocks }, key)];
  } catch (error) {
    if (!isSlackInvalidBlocksError(error)) throw error;
    log.warn("Slack refused the Markdown blocks; sending mrkdwn", {
      channel: input.channel,
      error: errorMessage(error),
    });
  }
  const results: SlackPostMessageResult[] = [];
  for (const [index, text] of renderSlackMrkdwnParts(message.markdown).entries()) {
    results.push(await post(client, input, { text }, partKey(key, `mrkdwn:${index}`)));
  }
  return results;
}

function post(
  client: Pick<SlackWebApiClient, "postMessage">,
  input: Pick<SlackMarkdownPostInput, "channel" | "threadTs" | "unfurlLinks">,
  content: { readonly text: string; readonly blocks?: readonly SlackBlockKitBlock[] },
  key: string | undefined,
): Promise<SlackPostMessageResult> {
  return client.postMessage({
    channel: input.channel,
    text: content.text,
    ...(content.blocks ? { blocks: content.blocks } : {}),
    ...(input.threadTs ? { threadTs: input.threadTs } : {}),
    ...(key ? { clientMsgId: slackClientMessageId(key) } : {}),
    ...(input.unfurlLinks === false ? { unfurlLinks: false, unfurlMedia: false } : {}),
  });
}

/** A canvas the channel can read, and its link. Deleted again when it cannot be shared. */
async function publishSlackCanvas(
  client: SlackMarkdownClient,
  channel: string,
  document: SlackLayoutDocument,
): Promise<{ id: string; url: string } | undefined> {
  const created = await client.canvasesCreate({ title: document.title, markdown: document.content });
  const id = created.canvas_id;
  if (!id) return undefined;
  try {
    await client.canvasesAccessSet({ canvasId: id, accessLevel: "read", channelIds: [channel] });
    const info = await client.filesInfo({ file: id });
    const file = info.file as { permalink?: unknown } | undefined;
    const url = typeof file?.permalink === "string" ? file.permalink : undefined;
    if (!url) throw new Error("Slack files.info returned no permalink for the canvas");
    return { id, url };
  } catch (error) {
    await client.canvasesDelete({ canvasId: id }).catch(() => undefined);
    throw error;
  }
}

/** The first part keeps the caller's key, so a redelivered job is still a duplicate to Slack. */
function partKey(key: string | undefined, part: number | string): string | undefined {
  if (!key) return undefined;
  return part === 0 ? key : `${key}:part:${part}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
