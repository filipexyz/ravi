// Mirror sync and gap upload (contract §13.9). Runs as the installation
// itself (DAEMON_KNOWLEDGE_TURN), on the leader every 15 minutes and on
// `knowledge.*` inbox items:
//   1. send this installation's instances (by name) and replace the mirror;
//   2. upload pending gaps as gap proposals;
//   3. tell contacts about answered gaps whose `/faq` page is now mirrored
//      for their instance.
// With the Console unreachable the current mirror is kept until it expires.

import { dbListInstances, type InstanceConfig } from "../../router/router-db.js";
import { nats } from "../../nats.js";
import { logger } from "../../utils/logger.js";
import { DAEMON_KNOWLEDGE_TURN, isConsoleUnavailable, openKnowledgeClient, type KnowledgeClient } from "../client.js";
import {
  claimGapsForNotification,
  listAnsweredGaps,
  listGapsByStatus,
  listGapsForProposal,
  updateGap,
  type KnowledgeGap,
} from "../gaps/store.js";
import { knowledgeSettings } from "../settings.js";
import type { ConsoleProposalView } from "../types.js";
import { dropExpiredMirror, isUrlMirroredForInstance, replaceMarkedPages } from "./store.js";

const log = logger.child("knowledge:mirror");

export const KNOWLEDGE_MIRROR_INTERVAL_MS = 15 * 60_000;
const MAX_INSTANCES = 50;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const GAP_UPLOAD_BATCH = 50;
const ANSWERED_BATCH = 100;
const QUESTION_MAX_CHARS = 200;

export type OutboundDeliver = (payload: {
  channel: string;
  accountId: string;
  to: string;
  text: string;
}) => Promise<void>;

export interface KnowledgeMirrorSyncDeps {
  /** null = no login. Omitted = `openKnowledgeClient()`. */
  client?: KnowledgeClient | null;
  now?: number;
  listInstances?: () => InstanceConfig[];
  project?: () => string | null;
  deliver?: OutboundDeliver;
}

export interface KnowledgeMirrorSyncResult {
  pages: number;
  gapsUploaded: number;
  issues: string[];
  /** False when the mirror could not be refreshed (no login, Console unreachable or refusing). */
  ok?: boolean;
  /** Contacts told about an answer by step 4. */
  notified?: number;
}

/** The default delivery: `ravi.outbound.deliver`, as `ravi whatsapp dm send` sends. */
export const deliverThroughOutbound: OutboundDeliver = async (payload) => {
  await nats.emit("ravi.outbound.deliver", { ...payload });
};

export async function syncKnowledgeMirror(deps: KnowledgeMirrorSyncDeps = {}): Promise<KnowledgeMirrorSyncResult> {
  const now = deps.now ?? Date.now();
  const issues: string[] = [];
  const client = deps.client !== undefined ? deps.client : await openKnowledgeClient();
  if (!client) {
    dropExpiredMirror(now);
    return { pages: 0, gapsUploaded: 0, issues: ["console_not_logged_in"], ok: false, notified: 0 };
  }

  const instances = mirrorInstances((deps.listInstances ?? dbListInstances)());
  let pages = 0;
  try {
    const mirror = await client.mirror({ instances }, DAEMON_KNOWLEDGE_TURN);
    replaceMarkedPages(mirror, now);
    pages = mirror.pages.length;
  } catch (error) {
    dropExpiredMirror(now);
    const code = errorCode(error);
    issues.push(isConsoleUnavailable(error) ? `console_unavailable: ${code}` : `mirror_failed: ${code}`);
    log.warn("knowledge mirror sync failed; keeping the current mirror until it expires", { code });
    return { pages: 0, gapsUploaded: 0, issues, ok: false, notified: 0 };
  }

  const gapsUploaded = await uploadPendingGaps(client, instances, deps, issues, now);
  const notified = await notifyMirroredAnswers(client, deps, issues, now);
  return { pages, gapsUploaded, issues, ok: true, notified };
}

