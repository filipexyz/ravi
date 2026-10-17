// Knowledge inbox items (contract §13.9, §7.6), handed off by the InboxRunner
// after delivery. Items carry ids only; everything else is read back from the
// Console with the installation's own login.
//
//   knowledge.gap.answered   mark the proposal's gaps answered, sync the
//                            mirror, then send each contact the PT-BR answer
//                            (only where the mirror now holds the /faq URL)
//   knowledge.marks.changed  sync the mirror, at most once a minute; an event
//                            inside the minute arms one trailing sync

import { logger } from "../../utils/logger.js";
import type { InboxNatsPayload } from "../../inbox/types.js";
import { DAEMON_KNOWLEDGE_TURN, openKnowledgeClient, type KnowledgeClient } from "../client.js";
import { listGapsForProposal, updateGap } from "../gaps/store.js";
import {
  notifyAnsweredProposal,
  syncKnowledgeMirror,
  type KnowledgeMirrorSyncResult,
  type OutboundDeliver,
} from "../mirror/sync.js";

const log = logger.child("knowledge:inbox");

export const KNOWLEDGE_GAP_ANSWERED_EVENT = "knowledge.gap.answered";
export const KNOWLEDGE_MARKS_CHANGED_EVENT = "knowledge.marks.changed";
export const KNOWLEDGE_MARKS_SYNC_DEBOUNCE_MS = 60_000;

export interface KnowledgeInboxDeps {
  /** null = no login. Omitted = `openKnowledgeClient()`. */
  client?: KnowledgeClient | null;
  sync?: () => Promise<KnowledgeMirrorSyncResult>;
  deliver?: OutboundDeliver;
  now?: () => number;
  /** Arms the trailing marks sync; defaults to an unref'd setTimeout. */
  schedule?: (run: () => void, delayMs: number) => { cancel: () => void };
}

let lastMarksSyncAt: number | null = null;
let trailingMarksSync: { cancel: () => void } | null = null;

/** Test hook: forget the marks.changed debounce and any trailing sync. */
export function resetKnowledgeInboxDebounce(): void {
  lastMarksSyncAt = null;
  trailingMarksSync?.cancel();
  trailingMarksSync = null;
}

export function isKnowledgeInboxEvent(eventType: string): boolean {
  return eventType === KNOWLEDGE_GAP_ANSWERED_EVENT || eventType === KNOWLEDGE_MARKS_CHANGED_EVENT;
}

/** Never throws. */
export async function handleKnowledgeInboxItem(
  payload: InboxNatsPayload,
  deps: KnowledgeInboxDeps = {},
): Promise<void> {
  try {
    if (payload.eventType === KNOWLEDGE_GAP_ANSWERED_EVENT) {
      await handleGapAnswered(payload, deps);
    } else if (payload.eventType === KNOWLEDGE_MARKS_CHANGED_EVENT) {
      await handleMarksChanged(deps);
    }
  } catch (error) {
    log.warn("knowledge inbox item failed", {
      eventId: payload.eventId,
      eventType: payload.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleGapAnswered(payload: InboxNatsPayload, deps: KnowledgeInboxDeps): Promise<void> {
  // The item payload is nested: InboxNatsPayload.payload = { proposalId, projectId }.
  const proposalId = payload.payload?.proposalId;
  if (typeof proposalId !== "string" || proposalId.trim() === "") return;

  const client = deps.client !== undefined ? deps.client : await openKnowledgeClient();
  if (!client) return;
  const { proposal } = await client.getProposal(proposalId, DAEMON_KNOWLEDGE_TURN);
  if (!proposal.faq || !proposal.answer) return;

  for (const gap of listGapsForProposal(proposalId)) {
    if (gap.status === "uploaded") updateGap(gap.id, { status: "answered" });
  }

  // The /faq mark reaches the mirror only through a sync, and the egress
  // guard removes links the mirror does not hold: sync before any send.
  const sync = await (deps.sync ?? (() => syncKnowledgeMirror({ client, deliver: deps.deliver })))();
  if (sync.ok === false) {
    log.info("knowledge mirror sync failed; answered gaps wait for the next sync", {
      proposalId,
      issues: sync.issues,
    });
    return;
  }
  const sent = await notifyAnsweredProposal(proposal, {
    deliver: deps.deliver,
    now: deps.now?.(),
  });
  log.info("knowledge gap answered", { proposalId, sent });
}

async function handleMarksChanged(deps: KnowledgeInboxDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  if (lastMarksSyncAt !== null && now - lastMarksSyncAt < KNOWLEDGE_MARKS_SYNC_DEBOUNCE_MS) {
    // A change inside the window still reaches the mirror: one trailing sync.
    if (!trailingMarksSync) {
      const delay = lastMarksSyncAt + KNOWLEDGE_MARKS_SYNC_DEBOUNCE_MS - now;
      trailingMarksSync = (deps.schedule ?? scheduleUnref)(() => {
        trailingMarksSync = null;
        void handleMarksChanged(deps).catch((error) => {
          log.warn("knowledge trailing marks sync failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, delay);
    }
    return;
  }
  trailingMarksSync?.cancel();
  trailingMarksSync = null;
  lastMarksSyncAt = now;
  await (deps.sync ?? (() => syncKnowledgeMirror({ ...(deps.client !== undefined ? { client: deps.client } : {}) })))();
}

function scheduleUnref(run: () => void, delayMs: number): { cancel: () => void } {
  const timer = setTimeout(run, Math.max(0, delayMs));
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}
