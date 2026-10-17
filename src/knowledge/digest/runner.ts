// The morning DM to the operator (contract §13.9): unanswered client
// questions, what contact memory learned, and marked pages that need a new
// approval. Built by code (no model), PT-BR, sent once per local day at
// `knowledge.digest.time` in `knowledge.digest.timezone` to the owner's
// direct chat through `ravi.outbound.deliver`. Nothing is sent when every
// count is zero or when there is no owner target.

import { logger } from "../../utils/logger.js";
import { DAEMON_KNOWLEDGE_TURN, openKnowledgeClient, type KnowledgeClient } from "../client.js";
import { deliverThroughOutbound, type OutboundDeliver } from "../mirror/sync.js";
import { resolveOwnerDirectTarget, type OwnerDirectTarget } from "../owner.js";
import { knowledgeSettings } from "../settings.js";
import { getKnowledgeDb, readKnowledgeMeta, writeKnowledgeMeta } from "../store/db.js";
import type { ConsoleDigest } from "../types.js";

const log = logger.child("knowledge:digest");

const DIGEST_LAST_DATE_KEY = "digest_last_date";
const DIGEST_LAST_AT_KEY = "digest_last_at";
const DIGEST_TICK_MS = 60_000;
const MAX_LISTED_QUESTIONS = 5;
const MAX_LISTED_MARKS = 5;
const QUESTION_MAX_CHARS = 80;
const DAY_MS = 24 * 60 * 60_000;

