import type { RuntimeLaunchPrompt } from "./message-types.js";

const SESSION_SURFACE_PREFIX = /^\[session surfaces?\][^\n]*(?:\n|$)/i;
const CURRENT_SESSION_SURFACE_LINE = /^\[session surface\][^\n]*/i;

export function buildSessionSurfaceHint(source: RuntimeLaunchPrompt["source"]): string {
  if (source) {
    const channel = formatChannelName(source.channel);
    const place = source.threadId ? `${channel} thread` : `${channel} chat`;
    return `[session surface] This turn came from a ${place}. A normal reply returns there.`;
  }

  return "[session surface] This turn has no inbound chat. A normal reply uses the session default, if available.";
}

export function withSessionSurfaceHint(prompt: RuntimeLaunchPrompt): RuntimeLaunchPrompt {
  if (prompt._sessionSurfaceHint) return prompt;

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