/** The instances sent to the Console: name as id, "name (channel)" as label. */
export function mirrorInstances(
  rows: readonly InstanceConfig[],
): Array<{ id: string; label: string; channel: string }> {
  return rows
    .filter((row) => row.enabled !== false && !row.deletedAt && INSTANCE_ID_PATTERN.test(row.name))
    .slice(0, MAX_INSTANCES)
    .map((row) => ({ id: row.name, label: instanceLabel(row.name, row.channel), channel: row.channel }));
}

function instanceLabel(name: string, channel: string): string {
  return `${name} (${channel})`.slice(0, 80);
}

async function uploadPendingGaps(
  client: KnowledgeClient,
  instances: Array<{ id: string; label: string; channel: string }>,
  deps: KnowledgeMirrorSyncDeps,
  issues: string[],
  now: number,
): Promise<number> {
  const pending = listGapsByStatus("pending", GAP_UPLOAD_BATCH);
  if (pending.length === 0) return 0;
  const project = deps.project ? deps.project() : knowledgeSettings().project;
  if (!project) {
    issues.push("gaps_pending_no_project");
    return 0;
  }
  const labels = new Map(instances.map((instance) => [instance.id, instance.label]));
  let uploaded = 0;
  for (const gap of pending) {
    // The Console refuses another instance id shape: never upload it.
    if (!INSTANCE_ID_PATTERN.test(gap.instanceId)) {
      updateGap(gap.id, { status: "dropped" });
      issues.push("gap_dropped: instance_id_invalid");
      continue;
    }
    try {
      const { proposal } = await client.createProposal(
        {
          kind: "gap",
          project,
          title: null,
          body: gap.question,
          evidence: [],
          supersedes: null,
          requestedAudience: {
            kind: "contacts",
            instanceId: gap.instanceId,
            label: labels.get(gap.instanceId) ?? instanceLabel(gap.instanceId, gap.channel),
          },
          dedupeKey: gap.questionHash,
          idempotencyKey: `gap:${gap.id}`,
        },
        DAEMON_KNOWLEDGE_TURN,
      );
      updateGap(gap.id, { status: "uploaded", proposalId: proposal.id, uploadedAt: now });
      uploaded += 1;
    } catch (error) {
      const code = errorCode(error);
      issues.push(`gap_upload_failed: ${code}`);
      if (code === "PAYLOAD_INVALID") {
        // Retrying the same payload fails the same way: drop it.
        updateGap(gap.id, { status: "dropped" });
        log.warn("knowledge gap refused by the Console; dropped", { gapId: gap.id, code });
        continue;
      }
      log.warn("knowledge gap upload failed; it stays pending", { gapId: gap.id, code });
      if (isConsoleUnavailable(error)) break;
    }
  }
  return uploaded;
}

/** Step 4: answered gaps whose `/faq` URL reached the mirror for their instance. */
async function notifyMirroredAnswers(
  client: KnowledgeClient,
  deps: KnowledgeMirrorSyncDeps,
  issues: string[],
  now: number,
): Promise<number> {
  const answered = listAnsweredGaps(ANSWERED_BATCH);
  const proposalIds = [...new Set(answered.map((gap) => gap.proposalId).filter((id): id is string => !!id))];
  let notified = 0;
  for (const proposalId of proposalIds) {
    try {
      const { proposal } = await client.getProposal(proposalId, DAEMON_KNOWLEDGE_TURN);
      notified += await notifyAnsweredProposal(proposal, { deliver: deps.deliver, now });
    } catch (error) {
      const code = errorCode(error);
      issues.push(`answer_notify_failed: ${code}`);
      log.warn("knowledge answered gap could not be notified yet", { proposalId, code });
      if (isConsoleUnavailable(error)) break;
    }
  }
  return notified;
}