/** The PT-BR text, or null when there is nothing to tell. */
export function buildMorningDigestText(input: {
  digest: ConsoleDigest | null;
  learned: { items: number; subjects: number };
  issues: string[];
}): string | null {
  const lines: string[] = [];
  const unanswered = input.digest?.unanswered ?? [];
  if (unanswered.length > 0) {
    lines.push(`• ${plural(unanswered.length, "pergunta sem resposta", "perguntas sem resposta")}`);
    unanswered.slice(0, MAX_LISTED_QUESTIONS).forEach((gap, index) => {
      const waiting = gap.waitingCount > 1 ? ` (${gap.waitingCount} esperando)` : "";
      lines.push(`  ${index + 1}. "${shortQuestion(gap.question)}"${waiting} → ${gap.cardUrl}`);
    });
    if (unanswered.length > MAX_LISTED_QUESTIONS) {
      lines.push(`  … e mais ${unanswered.length - MAX_LISTED_QUESTIONS}`);
    }
  }
  if (input.learned.items > 0) {
    lines.push(
      `• ${plural(input.learned.items, "coisa aprendida", "coisas aprendidas")} sobre ${plural(Math.max(1, input.learned.subjects), "contato", "contatos")}`,
    );
  }
  const pending = input.digest?.pending;
  const pendingTotal = pending ? pending.notes + pending.corrections + pending.transcripts : 0;
  if (pendingTotal > 0) {
    lines.push(
      `• ${plural(pendingTotal, "proposta aguardando aprovação", "propostas aguardando aprovação")} no Console`,
    );
  }
  const suspended = input.digest?.suspendedMarks ?? [];
  if (suspended.length === 1) {
    lines.push(`• 1 página marcada precisa de nova aprovação → ${suspended[0]?.cardUrl}`);
  } else if (suspended.length > 1) {
    lines.push(`• ${suspended.length} páginas marcadas precisam de nova aprovação`);
    for (const mark of suspended.slice(0, MAX_LISTED_MARKS)) lines.push(`  - ${mark.url} → ${mark.cardUrl}`);
    if (suspended.length > MAX_LISTED_MARKS) lines.push(`  … e mais ${suspended.length - MAX_LISTED_MARKS}`);
  }
  if (lines.length === 0) return null;
  if (input.digest === null && input.issues.length > 0) {
    lines.push("(Console indisponível: só as contagens locais)");
  }
  return ["Bom dia! Knowledge de hoje:", ...lines].join("\n");
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function shortQuestion(question: string): string {
  const text = question.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  const chars = [...text];
  return chars.length <= QUESTION_MAX_CHARS ? text : `${chars.slice(0, QUESTION_MAX_CHARS - 1).join("")}…`;
}

/** Items created since `since` (ms) and their distinct subjects. */
export function countLearnedItemsSince(since: number): { items: number; subjects: number } {
  const row = getKnowledgeDb()
    .prepare(
      `SELECT COUNT(*) AS items, COUNT(DISTINCT scope || ':' || subject_id) AS subjects
       FROM knowledge_items WHERE created_at > ? AND status IN ('active','draft')`,
    )
    .get(since) as { items: number; subjects: number } | null;
  return { items: row?.items ?? 0, subjects: row?.subjects ?? 0 };
}

/** The local date (`YYYY-MM-DD`) and minutes since midnight in a zone. */
export function localClock(now: number, timeZone: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(now))
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export interface MorningDigestDeps {
  now?: number;
  settings?: () => { digestTime: string; digestTimezone: string };
  /** null = no login. Omitted = `openKnowledgeClient()`. */
  client?: KnowledgeClient | null;
  owner?: () => OwnerDirectTarget | null;
  countLearned?: (since: number) => { items: number; subjects: number };
  deliver?: OutboundDeliver;
}

export type MorningDigestOutcome = "not_due" | "already_sent" | "no_owner" | "nothing" | "sent" | "failed";

/** One check: sends the digest when it is due today and not sent yet. Never throws. */
export async function runMorningDigestTick(deps: MorningDigestDeps = {}): Promise<MorningDigestOutcome> {
  try {
    const now = deps.now ?? Date.now();
    const settings = (deps.settings ?? knowledgeSettings)();
    const clock = localClock(now, settings.digestTimezone);
    const [hour, minute] = settings.digestTime.split(":").map(Number);
    if (clock.minutes < (hour ?? 8) * 60 + (minute ?? 0)) return "not_due";
    if (readKnowledgeMeta(DIGEST_LAST_DATE_KEY) === clock.date) return "already_sent";

    const owner = (deps.owner ?? resolveOwnerDirectTarget)();
    if (!owner) {
      // The doctor warns (knowledge.f2_setup); try again once an owner exists.
      return "no_owner";
    }

    const lastAt = Number(readKnowledgeMeta(DIGEST_LAST_AT_KEY) ?? "") || now - DAY_MS;
    const issues: string[] = [];
    let digest: ConsoleDigest | null = null;
    const client = deps.client !== undefined ? deps.client : await openKnowledgeClient();
    if (client) {
      try {
        digest = await client.digest({ since: new Date(lastAt).toISOString() }, DAEMON_KNOWLEDGE_TURN);
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        issues.push(`console_unavailable: ${typeof code === "string" ? code : "UNKNOWN"}`);
      }
    } else {
      issues.push("console_not_logged_in");
    }
    const learned = (deps.countLearned ?? countLearnedItemsSince)(lastAt);
    const text = buildMorningDigestText({ digest, learned, issues });

    if (text) {
      await (deps.deliver ?? deliverThroughOutbound)({
        channel: owner.channel,
        accountId: owner.accountId,
        to: owner.to,
        text,
      });
    }
    writeKnowledgeMeta(DIGEST_LAST_DATE_KEY, clock.date);
    writeKnowledgeMeta(DIGEST_LAST_AT_KEY, String(now));
    log.info("knowledge morning digest", { sent: text !== null, issues });
    return text ? "sent" : "nothing";
  } catch (error) {
    log.warn("knowledge morning digest failed", { error: error instanceof Error ? error.message : String(error) });
    return "failed";
  }
}

let digestTimer: ReturnType<typeof setInterval> | null = null;
let digestTick: Promise<unknown> | null = null;

function tickOnce(): void {
  if (digestTick) return;
  digestTick = runMorningDigestTick().finally(() => {
    digestTick = null;
  });
}

/** Leader only: checks every minute. */
export function startKnowledgeDigestRunner(): void {
  if (digestTimer) return;
  digestTimer = setInterval(tickOnce, DIGEST_TICK_MS);
  digestTimer.unref?.();
}

export function stopKnowledgeDigestRunner(): void {
  if (digestTimer) clearInterval(digestTimer);
  digestTimer = null;
}

export function isKnowledgeDigestRunnerRunning(): boolean {
  return digestTimer !== null;
}
