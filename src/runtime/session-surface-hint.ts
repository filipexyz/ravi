import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimeTurnOrigin } from "./turn-origin.js";

export const CLI_SURFACE_HINT =
  "[session surface] This turn came from the CLI. A normal reply returns to the waiting CLI.";

export const SOURCELESS_SURFACE_HINT =
  "[session surface] This turn has no inbound chat. A normal reply uses the session default, if available.";

const SESSION_SURFACE_PREFIX = /^\[session surfaces?\][^\n]*(?:\n|$)/i;
const CURRENT_SESSION_SURFACE_LINE = /^\[session surface\][^\n]*/i;

export function buildSessionSurfaceHint(
  source: RuntimeLaunchPrompt["source"],
  options: { cliDestination?: boolean } = {},
): string {
  if (hasInboundChatSource(source)) {
    const channel = formatChannelName(source.channel);
    const place = source.threadId ? `${channel} thread` : `${channel} chat`;
    return `[session surface] This turn came from a ${place}. A normal reply returns there.`;
  }

  if (options.cliDestination) {
    return CLI_SURFACE_HINT;
  }

  return SOURCELESS_SURFACE_HINT;
}

/**
 * Prefix `[session surface]` onto persisted user text only for real inbound
 * chat turns. Operator CLI-only and HTTP `sessions.send` stay raw: those
 * rows are the operator's text, not a channel envelope.
 */
export function shouldPrefixSessionSurfaceHint(prompt: RuntimeLaunchPrompt): boolean {
  if (prompt._sessionSurfaceHint) return false;
  if (prompt._cliDestination) return false;
  if (isSessionRelayOperatorTurn(prompt)) return false;
  return hasInboundChatSource(prompt.source);
}

export function withSessionSurfaceHint(prompt: RuntimeLaunchPrompt): RuntimeLaunchPrompt {
  if (prompt._sessionSurfaceHint) return prompt;
  if (!shouldPrefixSessionSurfaceHint(prompt)) {
    return { ...prompt, _sessionSurfaceHint: true };
  }

  const content = stripSessionSurfacePrefixes(prompt.prompt);

  return {
    ...prompt,
    prompt: `${buildSessionSurfaceHint(prompt.source)}\n${content}`,
    _sessionSurfaceHint: true,
  };
}

/** Keep one surface instruction when same-surface messages share a turn. */
export function combineSessionSurfacePromptContents(contents: string[]): string {
  const hint = contents.map((content) => content.match(CURRENT_SESSION_SURFACE_LINE)?.[0]).find(Boolean);
  const body = contents.map(stripSessionSurfacePrefixes).join("\n\n");
  return hint ? `${hint}\n${body}` : body;
}

function isSessionRelayOperatorTurn(prompt: RuntimeLaunchPrompt): boolean {
  return resolveRuntimeTurnOrigin(prompt._turnOrigin)?.producer === "session-relay";
}

function hasInboundChatSource(source: RuntimeLaunchPrompt["source"]): source is NonNullable<
  RuntimeLaunchPrompt["source"]
> {
  return Boolean(source?.channel?.trim() && source?.chatId?.trim());
}

function stripSessionSurfacePrefixes(content: string): string {
  let stripped = content;
  while (SESSION_SURFACE_PREFIX.test(stripped)) {
    stripped = stripped.replace(SESSION_SURFACE_PREFIX, "");
  }
  return stripped;
}

function formatChannelName(channel: string): string {
  const normalized = channel.trim().toLowerCase();
  if (normalized.startsWith("whatsapp")) return "WhatsApp";
  const known: Record<string, string> = {
    slack: "Slack",
    telegram: "Telegram",
  };
  return known[normalized] ?? normalized.replace(/(^|[-_ ])\w/g, (match) => match.toUpperCase());
}
