import type { RuntimeLaunchPrompt } from "./message-types.js";
import { isSessionRelayTurn } from "./turn-origin.js";

export const CLI_SURFACE_HINT =
  "[session surface] This turn came from the CLI. A normal reply returns to the waiting CLI.";

export const SESSION_RELAY_SURFACE_HINT =
  "[session surface] This turn has no inbound chat. A normal reply stays on this session.";

export const SOURCELESS_SURFACE_HINT =
  "[session surface] This turn has no inbound chat. A normal reply uses the session default, if available.";

const SESSION_SURFACE_PREFIX = /^\[session surfaces?\][^\n]*(?:\n|$)/i;
const CURRENT_SESSION_SURFACE_LINE = /^\[session surface\][^\n]*/i;

export function buildSessionSurfaceHint(
  source: RuntimeLaunchPrompt["source"],
  options: { cliDestination?: boolean; sessionRelay?: boolean } = {},
): string {
  if (hasInboundChatSource(source)) {
    const channel = formatChannelName(source.channel);
    const place = source.threadId ? `${channel} thread` : `${channel} chat`;
    return `[session surface] This turn came from a ${place}. A normal reply returns there.`;
  }

  if (options.cliDestination) {
    return CLI_SURFACE_HINT;
  }

  if (options.sessionRelay) {
    return SESSION_RELAY_SURFACE_HINT;
  }

  return SOURCELESS_SURFACE_HINT;
}

/**
 * Persist the surface header on the user row only for real inbound chat.
 * Operator CLI-only and HTTP `sessions.send` keep raw `user.text`.
 */
export function persistSessionSurfaceHintOnUserRow(prompt: RuntimeLaunchPrompt): boolean {
  if (prompt._cliDestination) return false;
  if (isSessionRelayTurn(prompt)) return false;
  return hasInboundChatSource(prompt.source);
}

export function resolveRuntimePromptText(prompt: Pick<RuntimeLaunchPrompt, "prompt" | "_runtimePrompt">): string {
  return prompt._runtimePrompt ?? prompt.prompt;
}

export function resolvePersistedUserText(prompt: Pick<RuntimeLaunchPrompt, "prompt">): string {
  return prompt.prompt;
}

export function withSessionSurfaceHint(prompt: RuntimeLaunchPrompt): RuntimeLaunchPrompt {
  if (prompt._sessionSurfaceHint) return prompt;

  const persistOnUserRow = persistSessionSurfaceHintOnUserRow(prompt);
  const hintSource = persistOnUserRow ? prompt.source : undefined;
  const hint = buildSessionSurfaceHint(hintSource, {
    cliDestination: prompt._cliDestination,
    sessionRelay: isSessionRelayTurn(prompt),
  });
  const body = persistOnUserRow ? stripSessionSurfacePrefixes(prompt.prompt) : prompt.prompt;
  const runtimePrompt = `${hint}\n${body}`;

  return {
    ...prompt,
    prompt: persistOnUserRow ? runtimePrompt : prompt.prompt,
    _runtimePrompt: persistOnUserRow ? undefined : runtimePrompt,
    _sessionSurfaceHint: true,
    _sessionSurfaceHintText: hint,
  };
}

/** Keep one surface instruction when same-surface messages share a turn. */
export function combineSessionSurfacePromptContents(contents: string[]): string {
  const hint = contents.map((content) => content.match(CURRENT_SESSION_SURFACE_LINE)?.[0]).find(Boolean);
  const body = contents.map(stripSessionSurfacePrefixes).join("\n\n");
  return hint ? `${hint}\n${body}` : body;
}

function hasInboundChatSource(
  source: RuntimeLaunchPrompt["source"],
): source is NonNullable<RuntimeLaunchPrompt["source"]> {
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
