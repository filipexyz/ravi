// The owner's private data in a chat other people read (spec cli/connectors,
// "Owner read confirmation").
//
// The owner's own turn counts wherever they write, shared session or not
// (owner decision, 26/11: "se eu escrevo eu quero que esse dado venha,
// independente de onde estar"). The data then lands in the chat the answer
// goes to. When people outside the organization may read that chat (a group,
// a channel, a direct chat with someone else), a private read waits for the
// owner to confirm in that chat: `confirmo <code>`, from the owner's own
// verified message, holds there for ten minutes.
//
// Inside the organization means a direct chat (or a thread inside one) whose
// person is tagged `permission-owner` or linked to this installation by
// `ravi link`, the same test the Knowledge exposure gate uses. Ravi does not
// know everyone who reads a group or a channel, so those always ask.
//
// Channel-free: chats, participants and canonical messages only. The code is
// a short hash of (chat, owner, ten-minute window), so nothing is stored.

import { createHash } from "node:crypto";
import { readCachedActorBinding } from "../cloud-auth/actor-bindings.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { readCloudCredentials } from "../cloud-auth/storage.js";
import { findContactsByTag } from "../contacts.js";
import { dmContactForChat } from "../knowledge/contacts.js";
import { OWNER_CONTACT_TAG } from "../knowledge/owner.js";
import { dbGetThreadParentChat, dbListChatsByRef, dbListContactChatMessagesSince } from "../router/router-db.js";
import type { ConnectorTurn } from "./connector-turn.js";

/** How long a confirmation holds in its chat, and the width of one code window. */
export const OWNER_CONFIRMATION_WINDOW_MS = 10 * 60_000;

const CONFIRMATION_PATTERN = /\b(?:confirmo|confirm)\s+([0-9a-f]{6})\b/gi;

export interface OwnerReadExposureDeps {
  now?: () => number;
  /** Tagged `permission-owner`, or linked to this installation (`ravi link`). */
  isInsideContact?: (contactId: string) => boolean;
  /** The person of a direct chat, or of the direct chat a thread lives in; null for anything else. */
  directChatContact?: (chatRef: string) => string | null;
  /** Texts of the contact's own messages in the chat since a time. */
  contactMessagesSince?: (input: { chatRef: string; contactId: string; sinceMs: number }) => string[];
}

export type OwnerReadExposure =
  | { ok: true; reason: "not_owner_chat" | "inside" | "confirmed" }
  | { ok: false; error: CloudAuthError; code: string | null };

/**
 * Whether the owner's private data may go to the chat this turn answers in.
 * Only an owner's own turn in a chat is checked; the terminal, relays and
 * routines keep their own rules.
 */
export function ownerReadExposure(turn: ConnectorTurn, deps: OwnerReadExposureDeps = {}): OwnerReadExposure {
  if (turn.speaker.kind !== "owner") return { ok: true, reason: "not_owner_chat" };
  const contactId = turn.speaker.contactId?.trim();
  if (!contactId) return { ok: true, reason: "not_owner_chat" };
  const chatRef = turn.answerChat?.chatId?.trim();
  if (!chatRef) return { ok: false, error: unknownChat(), code: null };
  try {
    const person = (deps.directChatContact ?? defaultDirectChatContact)(chatRef);
    if (person && (deps.isInsideContact ?? defaultIsInsideContact)(person)) return { ok: true, reason: "inside" };
    const now = (deps.now ?? Date.now)();
    if (hasRecentConfirmation(chatRef, contactId, now, deps)) return { ok: true, reason: "confirmed" };
    const code = ownerConfirmationCode(chatRef, contactId, windowOf(now));
    return { ok: false, error: confirmationRequired(code), code };
  } catch (error) {
    return unreadableChat(error);
  }
}

/** The chat or its readers could not be read: no private data goes there. */
function unreadableChat(cause: unknown): OwnerReadExposure {
  return { ok: false, error: unknownChat(cause), code: null };
}

/** The code the owner types to confirm in this chat, for one ten-minute window. */
export function ownerConfirmationCode(chatRef: string, contactId: string, window: number): string {
  return createHash("sha256")
    .update(`ravi-owner-read-confirmation:v1|${chatRef}|${contactId}|${window}`)
    .digest("hex")
    .slice(0, 6);
}

