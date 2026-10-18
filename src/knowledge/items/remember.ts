// `ravi knowledge remember` and `forget` (contract §13.2).
//
// remember: on the terminal the item is active at once. On the operator's
// direct chat it is active only when the text is in the operator's own words:
// it must appear in the authored text of the session's newest user message,
// not in a quoted reply or an audio transcript. Otherwise it is a draft the
// operator confirms from the terminal. Forwarded messages carry no marker in
// the envelope, so they read as authored (accepted residual risk).
//
// forget: archives (or, with redact, overwrites) the subject's items, deletes
// the local index rows of every chat of the subject, and records the subject
// as forgotten so the indexer, the curator and the packet never learn it again.

import { createHash } from "node:crypto";
import {
  CONTRACT_EXIT_ERROR,
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  ContractError,
} from "../../cli/agent-contract.js";
import { getRecentHistory, type Message } from "../../db.js";
import { dbListChatsByRef } from "../../router/router-db.js";
import { platformChatKeysForContact } from "../contacts.js";
import { parseInboundContent } from "../envelope.js";
import { dropGapsForContact } from "../gaps/store.js";
import { KNOWLEDGE_ISSUE_TEXT } from "../errors.js";
import { deleteLocalRowsForChats } from "../store/local-index.js";
import { markSubjectForgotten } from "../store/forgotten.js";
import { foldKnowledgeText } from "../text.js";
import type { KnowledgeTurn } from "../types.js";
import {
  KNOWLEDGE_DRAFT_TTL_MS,
  KNOWLEDGE_ITEM_KINDS,
  activateKnowledgeDraft,
  archiveItemsForSubject,
  archiveKnowledgeItem,
  getKnowledgeItem,
  insertKnowledgeItem,
  listItemIdsForSubjects,
  redactKnowledgeItems,
  type KnowledgeItem,
} from "./store.js";

export const NOT_OWN_WORDS_REASON = "not in the operator's own words";
const MAX_REMEMBER_CHARS = 2_000;
const KEY_WORDS = 6;

export interface RememberDeps {
  /** The session's recent chat.db rows, oldest first (default `getRecentHistory(sessionName, 5)`). */
  readHistory?: (sessionName: string) => Array<Pick<Message, "id" | "role" | "content">>;
  now?: number;
}

export function rememberKnowledgeItem(
  input: {
    text: string;
    about: { kind: "contact" | "chat"; id: string };
    kind?: KnowledgeItem["kind"];
    key?: string;
    agentId?: string | null;
    turn: KnowledgeTurn;
  },
  deps: RememberDeps = {},
): { item: KnowledgeItem; activated: boolean; reason: string | null } {
  const op = "knowledge remember";
  const text = (input.text ?? "").trim();
  if (!text) throw usage(op, "Give the text to remember.");
  if (text.length > MAX_REMEMBER_CHARS) throw usage(op, `The text is longer than ${MAX_REMEMBER_CHARS} characters.`);
  const subjectId = input.about?.id?.trim();
  if (!subjectId || (input.about.kind !== "contact" && input.about.kind !== "chat")) {
    throw usage(op, "Pass --about contact:<id> or --about chat:<id>.");
  }
  const kind = input.kind ?? "fact";
  if (!KNOWLEDGE_ITEM_KINDS.includes(kind)) throw usage(op, `--kind is one of ${KNOWLEDGE_ITEM_KINDS.join(", ")}.`);
  const key = knowledgeItemKey(input.key?.trim() ? input.key : text);
  if (!key) throw usage(op, "The text (or --key) needs at least one letter or digit.");

  const now = deps.now ?? Date.now();
  const terminal = input.turn.turnKey === null;
  let activated = terminal;
  let sourceRef = terminal ? "operator:terminal" : `operator:${input.turn.turnKey}`;
  if (!terminal) {
    const authored = newestAuthoredUserMessage(input.turn.sessionName, deps);
    if (authored && containsFolded(authored.authoredText, text)) {
      activated = true;
      sourceRef = `km:${authored.id}`;
    }
  }

  const item = insertKnowledgeItem({
    scope: input.about.kind,
    subjectId,
    agentId: input.agentId?.trim() || null,
    kind,
    key,
    body: text,
    status: activated ? "active" : "draft",
    trust: "approved",
    speaker: "operator",
    recordedAt: now,
    expiresAt: activated ? null : now + KNOWLEDGE_DRAFT_TTL_MS,
    supersededBy: null,
    createdBy: "operator",
    sources: [{ kind: "operator", ref: sourceRef, textHash: sha256(text) }],
  });
  return {
    item,
    activated: item.status === "active",
    reason: activated ? (item.status === "active" ? null : "a higher-trust item has this key") : NOT_OWN_WORDS_REASON,
  };
}

/** Terminal only: `turn.turnKey === null`, else KNOWLEDGE_TURN_NOT_OPERATOR. */
export function confirmKnowledgeDraft(input: { id: string; turn: KnowledgeTurn }): KnowledgeItem {
  const op = "knowledge remember";
  if (input.turn.turnKey !== null) {
    throw new ContractError(
      op,
      "KNOWLEDGE_TURN_NOT_OPERATOR",
      "A draft is confirmed only from the operator's terminal.",
      CONTRACT_EXIT_POLICY,
      {
        retryable: false,
        issues: [
          "Only the operator confirms a draft, from their terminal: tell them to run `ravi knowledge remember --confirm <id>` there.",
        ],
      },
    );
  }
  const item = getKnowledgeItem(input.id);
  if (!item) throw notFound(op);
  if (item.status === "active") return item;
  if (item.status !== "draft") throw usage(op, `Item ki:${item.id} is ${item.status}, not a draft.`);
  return activateKnowledgeDraft(item.id) ?? item;
}

