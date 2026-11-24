import { deliverToChat } from "../cloud-agents/chat-target.js";
import {
  listLocalInboxEvents,
  listLocalInboxItems,
  markLocalInboxItem,
  upsertLocalInboxItem,
} from "../inbox/local-db.js";
import { resolveOwnerDirectTarget, resolveOwnerDirectTargets, type OwnerDirectTarget } from "../knowledge/owner.js";
import { createOmniClient } from "../omni/client.js";
import { resolveOmniConnection } from "../omni-config.js";
import { dbGetInstance } from "../router/router-db.js";
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

/** Whether a chat can be reached now: true, false, or null when it cannot be told (keep trying it). */
export type CronFailureReachability = (target: OwnerDirectTarget) => Promise<boolean | null>;

export interface CronFailureNoticeDeps {
  owner?: typeof resolveCronFailureOwner;
  owners?: typeof resolveCronFailureOwners;
  deliver?: (target: OwnerDirectTarget, text: string) => Promise<unknown>;
  reachable?: CronFailureReachability;
  lastNoticeAt?: (jobId: string) => number | null;
  pendingFailures?: (jobId: string) => number;
  now?: () => number;
}

/** A failure that is owed a message, waiting to be delivered alone or in a digest. */
export interface CronFailureReport {
  itemId: string;
  jobId: string;
  jobName: string;
  category: ReturnType<typeof classifyCronFailure>;
  failedAt: number | null;
  ownerKey: string;
  targets: OwnerDirectTarget[];
  priorAttempts: number;
}

/**
 * Record the failure in the inbox and decide what it is owed. `null` means it is settled without a
 * message: already reported, owed to nobody, older than the window (history, not news), or joined
 * to a notice the owner got for the same job inside the window. Otherwise a report to deliver.
 */