function windowOf(now: number): number {
  return Math.floor(now / OWNER_CONFIRMATION_WINDOW_MS);
}

/**
 * The owner's own message in this chat, in the last ten minutes, carrying the
 * code of this window or the one before it (a code asked for near the end of a
 * window stays good for the reply).
 */
function hasRecentConfirmation(chatRef: string, contactId: string, now: number, deps: OwnerReadExposureDeps): boolean {
  const current = windowOf(now);
  const codes = new Set([
    ownerConfirmationCode(chatRef, contactId, current),
    ownerConfirmationCode(chatRef, contactId, current - 1),
  ]);
  const texts = (deps.contactMessagesSince ?? defaultContactMessagesSince)({
    chatRef,
    contactId,
    sinceMs: now - OWNER_CONFIRMATION_WINDOW_MS,
  });
  for (const text of texts) {
    for (const match of text.matchAll(CONFIRMATION_PATTERN)) {
      if (codes.has((match[1] ?? "").toLowerCase())) return true;
    }
  }
  return false;
}

function confirmationRequired(code: string): CloudAuthError {
  const chatLine = `People outside the organization can read this chat. To bring that here, reply: confirmo ${code}`;
  const chatLinePt = `Este chat tem gente de fora da organização. Para eu trazer isso aqui, responda: confirmo ${code}`;
  return new CloudAuthError(
    "OWNER_CONFIRMATION_REQUIRED",
    `The owner asked for private data in a chat that people outside the organization can read (a group, a channel or a direct chat with someone else). It comes only after the owner confirms in this chat. Reply: "${chatLinePt}", then run the same command again once the owner has answered with the code.`,
    {
      exitCode: 3,
      details: {
        source: "owner-read-confirmation",
        chatLine,
        chatLinePt,
        replyTo: "same_chat",
        confirmationCode: code,
      },
    },
  );
}

function unknownChat(cause?: unknown): CloudAuthError {
  const chatLine = "I can't tell who reads this chat, so I won't bring that here. Ask me in our private chat.";
  const chatLinePt = "Não sei quem lê este chat, então não trago isso aqui. Me peça no nosso chat privado.";
  return new CloudAuthError(
    "OWNER_CONFIRMATION_REQUIRED",
    `Ravi could not tell which chat this answer goes to, or who reads it, so the owner's private data stays out of it. Reply: "${chatLinePt}"`,
    {
      exitCode: 3,
      ...(cause === undefined ? {} : { cause }),
      details: { source: "owner-read-confirmation", chatLine, chatLinePt, replyTo: "same_chat" },
    },
  );
}

function defaultDirectChatContact(chatRef: string): string | null {
  const direct = dmContactForChat({ chatId: chatRef, channel: null });
  if (direct) return direct;
  const chats = dbListChatsByRef({ ref: chatRef, limit: 10 });
  if (chats.length !== 1) return null;
  const chat = chats[0]!;
  if (chat.chatType !== "thread") return null;
  const parent = dbGetThreadParentChat(chat);
  if (!parent || parent.chatType !== "dm") return null;
  return dmContactForChat({ chatId: parent.id, channel: null });
}

function defaultIsInsideContact(contactId: string): boolean {
  if (findContactsByTag(OWNER_CONTACT_TAG).some((contact) => contact.id === contactId)) return true;
  const installationId = readCloudCredentials()?.installationId ?? null;
  // Without a login no binding can be checked against this installation.
  if (!installationId) return false;
  return readCachedActorBinding(contactId, process.env, Date.now(), { requireInstallationId: installationId }) !== null;
}

function defaultContactMessagesSince(input: { chatRef: string; contactId: string; sinceMs: number }): string[] {
  const chatIds = new Set(dbListChatsByRef({ ref: input.chatRef, limit: 10 }).map((chat) => chat.id));
  const texts: string[] = [];
  for (const chatId of chatIds) {
    for (const message of dbListContactChatMessagesSince({
      chatId,
      contactId: input.contactId,
      sinceMs: input.sinceMs,
    })) {
      const text = message.content?.text;
      if (typeof text === "string" && text.trim()) texts.push(text);
    }
  }
  return texts;
}
