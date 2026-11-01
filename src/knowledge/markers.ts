// Reply markers of packet conversations (contract §13.7). The packet asks the
// agent to end a reply with ⟦gap⟧ when nothing it holds answers the contact,
// and with ⟦forget⟧ when the contact asks to be forgotten. The gateway strips
// them before delivery (guarded sessions only) and runs their effect here.

import { getRecentHistory } from "../db.js";
import type { MessageTarget } from "../runtime/message-types.js";
import { logger } from "../utils/logger.js";
import { type GuardedSession, isGuardedSession, KNOWLEDGE_GUARD_TTL_MS, upsertGuardedSession } from "./egress/guard.js";
import { parseInboundContent } from "./envelope.js";
import { capUtf16, dropGapsForContact, insertKnowledgeGap } from "./gaps/store.js";
import { forgetKnowledge } from "./items/remember.js";
import { isSubjectForgotten } from "./store/forgotten.js";

const log = logger.child("knowledge:markers");

export const GAP_MARKER = "⟦gap⟧";
export const FORGET_MARKER = "⟦forget⟧";

const MARKER_PATTERN = /[ \t]*⟦\s*(gap|forget)\s*⟧/gi;
const MAX_QUESTION_CHARS = 1000;

/** Strips every marker and reports which were there. */
export function extractKnowledgeMarkers(text: string): { text: string; gap: boolean; forget: boolean } {
  let gap = false;
  let forget = false;
  const source = text ?? "";
  const stripped = source.replace(MARKER_PATTERN, (_match, kind: string) => {
    if (kind.toLowerCase() === "gap") gap = true;
    else forget = true;
    return "";
  });
  if (!gap && !forget) return { text: source, gap, forget };
  return { text: stripped.replace(/[ \t]+\n/g, "\n").trim(), gap, forget };
}

export interface KnowledgeMarkerDeps {
  guarded?: (sessionName: string) => GuardedSession | null;
  /** The contact's own last message in the session (authored text only). */
  lastContactText?: (sessionName: string) => string | null;
  insertGap?: typeof insertKnowledgeGap;
  forget?: typeof forgetKnowledge;
  dropGaps?: (contactId: string) => number;
  /** Keeps the guard row (no packet is built for a forgotten contact). */
  keepGuard?: (row: GuardedSession) => void;
  isForgotten?: (subjectId: string) => boolean;
  now?: number;
}

/** Runs the effect of the markers a reply carried. Never throws. */
export async function handleKnowledgeMarkers(
  input: { sessionName: string; target: MessageTarget | undefined; gap: boolean; forget: boolean },
  deps: KnowledgeMarkerDeps = {},
): Promise<void> {
  if (!input.gap && !input.forget) return;
  let guarded: GuardedSession | null = null;
  try {
    guarded = (deps.guarded ?? ((name: string) => isGuardedSession(name)))(input.sessionName);
  } catch (error) {
    log.warn("marker guard lookup failed", { sessionName: input.sessionName, error: errorText(error) });
    return;
  }
  if (!guarded) return;

  if (input.gap && !input.forget) {
    try {
      // A forgotten contact's questions are never kept.
      const forgotten = (deps.isForgotten ?? isSubjectForgotten)(guarded.contactId);
      const question = forgotten ? null : (deps.lastContactText ?? defaultLastContactText)(input.sessionName)?.trim();
      if (question) {
        const result = (deps.insertGap ?? insertKnowledgeGap)({
          agentId: guarded.agentId,
          instanceId: guarded.instanceId,
          channel: guarded.channel,
          accountId: input.target?.accountId?.trim() || guarded.instanceId,
          chatId: guarded.chatId,
          contactId: guarded.contactId,
          sessionName: input.sessionName,
          question: capUtf16(question, MAX_QUESTION_CHARS),
        });
        log.info("Knowledge gap marker", {
          sessionName: input.sessionName,
          gapId: result.gap.id,
          created: result.created,
          capped: result.capped,
        });
      }
    } catch (error) {
      log.warn("gap marker failed", { sessionName: input.sessionName, error: errorText(error) });
    }
  }

  if (input.forget) {
    try {
      const result = (deps.forget ?? forgetKnowledge)({
        about: { kind: "contact", id: guarded.contactId },
        redact: true,
      });
      log.info("Knowledge forget marker", { sessionName: input.sessionName, ...result });
    } catch (error) {
      log.warn("forget marker failed", { sessionName: input.sessionName, error: errorText(error) });
    }
    try {
      // A forgotten contact's questions are never uploaded.
      const dropped = (deps.dropGaps ?? dropGapsForContact)(guarded.contactId);
      if (dropped > 0) log.info("Knowledge gaps dropped after forget", { sessionName: input.sessionName, dropped });
    } catch (error) {
      log.warn("gap drop after forget failed", { sessionName: input.sessionName, error: errorText(error) });
    }
    try {
      // No packet is built for a forgotten contact, but the reply guard
      // (links, marker stripping) still applies to this DM: a guard-only row.
      (deps.keepGuard ?? upsertGuardedSession)({
        ...guarded,
        guardedUntil: (deps.now ?? Date.now()) + KNOWLEDGE_GUARD_TTL_MS,
      });
    } catch (error) {
      log.warn("guard row refresh failed", { sessionName: input.sessionName, error: errorText(error) });
    }
  }
}

/** chat.db: the newest user row of the session, authored text only (quotes and transcripts do not count). */
function defaultLastContactText(sessionName: string): string | null {
  const rows = getRecentHistory(sessionName, 20);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    if (row?.role !== "user") continue;
    const text = parseInboundContent(row.content ?? "").authoredText.trim();
    if (text) return text;
    return null;
  }
  return null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
