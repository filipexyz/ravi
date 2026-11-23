import { deliverToChat } from "../cloud-agents/chat-target.js";
import { listLocalInboxEvents, markLocalInboxItem, upsertLocalInboxItem } from "../inbox/local-db.js";
import { resolveOwnerDirectTarget, type OwnerDirectTarget } from "../knowledge/owner.js";
import { logger } from "../utils/logger.js";
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

/** The operator or a contact owns the run, so a direct message is owed (and retried until sent). */
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

/** Deterministic delivery: reporting a broken model must never need that model. */
export async function notifyCronFailure(
  job: CronFailureJob,
  error: string,
  deps: {
    owner?: typeof resolveCronFailureOwner;
    deliver?: (target: OwnerDirectTarget, text: string) => Promise<unknown>;
  } = {},
): Promise<boolean> {
  try {
    const category = classifyCronFailure(error);
    const target = (deps.owner ?? resolveCronFailureOwner)(job);
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
      assignedToContactId: target?.contactId,
      occurredAt: job.lastRunAt,
      // Raw provider errors may contain tokens, paths or prompts. Keep them in
      // the existing job diagnostics, never in the outbound message/inbox.
      metadata: { jobId: job.id, category, ownerPrincipal: job.ownerPrincipal ?? "unknown" },
      actorType: "system",
    });
    const events = listLocalInboxEvents(item.id);
    if (
      events.some((event) => event.eventType === "cron.failure.notified" || event.eventType === "cron.failure.unowned")
    )
      return true;
    // No person owns the run (`unknown`, an agent): no direct message is owed.
    // The inbox item is the report; settle it so it is not resent every start.
    if (!cronFailureOwesDirectMessage(job.ownerPrincipal)) {
      markLocalInboxItem(item.id, item.status, { eventType: "cron.failure.unowned", actorType: "system" });
      return true;
    }
    if (!target) {
      log.warn("Cron failure retained in inbox; owner has no direct delivery target", { jobId: job.id });
      return false;
    }
    await (deps.deliver ?? ((owner, text) => deliverToChat(owner, { text })))(target, summary);
    markLocalInboxItem(item.id, item.status, { eventType: "cron.failure.notified", actorType: "system" });
    return true;
  } catch (error) {
    log.error("Cron failure notification failed; run remains failed and inbox stays open", { jobId: job.id, error });
    return false;
  }
}
