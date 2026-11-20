/**
 * Default Slack App Home (spec channels/slack/block-kit, "App Home padrão").
 *
 * Slack keeps an app's Home tab empty until the app publishes a view for that
 * user with `views.publish`: an app that turns the tab on and never publishes
 * leaves it blank and loading. Ravi answers `app_home_opened` with this view,
 * so every agent has a valid Home with no configuration.
 *
 * Anyone in the workspace can open the tab, so the view carries only what is
 * public about the agent: its display name and the directory description set
 * with `ravi agents set <id> description`. Never its instructions or files.
 */

import { createHash } from "node:crypto";
import type { SlackSocketEnvelope } from "./types.js";

/** Slack's cap on blocks in a Home tab view. */
export const SLACK_HOME_VIEW_MAX_BLOCKS = 100;
/** `private_metadata` prefix of the default Home; the rest is a fingerprint of its blocks. */
export const SLACK_DEFAULT_HOME_METADATA_PREFIX = "ravi.home.default.v1:";

const HEADER_MAX_LENGTH = 150;
/** The directory description is capped at 300 characters when it is set (`LIBRARY_AGENT_DESCRIPTION_MAX`). */
const DESCRIPTION_MAX_LENGTH = 300;
const AGENT_ID_MAX_LENGTH = 100;
const SLACK_USER_ID_RE = /^[UW][A-Z0-9]{2,}$/;

export interface SlackAppHomeOpened {
  readonly userId: string;
  /** `home` or `messages`: Slack sends the event when either tab opens. */
  readonly tab: string;
  /** `private_metadata` of the Home view this user has now, when Slack sent one. */
  readonly currentPrivateMetadata?: string;
}

export interface SlackDefaultHomeInput {
  /** The agent that answers this user's DM; absent when the app is bound to no agent. */
  readonly agentId?: string;
  readonly agentName?: string;
  readonly description?: string | null;
  /** The app's bot user, so the Home shows a real mention. */
  readonly botUserId?: string;
}

export interface SlackHomeView extends Record<string, unknown> {
  readonly type: "home";
  readonly private_metadata: string;
  readonly blocks: Record<string, unknown>[];
}

/** The `app_home_opened` event of a Socket Mode envelope, or null for any other envelope. */
export function slackAppHomeOpenedFromEnvelope(envelope: SlackSocketEnvelope): SlackAppHomeOpened | null {
  if (envelope.type !== "events_api") return null;
  const event = asRecord(asRecord(envelope.payload)?.event);
  if (event?.type !== "app_home_opened") return null;
  const userId = typeof event.user === "string" ? event.user.trim() : "";
  if (!userId) return null;
  const metadata = asRecord(event.view)?.private_metadata;
  return {
    userId,
    tab: typeof event.tab === "string" ? event.tab : "",
    ...(typeof metadata === "string" && metadata ? { currentPrivateMetadata: metadata } : {}),
  };
}

/**
 * Valid Home for any agent, configured or not: who it is, how to talk to it,
 * and an honest empty state. Seven blocks, every text within Slack's limits.
 */
export function buildSlackDefaultHomeView(input: SlackDefaultHomeInput): SlackHomeView {
  const agentId = singleLine(input.agentId ?? "");
  const name = singleLine(input.agentName ?? "") || agentId || "Ravi";
  const description = (input.description ?? "").trim();
  const mention =
    input.botUserId && SLACK_USER_ID_RE.test(input.botUserId)
      ? `<@${input.botUserId}>`
      : `*@${escapeSlackText(cutText(name, HEADER_MAX_LENGTH))}*`;
  const about = !agentId
    ? "_Este app ainda não está ligado a um agente._"
    : description
      ? escapeSlackText(cutText(description, DESCRIPTION_MAX_LENGTH))
      : "_Este agente ainda não tem descrição._";

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      block_id: "ravi_home_title",
      text: { type: "plain_text", text: cutText(name, HEADER_MAX_LENGTH), emoji: true },
    },
    { type: "section", block_id: "ravi_home_about", text: { type: "mrkdwn", text: about } },
    { type: "divider", block_id: "ravi_home_divider_contact" },
    {
      type: "section",
      block_id: "ravi_home_contact",
      text: {
        type: "mrkdwn",
        text: [
          "*Como falar comigo*",
          "• Em particular: escreva na aba *Mensagens* deste app.",
          `• Num canal em que eu esteja: mencione ${mention} na mensagem.`,
        ].join("\n"),
      },
    },
    { type: "divider", block_id: "ravi_home_divider_empty" },
    {
      type: "section",
      block_id: "ravi_home_empty",
      text: {
        type: "mrkdwn",
        text: "*Nada por aqui ainda*\nEsta é a Home padrão. Ainda não há nada configurado para você aqui.",
      },
    },
    {
      type: "context",
      block_id: "ravi_home_footer",
      elements: [
        {
          type: "mrkdwn",
          text: agentId ? `Ravi · agente \`${escapeSlackText(cutText(agentId, AGENT_ID_MAX_LENGTH))}\`` : "Ravi",
        },
      ],
    },
  ];

  const fingerprint = createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 16);
  return { type: "home", private_metadata: `${SLACK_DEFAULT_HOME_METADATA_PREFIX}${fingerprint}`, blocks };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `text` within `maxLength` UTF-16 units, cut on a character boundary, with an ellipsis when cut. */
function cutText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > maxLength - 1) break;
    kept += char;
  }
  return `${kept.trimEnd()}…`;
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
