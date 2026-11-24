import { deliverToChat } from "../cloud-agents/chat-target.js";
import {
  listLocalInboxEvents,
  listLocalInboxItems,
  markLocalInboxItem,
  upsertLocalInboxItem,
} from "../inbox/local-db.js";
import { resolveOwnerDirectTarget, resolveOwnerDirectTargets, type OwnerDirectTarget } from "../knowledge/owner.js";
import { logger } from "../utils/logger.js";
import { countPendingCronFailures } from "./run-db.js";
import type { CronJob } from "./types.js";

const log = logger.child("cron:failure-notification");

export type CronFailureJob = Pick<CronJob, "id" | "name" | "agentId" | "ownerPrincipal" | "lastRunAt" | "updatedAt"> & {
  runId?: string;
};

export function classifyCronFailure(
  error: string,
): "configuration" | "credential" | "timeout" | "interruption" | "execution" {
  if (/model.*(?:does not belong|requires the|cannot run|not supported)|invalid.*model/i.test(error))
    return "configuration";
  if (/credential|auth|not logged in|api.?key|unauthorized|\b401\b/i.test(error)) return "credential";
  if (/timeout|timed out|inactivity/i.test(error)) return "timeout";
  if (/interrupt|abort|cancel/i.test(error)) return "interruption";
  return "execution";
}

const FAILURE_COPY = {
  configuration: "configuração incompatível de provider e modelo",
  credential: "credencial indisponível ou recusada",
  timeout: "tempo de execução esgotado",
  interruption: "execução interrompida antes de concluir",
  execution: "erro de execução",
} as const;

export function resolveCronFailureOwner(job: Pick<CronJob, "ownerPrincipal">): OwnerDirectTarget | null {
  const owner = job.ownerPrincipal;
  if (!owner || owner === "operator") return resolveOwnerDirectTarget();
  if (!owner.startsWith("contact:") || !owner.slice(8)) return null;
  return resolveOwnerDirectTarget({ listOwnerContactIds: () => [owner.slice(8)], readTargetSetting: () => null });
}

/** Every direct chat of the run's owner, best first; the next is tried when one cannot be reached. */
export function resolveCronFailureOwners(job: Pick<CronJob, "ownerPrincipal">): OwnerDirectTarget[] {
  const owner = job.ownerPrincipal;
  if (!owner || owner === "operator") return resolveOwnerDirectTargets();
  if (!owner.startsWith("contact:") || !owner.slice(8)) return [];
  return resolveOwnerDirectTargets({ listOwnerContactIds: () => [owner.slice(8)], readTargetSetting: () => null });
}

/** One message per job in this window; later failures of the same job join it instead of sending again. */
export const CRON_FAILURE_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Delivery attempts (across starts) before a report is settled as undeliverable instead of retried. */
export const CRON_FAILURE_MAX_DELIVERY_ATTEMPTS = 3;

const SETTLED_EVENTS = new Set([
  "cron.failure.notified",
  "cron.failure.unowned",
  "cron.failure.aggregated",
  "cron.failure.undeliverable",
  "cron.failure.stale",
]);

/** When this job last messaged its owner about a failure, from the inbox ledger; null if never. */
function lastJobNoticeAt(jobId: string): number | null {
  let latest: number | null = null;
  for (const item of listLocalInboxItems({ sourceDomain: "cron" })) {
    if (item.sourceType !== "run_failed" || item.sourceId !== jobId) continue;
    for (const event of listLocalInboxEvents(item.id)) {
      if (event.eventType !== "cron.failure.notified") continue;
      if (latest === null || event.createdAt > latest) latest = event.createdAt;
    }
  }
  return latest;
}

/** The operator or a contact owns the run, so a direct message is owed (and retried, a bounded number of times). */
export function cronFailureOwesDirectMessage(ownerPrincipal: string | null | undefined): boolean {
  if (!ownerPrincipal || ownerPrincipal === "operator") return true;
  return ownerPrincipal.startsWith("contact:") && ownerPrincipal.length > "contact:".length;
}

/**
 * A run whose stored notice cannot be parsed never will, and its recipient lives only in that
 * notice: no message is owed, and none can be guessed from the job as it is now. Keep the failure
 * visible in the inbox, once; the caller then settles the run so it is not replayed.
 */
export function recordUnreadableCronFailure(run: { id: string; job_id: string; admitted_at: number }): void {
  const { item } = upsertLocalInboxItem({
    sourceDomain: "cron",
    sourceType: "run_unreadable",
    sourceId: run.job_id,
    dedupeKey: `cron-unreadable:${run.job_id}:${run.id}`,
    title: `Falha no agendamento ${run.job_id}: aviso ilegível`,
    summary: `Um agendamento falhou, mas o aviso guardado dessa execução não pôde ser lido, então nenhuma mensagem foi enviada. Confira o estado do agendamento com "ravi cron show ${run.job_id}"; esta execução não tem mais um aviso legível.`,
    priority: "high",
    occurredAt: run.admitted_at,
    metadata: { jobId: run.job_id, runId: run.id, category: "unreadable" },
    actorType: "system",
  });
  if (listLocalInboxEvents(item.id).some((event) => event.eventType === "cron.failure.unreadable")) return;
  markLocalInboxItem(item.id, item.status, { eventType: "cron.failure.unreadable", actorType: "system" });
}

