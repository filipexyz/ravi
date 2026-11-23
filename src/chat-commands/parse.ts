/**
 * The grammar of a chat command, whichever channel it was typed in:
 * `help | status | threads | close <thread> | close idle [12h] | stop [thread]`.
 *
 * Pure: no channel, no I/O. A channel adapter hands over the text that follows
 * its own command word and gets back what was asked.
 *
 * Spec: permissions/chat-commands.
 */

export const CHAT_COMMAND_DEFAULT_IDLE_HOURS = 12;
export const CHAT_COMMAND_MAX_IDLE_HOURS = 24 * 30;

/** The subcommands that act: each needs a person with authority over the session of the chat. */
export type ChatCommandAction = "status" | "threads" | "close" | "close_idle" | "stop";

export type ChatCommandParse =
  | { readonly kind: "status" }
  | { readonly kind: "threads" }
  /** `stop` interrupts the turn of the chat's session; `stop <thread>` the turn of that thread's own session. */
  | { readonly kind: "stop"; readonly threadRef?: string }
  | { readonly kind: "close"; readonly threadRef: string }
  | { readonly kind: "close_idle"; readonly hours: number }
  | { readonly kind: "help" }
  | { readonly kind: "usage"; readonly command: "close" }
  | { readonly kind: "unknown"; readonly word: string };

export type ChatCommandStaticParse = Extract<ChatCommandParse, { kind: "help" | "usage" | "unknown" }>;
export type ChatCommandActionParse = Extract<ChatCommandParse, { kind: ChatCommandAction }>;

/** Subcommands whose answer is static text: no session, no person and no authority involved. */
export function isChatCommandStatic(parse: ChatCommandParse): parse is ChatCommandStaticParse {
  return parse.kind === "help" || parse.kind === "usage" || parse.kind === "unknown";
}

export function isChatCommandAction(parse: ChatCommandParse): parse is ChatCommandActionParse {
  return !isChatCommandStatic(parse);
}

function foldWord(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Parse what follows the command word. Words are matched without accents or case; a thread ref keeps its case. */
export function parseChatCommandText(text: string): ChatCommandParse {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0];
  if (!first) return { kind: "help" };
  switch (foldWord(first)) {
    case "help":
    case "?":
      return { kind: "help" };
    case "status":
      return { kind: "status" };
    case "threads":
      return { kind: "threads" };
    case "stop": {
      const target = tokens[1];
      return target ? { kind: "stop", threadRef: target } : { kind: "stop" };
    }
    case "close": {
      const target = tokens[1];
      if (!target) return { kind: "usage", command: "close" };
      if (foldWord(target) === "idle") return parseIdleClose(tokens[2]);
      return { kind: "close", threadRef: target };
    }
    default:
      return { kind: "unknown", word: first.slice(0, 40) };
  }
}

function parseIdleClose(rawHours: string | undefined): ChatCommandParse {
  if (rawHours === undefined) return { kind: "close_idle", hours: CHAT_COMMAND_DEFAULT_IDLE_HOURS };
  const match = /^(\d{1,3})h?$/i.exec(rawHours);
  const hours = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > CHAT_COMMAND_MAX_IDLE_HOURS) {
    return { kind: "usage", command: "close" };
  }
  return { kind: "close_idle", hours };
}