export interface ForgetDeps {
  /** Every chat id a chat.db row of the contact's direct chats may carry. */
  chatIdsForContact?: (contactId: string) => string[];
  /** Platform and normalized ids of a chat ref. */
  chatIdsForChat?: (chatId: string) => string[];
  /** Drops the contact's pending and uploaded gap questions. */
  dropGapsForContact?: (contactId: string) => number;
}

export function forgetKnowledge(
  input: { id?: string; about?: { kind: "contact" | "chat"; id: string }; redact: boolean },
  deps: ForgetDeps = {},
): { archived: number; redacted: number; ftsRowsDeleted: number } {
  const op = "knowledge forget";
  const id = input.id?.trim();
  const subjectId = input.about?.id?.trim();
  if (!id && !subjectId) throw usage(op, "Pass an item id (ki:<id>) or --about contact:<id> or chat:<id>.");
  if (id && subjectId) throw usage(op, "Pass an item id or --about, not both.");

  if (id) {
    const item = getKnowledgeItem(id);
    if (!item) throw notFound(op);
    if (input.redact) return { archived: 0, redacted: redactKnowledgeItems([item.id]), ftsRowsDeleted: 0 };
    return { archived: archiveKnowledgeItem(item.id) ? 1 : 0, redacted: 0, ftsRowsDeleted: 0 };
  }

  const about = input.about as { kind: "contact" | "chat"; id: string };
  if (about.kind !== "contact" && about.kind !== "chat") throw usage(op, "--about is contact:<id> or chat:<id>.");
  const chatIds =
    about.kind === "contact"
      ? (deps.chatIdsForContact ?? defaultChatIdsForContact)(subjectId as string)
      : uniq([subjectId as string, ...(deps.chatIdsForChat ?? defaultChatIdsForChat)(subjectId as string)]);

  // Recorded first: an indexer pass running meanwhile already skips the subject.
  markSubjectForgotten({ scope: about.kind, subjectId: subjectId as string });
  for (const chatId of about.kind === "contact" ? chatIds : chatIds.filter((chat) => chat !== subjectId)) {
    markSubjectForgotten({ scope: "chat", subjectId: chatId });
  }

  let archived = 0;
  let redacted = 0;
  if (input.redact) {
    const ids = [
      ...listItemIdsForSubjects(about.kind, [subjectId as string]),
      ...listItemIdsForSubjects("chat", chatIds),
    ];
    redacted = redactKnowledgeItems(ids);
  } else {
    archived = archiveItemsForSubject({ scope: about.kind, subjectId: subjectId as string });
    for (const chatId of chatIds) {
      if (about.kind === "chat" && chatId === subjectId) continue;
      archived += archiveItemsForSubject({ scope: "chat", subjectId: chatId });
    }
  }
  const ftsRowsDeleted = deleteLocalRowsForChats(chatIds);
  // A forgotten contact's open questions are not uploaded or answered later.
  if (about.kind === "contact") (deps.dropGapsForContact ?? dropGapsForContact)(subjectId as string);
  return { archived, redacted, ftsRowsDeleted };
}

/** The first 6 folded words, joined by `-`. */
export function knowledgeItemKey(text: string): string {
  return foldKnowledgeText(text).split(" ").filter(Boolean).slice(0, KEY_WORDS).join("-");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newestAuthoredUserMessage(
  sessionName: string | null,
  deps: RememberDeps,
): { id: number; authoredText: string } | null {
  const name = sessionName?.trim();
  if (!name) return null;
  let rows: Array<Pick<Message, "id" | "role" | "content">>;
  try {
    rows = (deps.readHistory ?? ((session: string) => getRecentHistory(session, 5)))(name);
  } catch {
    return null;
  }
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row?.role !== "user") continue;
    return { id: row.id, authoredText: parseInboundContent(row.content ?? "").authoredText };
  }
  return null;
}

/** Folded, whitespace-collapsed containment on word boundaries. */
function containsFolded(haystack: string, needle: string): boolean {
  const folded = foldKnowledgeText(needle);
  if (!folded) return false;
  return ` ${foldKnowledgeText(haystack)} `.includes(` ${folded} `);
}

function defaultChatIdsForContact(contactId: string): string[] {
  const ids: string[] = [];
  for (const key of platformChatKeysForContact(contactId)) {
    if (key.platformChatId) ids.push(key.platformChatId);
    if (key.normalizedChatId) ids.push(key.normalizedChatId);
  }
  return uniq(ids);
}

function defaultChatIdsForChat(chatId: string): string[] {
  try {
    return uniq(
      dbListChatsByRef({ ref: chatId, limit: 50 }).flatMap((chat) => [chat.platformChatId, chat.normalizedChatId]),
    );
  } catch {
    return [];
  }
}

function uniq(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function usage(op: string, message: string): ContractError {
  return new ContractError(op, "USAGE_ERROR", message, CONTRACT_EXIT_USAGE, { retryable: false, issues: [message] });
}

function notFound(op: string): ContractError {
  return new ContractError(op, "KNOWLEDGE_NOT_FOUND", "Knowledge item was not found.", CONTRACT_EXIT_ERROR, {
    retryable: false,
    issues: [KNOWLEDGE_ISSUE_TEXT.KNOWLEDGE_NOT_FOUND as string],
  });
}