/**
 * Sends the PT-BR answer to every gap of this proposal whose instance mirror
 * holds the `/faq` URL, once (claimed atomically). Gaps of other instances
 * stay `answered` for a later sync. Returns how many were sent.
 */
export async function notifyAnsweredProposal(
  proposal: ConsoleProposalView,
  options: { deliver?: OutboundDeliver; now?: number } = {},
): Promise<number> {
  const faq = proposal.faq;
  const answer = proposal.answer?.trim();
  if (!faq || !answer) return 0;
  const now = options.now ?? Date.now();
  const instances = [...new Set(listGapsForProposal(proposal.id).map((gap) => gap.instanceId))].filter((instanceId) =>
    isUrlMirroredForInstance(faq.url, instanceId, now),
  );
  if (instances.length === 0) return 0;
  const deliver = options.deliver ?? deliverThroughOutbound;
  const link = faqLink(faq.url, faq.anchor);
  let sent = 0;
  for (const gap of claimGapsForNotification(proposal.id, instances)) {
    try {
      await deliver({
        channel: gap.channel,
        accountId: gap.accountId,
        to: gap.chatId,
        text: buildGapAnswerText({ question: gap.question, answer, link }),
      });
      sent += 1;
    } catch (error) {
      // Put it back for the next sync rather than lose the answer.
      updateGap(gap.id, { status: "answered", notifiedAt: null });
      log.warn("knowledge gap answer delivery failed; retried on the next sync", {
        gapId: gap.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return sent;
}

/** The fixed PT-BR message a contact gets when their question is answered. */
export function buildGapAnswerText(input: { question: string; answer: string; link: string }): string {
  return `Oi! Sobre a sua pergunta "${truncateQuestion(input.question)}": ${input.answer}\nMais detalhes: ${input.link}`;
}

function truncateQuestion(question: string): string {
  const text = question.replace(/\s+/g, " ").trim();
  const chars = [...text];
  return chars.length <= QUESTION_MAX_CHARS ? text : `${chars.slice(0, QUESTION_MAX_CHARS - 1).join("")}…`;
}

function faqLink(url: string, anchor: string): string {
  const base = url.split("#")[0] ?? url;
  return anchor ? `${base}#${anchor}` : base;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "UNKNOWN";
}

export type { KnowledgeGap };

// ---------------------------------------------------------------------------
// Runner (leader only; started by the knowledge leader runners)
// ---------------------------------------------------------------------------

let mirrorTimer: ReturnType<typeof setInterval> | null = null;
let mirrorFirstTimer: ReturnType<typeof setTimeout> | null = null;
let mirrorTick: Promise<void> | null = null;

/** One sync, coalesced with any running one. Never throws. */
export function runKnowledgeMirrorTick(): Promise<void> {
  if (mirrorTick) return mirrorTick;
  mirrorTick = (async () => {
    try {
      const result = await syncKnowledgeMirror();
      if (result.issues.length > 0) log.info("knowledge mirror sync", { pages: result.pages, issues: result.issues });
    } catch (error) {
      log.warn("knowledge mirror sync crashed", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      mirrorTick = null;
    }
  })();
  return mirrorTick;
}

export function startKnowledgeMirrorRunner(): void {
  if (mirrorTimer) return;
  mirrorTimer = setInterval(() => void runKnowledgeMirrorTick(), KNOWLEDGE_MIRROR_INTERVAL_MS);
  mirrorTimer.unref?.();
  mirrorFirstTimer = setTimeout(() => {
    mirrorFirstTimer = null;
    void runKnowledgeMirrorTick();
  }, 5_000);
  mirrorFirstTimer.unref?.();
}

export function stopKnowledgeMirrorRunner(): void {
  if (mirrorTimer) clearInterval(mirrorTimer);
  if (mirrorFirstTimer) clearTimeout(mirrorFirstTimer);
  mirrorTimer = null;
  mirrorFirstTimer = null;
}

export function isKnowledgeMirrorRunnerRunning(): boolean {
  return mirrorTimer !== null;
}
