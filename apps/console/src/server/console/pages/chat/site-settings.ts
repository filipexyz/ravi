// Page Chat settings for one site, stored under `page_sites.metadata_json.pageChat`.
// The organization feature `console.pages.chat` decides whether Page Chat exists
// at all; these settings only let a site owner turn it off for a site and shape
// the assistant's name, voice, language and instructions.

import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";

/** gpt-live-1 voices. The Brazilian Portuguese ones come first. */
export const PAGE_CHAT_VOICES = [
  "bossa",
  "tempo",
  "marin",
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "beacon",
  "delta",
  "cinder",
] as const;

export type PageChatVoice = (typeof PAGE_CHAT_VOICES)[number];

export const PAGE_CHAT_DEFAULT_VOICE: PageChatVoice = "bossa";
export const PAGE_CHAT_DEFAULT_LANGUAGE = "pt-BR";
export const PAGE_CHAT_ASSISTANT_NAME_MAX = 60;
export const PAGE_CHAT_INSTRUCTIONS_MAX = 2_000;

/** When the agent answers in a shared room (K4): only when called, or to every message. */
export const PAGE_CHAT_REPLY_POLICIES = ["mention", "always"] as const;
export type PageChatReplyPolicy = (typeof PAGE_CHAT_REPLY_POLICIES)[number];

/** An AI Gateway model id, such as `anthropic/claude-sonnet-5.5`. */
export const PAGE_CHAT_TEXT_MODEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}\/[a-z0-9][a-z0-9.:-]{0,80}$/;

/** The installation agent the text chat may ask (F4): an agent of the org's directory that takes requests. */
export type PageChatRaviAgent = { installationId: string; agentId: string };

export type PageChatSiteSettings = {
  enabled: boolean;
  assistantName: string | null;
  voice: PageChatVoice;
  language: string;
  instructions: string | null;
  /** The text chat (panel and `<ravi-chat>`); voice stays under `enabled`. */
  text: boolean;
  replyPolicy: PageChatReplyPolicy;
  /** Null: the platform default model. */
  textModel: string | null;
  raviAgent: PageChatRaviAgent | null;
};

export const PAGE_CHAT_DEFAULT_SITE_SETTINGS: PageChatSiteSettings = Object.freeze({
  enabled: true,
  assistantName: null,
  voice: PAGE_CHAT_DEFAULT_VOICE,
  language: PAGE_CHAT_DEFAULT_LANGUAGE,
  instructions: null,
  text: true,
  replyPolicy: "mention",
  textModel: null,
  raviAgent: null,
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isPageChatVoice(value: unknown): value is PageChatVoice {
  return typeof value === "string" && (PAGE_CHAT_VOICES as readonly string[]).includes(value);
}

/** Reads the stored settings, falling back to the default for anything missing or malformed. */
export function parsePageChatSiteSettings(metadataJson: unknown): PageChatSiteSettings {
  const metadata = record(metadataJson);
  const stored = record(metadata.pageChat);
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : PAGE_CHAT_DEFAULT_SITE_SETTINGS.enabled,
    assistantName: boundedText(stored.assistantName, PAGE_CHAT_ASSISTANT_NAME_MAX),
    voice: isPageChatVoice(stored.voice) ? stored.voice : PAGE_CHAT_DEFAULT_VOICE,
    language:
      typeof stored.language === "string" && LANGUAGE_PATTERN.test(stored.language)
        ? stored.language
        : PAGE_CHAT_DEFAULT_LANGUAGE,
    instructions: boundedText(stored.instructions, PAGE_CHAT_INSTRUCTIONS_MAX),
    text: typeof stored.text === "boolean" ? stored.text : PAGE_CHAT_DEFAULT_SITE_SETTINGS.text,
    replyPolicy: (PAGE_CHAT_REPLY_POLICIES as readonly unknown[]).includes(stored.replyPolicy)
      ? (stored.replyPolicy as PageChatReplyPolicy)
      : PAGE_CHAT_DEFAULT_SITE_SETTINGS.replyPolicy,
    textModel:
      typeof stored.textModel === "string" && PAGE_CHAT_TEXT_MODEL_PATTERN.test(stored.textModel) ? stored.textModel : null,
    raviAgent: parseRaviAgent(stored.raviAgent),
  };
}

function parseRaviAgent(value: unknown): PageChatRaviAgent | null {
  const agent = record(value);
  return typeof agent.installationId === "string" &&
    UUID_PATTERN.test(agent.installationId) &&
    typeof agent.agentId === "string" &&
    agent.agentId.trim().length > 0 &&
    agent.agentId.length <= 120
    ? { installationId: agent.installationId, agentId: agent.agentId.trim() }
    : null;
}

const settingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    assistantName: z.string().trim().min(1).max(PAGE_CHAT_ASSISTANT_NAME_MAX).nullable().optional(),
    voice: z.enum(PAGE_CHAT_VOICES).optional(),
    language: z.string().regex(LANGUAGE_PATTERN).max(35).optional(),
    instructions: z.string().trim().min(1).max(PAGE_CHAT_INSTRUCTIONS_MAX).nullable().optional(),
    text: z.boolean().optional(),
    replyPolicy: z.enum(PAGE_CHAT_REPLY_POLICIES).optional(),
    textModel: z.string().trim().regex(PAGE_CHAT_TEXT_MODEL_PATTERN).nullable().optional(),
    raviAgent: z
      .object({ installationId: z.string().uuid(), agentId: z.string().trim().min(1).max(120) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type PageChatSiteSettingsPatch = z.infer<typeof settingsPatchSchema>;

export function parsePageChatSiteSettingsPatch(body: unknown): PageChatSiteSettingsPatch {
  const parsed = settingsPatchSchema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ConsoleApiError(400, {
      error: "payload_invalid",
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((issue) => [issue.path.join(".") || "body", issue.message]),
      ),
    });
  }
  return parsed.data;
}

/**
 * Applies a patch and returns the site's whole new `metadata_json`, keeping
 * every key other than `pageChat` untouched. `null` clears a text field.
 */
export function applyPageChatSiteSettingsPatch(
  metadataJson: unknown,
  patch: PageChatSiteSettingsPatch,
): { metadataJson: Record<string, unknown>; settings: PageChatSiteSettings } {
  const current = parsePageChatSiteSettings(metadataJson);
  const settings: PageChatSiteSettings = {
    enabled: patch.enabled ?? current.enabled,
    assistantName: patch.assistantName === undefined ? current.assistantName : patch.assistantName,
    voice: patch.voice ?? current.voice,
    language: patch.language ?? current.language,
    instructions: patch.instructions === undefined ? current.instructions : patch.instructions,
    text: patch.text ?? current.text,
    replyPolicy: patch.replyPolicy ?? current.replyPolicy,
    textModel: patch.textModel === undefined ? current.textModel : patch.textModel,
    raviAgent: patch.raviAgent === undefined ? current.raviAgent : patch.raviAgent,
  };
  return {
    metadataJson: { ...record(metadataJson), pageChat: settings },
    settings,
  };
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