export function prepareCronFailureReport(
  job: CronFailureJob,
  error: string,
  deps: CronFailureNoticeDeps = {},
): CronFailureReport | null {
  const category = classifyCronFailure(error);
  const targets = deps.owners
    ? deps.owners(job)
    : deps.owner
      ? [deps.owner(job)].filter((target): target is OwnerDirectTarget => target !== null)
      : resolveCronFailureOwners(job);
  const { item } = upsertLocalInboxItem({
    sourceDomain: "cron",
    sourceType: "run_failed",
    sourceId: job.id,
    dedupeKey: `cron-failure:${job.id}:${job.runId ?? job.lastRunAt ?? job.updatedAt}`,
    title: `Falha no agendamento: ${job.name}`,
    summary: singleRunText(job.name, category),
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
  if (events.some((event) => SETTLED_EVENTS.has(event.eventType))) return null;
  // No person owns the run (`unknown`, an agent): no direct message is owed.
  // The inbox item is the report; settle it so it is not resent every start.
  if (!cronFailureOwesDirectMessage(job.ownerPrincipal)) {
    markLocalInboxItem(item.id, item.status, { eventType: "cron.failure.unowned", actorType: "system" });
    return null;
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
    return null;
  }
  const lastNotice = (deps.lastNoticeAt ?? lastJobNoticeAt)(job.id);
  if (lastNotice !== null && now - lastNotice < CRON_FAILURE_NOTICE_WINDOW_MS) {
    // The owner already heard about this job recently: the run joins that notice.
    markLocalInboxItem(item.id, item.status, {
      eventType: "cron.failure.aggregated",
      actorType: "system",
      payload: { lastNoticeAt: lastNotice },
    });
    return null;
  }
  return {
    itemId: item.id,
    jobId: job.id,
    jobName: job.name,
    category,
    failedAt: typeof job.lastRunAt === "number" ? job.lastRunAt : null,
    ownerKey: job.ownerPrincipal && job.ownerPrincipal !== "operator" ? job.ownerPrincipal : "operator",
    targets,
    priorAttempts: events.filter((event) => event.eventType === "cron.failure.delivery_failed").length,
  };
}

function singleRunText(name: string, category: CronFailureReport["category"]): string {
  return `O agendamento “${name}” falhou: ${FAILURE_COPY[category]}. O trabalho ficou pendente; revise a execução antes de repetir.`;
}

function formatFailedAt(at: number | null): string {
  return at === null ? "hora desconhecida" : `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** One message for an owner's reports: one line per job with how many runs failed and the last one. */
export function cronFailureDigestText(
  reports: CronFailureReport[],
  extraFailures: Map<string, number> = new Map(),
): string {
  const byJob = new Map<string, CronFailureReport[]>();
  for (const report of reports) byJob.set(report.jobId, [...(byJob.get(report.jobId) ?? []), report]);
  const jobs = [...byJob.values()].map((runs) => {
    const last = runs.reduce((a, b) => ((b.failedAt ?? 0) > (a.failedAt ?? 0) ? b : a));
    const count = Math.max(runs.length, extraFailures.get(last.jobId) ?? 0);
    return { last, count };
  });
  if (jobs.length === 1) {
    const { last, count } = jobs[0]!;
    if (count <= 1) return singleRunText(last.jobName, last.category);
    return `O agendamento “${last.jobName}” falhou ${count} vezes; a última: ${FAILURE_COPY[last.category]}. O trabalho ficou pendente; revise a execução antes de repetir.`;
  }
  const lines = jobs
    .sort((a, b) => b.count - a.count || a.last.jobName.localeCompare(b.last.jobName))
    .map(
      ({ last, count }) =>
        `- “${last.jobName}”: ${count} ${count === 1 ? "falha" : "falhas"}, a última em ${formatFailedAt(last.failedAt)} (${FAILURE_COPY[last.category]})`,
    );
  return `${jobs.length} agendamentos falharam. O trabalho ficou pendente; revise as execuções antes de repetir.\n${lines.join("\n")}`;
}

/** Omni connection state of a WhatsApp instance; anything else cannot be told here. */
async function defaultReachable(target: OwnerDirectTarget): Promise<boolean | null> {
  if (target.channel !== "whatsapp") return null;
  try {
    const instance = dbGetInstance(target.accountId);
    const connection = resolveOmniConnection();
    if (!instance?.instanceId || !connection) return null;
    const omni = createOmniClient({ baseUrl: connection.apiUrl, apiKey: connection.apiKey, timeoutMs: 3_000 });
    return (await omni.instances.status(instance.instanceId)).isConnected === true;
  } catch (cause) {
    // Omni down or slow: the chat's state cannot be told, so it is still tried.
    log.debug("Owner chat reachability unknown", { accountId: target.accountId, error: cause });
    return null;
  }
}

/** Connected chats first, then those whose state is unknown; chats known to be down are dropped. */
async function reachableTargets(
  targets: OwnerDirectTarget[],
  reachable: CronFailureReachability,
): Promise<{ ordered: OwnerDirectTarget[]; down: number }> {
  const states = await Promise.all(targets.map((target) => reachable(target)));
  const up = targets.filter((_, index) => states[index] === true);
  const unknown = targets.filter((_, index) => states[index] === null);
  return { ordered: [...up, ...unknown], down: states.filter((state) => state === false).length };
}

/**
 * Deliver reports, one message per owner (a digest when it covers several jobs or runs). Returns
 * the item ids that are settled: sent, or undeliverable after bounded attempts. The rest stay
 * pending for a later start. Nothing is sent to a chat known to be offline, and with no reachable
 * chat at all the reports settle as undeliverable at once, with the reason, instead of looping.
 */
export async function deliverCronFailureReports(
  reports: CronFailureReport[],
  deps: CronFailureNoticeDeps & { extraFailures?: Map<string, number> } = {},
): Promise<Set<string>> {
  const settled = new Set<string>();
  const byOwner = new Map<string, CronFailureReport[]>();
  for (const report of reports) byOwner.set(report.ownerKey, [...(byOwner.get(report.ownerKey) ?? []), report]);
  const deliver = deps.deliver ?? ((owner, message) => deliverToChat(owner, { text: message }));
  for (const group of byOwner.values()) {
    const { ordered, down } = await reachableTargets(group[0]!.targets, deps.reachable ?? defaultReachable);
    const text = cronFailureDigestText(group, deps.extraFailures);
    const reasons: string[] = [];
    let sentTo: OwnerDirectTarget | null = null;
    for (const target of ordered) {
      try {
        await deliver(target, text);
        sentTo = target;
        break;
      } catch (cause) {
        reasons.push(
          `${target.channel}:${target.accountId}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    for (const report of group) {
      if (sentTo) {
        markLocalInboxItem(report.itemId, "open", {
          eventType: "cron.failure.notified",
          actorType: "system",
          payload: { channel: sentTo.channel, accountId: sentTo.accountId, digest: group.length > 1 },
        });
        settled.add(report.itemId);
        continue;
      }
      const attempts = report.priorAttempts + 1;
      // No chat of the owner is reachable (all known offline, or none resolves): retrying at every
      // start cannot help, so fail closed now. A delivery that errored may be transient: retry, bounded.
      const hopeless = ordered.length === 0;
      markLocalInboxItem(report.itemId, "open", {
        eventType: "cron.failure.delivery_failed",
        actorType: "system",
        payload: { attempt: attempts, targets: report.targets.length, offline: down },
      });
      if (hopeless || attempts >= CRON_FAILURE_MAX_DELIVERY_ATTEMPTS) {
        markLocalInboxItem(report.itemId, "open", {
          eventType: "cron.failure.undeliverable",
          actorType: "system",
          payload: {
            attempts,
            reason:
              report.targets.length === 0 ? "no_owner_chat" : hopeless ? "owner_chats_offline" : "delivery_failed",
          },
        });
        settled.add(report.itemId);
      }
    }
    if (!sentTo) {
      const reason =
        group[0]!.targets.length === 0
          ? "no direct chat of the owner resolves"
          : ordered.length === 0
            ? `every chat of the owner is offline (${down})`
            : reasons.join("; ");
      log.warn("Cron failure notice not delivered", { owner: group[0]!.ownerKey, reports: group.length, reason });
    }
  }
  return settled;
}

/**
 * Deterministic delivery: reporting a broken model must never need that model.
 *
 * Returns true when the report is settled (sent, joined to a recent notice of the same job, owed
 * to nobody, older than the window, or undeliverable) and false when a later start should retry.
 */
export async function notifyCronFailure(
  job: CronFailureJob,
  error: string,
  deps: CronFailureNoticeDeps = {},
): Promise<boolean> {
  try {
    const report = prepareCronFailureReport(job, error, deps);
    if (!report) return true;
    const pending = Math.max(1, (deps.pendingFailures ?? countPendingCronFailures)(job.id));
    const settled = await deliverCronFailureReports([report], {
      ...deps,
      extraFailures: new Map([[job.id, pending]]),
    });
    return settled.has(report.itemId);
  } catch (error) {
    log.error("Cron failure notification failed; run remains failed and inbox stays open", { jobId: job.id, error });
    return false;
  }
}
