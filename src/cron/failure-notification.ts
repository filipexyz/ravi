import { deliverToChat } from "../cloud-agents/chat-target.js";
import { listLocalInboxEvents, markLocalInboxItem, upsertLocalInboxItem } from "../inbox/local-db.js";
import { resolveOwnerDirectTarget, type OwnerDirectTarget } from "../knowledge/owner.js";
import { logger } from "../utils/logger.js";
import type { CronJob } from "./types.js";

const log = logger.child("cron:failure-notification");

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

/** Deterministic delivery: reporting a broken model must never need that model. */
export async function notifyCronFailure(
  job: CronJob,
  error: string,
  deps: {
    owner?: typeof resolveCronFailureOwner;
    deliver?: (target: OwnerDirectTarget, text: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  try {
    const category = classifyCronFailure(error);
    const target = (deps.owner ?? resolveCronFailureOwner)(job);
    const summary = `O agendamento “${job.name}” falhou: ${FAILURE_COPY[category]}. O trabalho ficou pendente; revise a execução antes de repetir.`;
    const { item } = upsertLocalInboxItem({
      sourceDomain: "cron",
      sourceType: "run_failed",
      sourceId: job.id,
      dedupeKey: `cron-failure:${job.id}:${job.lastRunAt ?? job.updatedAt}`,
      title: `Falha no agendamento: ${job.name}`,
      summary,
      priority: "high",
      assignedToAgentId: job.agentId,
      assignedToContactId: target?.contactId,
      occurredAt: job.lastRunAt,
      // Raw provider errors may contain tokens, paths or prompts. Keep them in
      // the existing job diagnostics, never in the outbound message/inbox.
      metadata: { jobId: job.id, category, ownerPrincipal: job.ownerPrincipal ?? "operator" },
      actorType: "system",
    });
    if (listLocalInboxEvents(item.id).some((event) => event.eventType === "cron.failure.notified")) return;
    if (!target) {
      log.warn("Cron failure retained in inbox; owner has no direct delivery target", { jobId: job.id });
      return;
    }
    await (deps.deliver ?? ((owner, text) => deliverToChat(owner, { text })))(target, summary);
    markLocalInboxItem(item.id, item.status, { eventType: "cron.failure.notified", actorType: "system" });
  } catch (error) {
    log.error("Cron failure notification failed; run remains failed and inbox stays open", { jobId: job.id, error });
  }
}