/**
 * Deterministic delivery: reporting a broken model must never need that model.
 *
 * Returns true when the report is settled (sent, joined to a recent notice of the same job, owed
 * to nobody, or undeliverable after bounded attempts) and false when a later start should retry.
 * A job that keeps failing sends one message per window, never one per run; an owner chat that
 * cannot be reached falls through to the owner's next chat, and a report no chat accepts is
 * settled as undeliverable after a few attempts instead of being retried at every start.
 */
export async function notifyCronFailure(
  job: CronFailureJob,
  error: string,
  deps: {
    owner?: typeof resolveCronFailureOwner;
    owners?: typeof resolveCronFailureOwners;
    deliver?: (target: OwnerDirectTarget, text: string) => Promise<unknown>;
    lastNoticeAt?: (jobId: string) => number | null;
    pendingFailures?: (jobId: string) => number;
    now?: () => number;
  } = {},
): Promise<boolean> {
  try {
    const category = classifyCronFailure(error);
    const targets = deps.owners
      ? deps.owners(job)
      : deps.owner
        ? [deps.owner(job)].filter((target): target is OwnerDirectTarget => target !== null)
        : resolveCronFailureOwners(job);
    const summary = `O agendamento “${job.name}” falhou: ${FAILURE_COPY[category]}. O trabalho ficou pendente; revise a execução antes de repetir.`;
    const { item } = upsertLocalInboxItem({
      sourceDomain: "cron",
      sourceType: "run_failed",
      sourceId: job.id,
      dedupeKey: `cron-failure:${job.id}:${job.runId ?? job.lastRunAt ?? job.updatedAt}`,
      title: `Falha no agendamento: ${job.name}`,
      summary,
      priority: "high",
      assignedToAgentId: job.agentId,
      assignedToContactId: targets[0]?.contactId,
      occurredAt: job.lastRunAt,
      // Raw provider errors may contain tokens, paths or prompts. Keep them in
      // the existing job diagnostics, never in the outbound message/inbox.
      metadata: { jobId: job.id, category, ownerPrincipal: job.ownerPrincipal ?? "unknown" },
      actorType: "system",
    });
    const events = listLocalInboxEvents(item.id);
    if (events.some((event) => SETTLED_EVENTS.has(event.eventType))) return true;
    // No person owns the run (`unknown`, an agent): no direct message is owed.
    // The inbox item is the report; settle it so it is not resent every start.
    if (!cronFailureOwesDirectMessage(job.ownerPrincipal)) {
      markLocalInboxItem(item.id, item.status, { eventType: "cron.failure.unowned", actorType: "system" });
      return true;
    }
    const now = (deps.now ?? Date.now)();
    if (typeof job.lastRunAt === "number" && now - job.lastRunAt > CRON_FAILURE_NOTICE_WINDOW_MS) {
      // A failure older than the window is history, not news: a backlog found at start (an owner chat
      // that was offline for days) stays in the inbox and is settled without a message.
      markLocalInboxItem(item.id, item.status, {
        eventType: "cron.failure.stale",
        actorType: "system",
        payload: { failedAt: job.lastRunAt },
      });
      return true;
    }
    const lastNotice = (deps.lastNoticeAt ?? lastJobNoticeAt)(job.id);
    if (lastNotice !== null && now - lastNotice < CRON_FAILURE_NOTICE_WINDOW_MS) {
      // The owner already heard about this job recently: the run joins that notice.
      markLocalInboxItem(item.id, item.status, {
        eventType: "cron.failure.aggregated",
        actorType: "system",
        payload: { lastNoticeAt: lastNotice },
      });
      return true;
    }
    const failures = Math.max(1, (deps.pendingFailures ?? countPendingCronFailures)(job.id));
    const text =
      failures > 1
        ? `O agendamento “${job.name}” falhou ${failures} vezes; a última: ${FAILURE_COPY[category]}. O trabalho ficou pendente; revise a execução antes de repetir.`
        : summary;
    const deliver = deps.deliver ?? ((owner, message) => deliverToChat(owner, { text: message }));
    const reasons: string[] = [];
    for (const target of targets) {
      try {
        await deliver(target, text);
        markLocalInboxItem(item.id, item.status, {
          eventType: "cron.failure.notified",
          actorType: "system",
          payload: { channel: target.channel, accountId: target.accountId, failures },
        });
        return true;
      } catch (cause) {
        reasons.push(
          `${target.channel}:${target.accountId}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    const reason = targets.length === 0 ? "no direct chat of the owner resolves" : reasons.join("; ");
    const attempts = events.filter((event) => event.eventType === "cron.failure.delivery_failed").length + 1;
    markLocalInboxItem(item.id, item.status, {
      eventType: "cron.failure.delivery_failed",
      actorType: "system",
      payload: { attempt: attempts, targets: targets.length },
    });
    if (attempts >= CRON_FAILURE_MAX_DELIVERY_ATTEMPTS) {
      // Fail closed with a reason: the inbox keeps the failure, and the run stops being replayed.
      markLocalInboxItem(item.id, item.status, {
        eventType: "cron.failure.undeliverable",
        actorType: "system",
        payload: { attempts, targets: targets.length },
      });
      log.warn("Cron failure report settled as undeliverable; kept in the inbox", {
        jobId: job.id,
        attempts,
        reason,
      });
      return true;
    }
    log.warn("Cron failure notification not delivered; will retry at a later start", {
      jobId: job.id,
      attempt: attempts,
      reason,
    });
    return false;
  } catch (error) {
    log.error("Cron failure notification failed; run remains failed and inbox stays open", { jobId: job.id, error });
    return false;
  }
}
