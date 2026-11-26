import type { ContextRecord, ContextSource } from "../router/router-db.js";

/**
 * The turn's own origin: the only source a command, follow, delivery or durable grant may use as a destination.
 * A relayed turn borrows its caller's origin for approval cards only; that origin is never stored in `source`
 * (see `approvalOrigin`), and an older record that still carries the `approvalSourceOnly` marker is filtered here.
 */
export function runtimeCommandSource(context: Pick<ContextRecord, "source" | "metadata">) {
  return context.metadata?.approvalSourceOnly === true ? undefined : context.source;
}

/** Where an approval card for this context goes: its own origin, else the origin it borrowed from its caller. */
export function approvalOrigin(context: Pick<ContextRecord, "source" | "metadata">): ContextSource | undefined {
  const own = runtimeCommandSource(context);
  if (own) return own;
  return readBorrowedOrigin(context.metadata?.approvalSource) ?? context.source;
}

function readBorrowedOrigin(value: unknown): ContextSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const text = (key: string) =>
    typeof candidate[key] === "string" && candidate[key] ? (candidate[key] as string) : undefined;
  const channel = text("channel");
  const chatId = text("chatId");
  // Older hints carry an empty account id; the channel and chat are what route the card.
  if (!channel || !chatId || typeof candidate.accountId !== "string") return undefined;
  const threadId = text("threadId");
  const instanceId = text("instanceId");
  const canonicalChatId = text("canonicalChatId");
  return {
    channel,
    accountId: candidate.accountId,
    chatId,
    ...(threadId ? { threadId } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(canonicalChatId ? { canonicalChatId } : {}),
  };
}
