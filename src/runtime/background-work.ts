/**
 * Trabalho em background de uma sessão: o que impede o despejo por inatividade e
 * o que acorda a sessão quando termina.
 *
 * O defeito que isto fecha (bug 081dac32): o reclaimer media idle só pelo turno.
 * Um Bash com `run_in_background` termina o turno com "You will be notified when
 * it completes", a sessão fica sem turno, o TTL de idle (5 min) despeja o
 * processo do provider e a notificação — que vivia dentro desse processo — some.
 * A pessoa ficou 2h sem resposta.
 *
 * Duas defesas, não alternativas:
 *
 * 1. **Pendência não é idle.** Antes de despejar, o reclaimer consulta os jobs do
 *    Ravi ainda não terminais da sessão e as tasks nativas do provider abertas
 *    (`task_started` sem `task_notification`). Com pendência, vale um TTL próprio,
 *    maior e explícito (`RAVI_RUNTIME_BACKGROUND_TASK_TTL_MS`). Estourado esse
 *    TTL a sessão é despejada mesmo assim, e a task nativa — que morre com o
 *    processo — é reportada à sessão como falha, num prompt durável.
 * 2. **Conclusão é durável e acorda a sessão.** Bash em background vira job do
 *    Ravi (hook `jobs-promote`), cujo desfecho fica no banco e entra pela fila
 *    durável de prompts, com a sessão viva ou não. Task nativa que termina sem
 *    turno ativo também entra pela fila durável, em vez de depender do provider
 *    começar um turno sozinho.
 *
 * Reset/delete explícito não passa por aqui: descartar continua sendo permitido.
 */

import { dbListPendingJobIdsForSession } from "../jobs/store.js";
import { publishSessionPrompt } from "../omni/session-stream.js";
import { logger } from "../utils/logger.js";

const log = logger.child("runtime:background-work");

export const RUNTIME_BACKGROUND_TASK_TTL_MS_ENV = "RAVI_RUNTIME_BACKGROUND_TASK_TTL_MS";
/** Quanto uma sessão com pendência pode ficar sem turno antes de ser despejada mesmo assim. */
export const DEFAULT_RUNTIME_BACKGROUND_TASK_TTL_MS = 60 * 60 * 1000;

export const BACKGROUND_TASK_LOST_REASON = "background_task_ttl";

export function resolveRuntimeBackgroundTaskTtlMs(value = process.env[RUNTIME_BACKGROUND_TASK_TTL_MS_ENV]): number {
  if (value === undefined || value === null || value.trim() === "") return DEFAULT_RUNTIME_BACKGROUND_TASK_TTL_MS;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RUNTIME_BACKGROUND_TASK_TTL_MS;
  return parsed;
}

/** Task aberta pelo provider (Bash/Agent em background) que ainda não reportou conclusão. */
export interface NativeBackgroundTask {
  taskId: string;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  startedAt: number;
}

/** O pedaço da sessão de streaming que este módulo lê e escreve. */
export interface BackgroundWorkHolder {
  pendingBackgroundTasks?: Map<string, NativeBackgroundTask>;
  /**
   * Avisos de background que a fila durável ainda não aceitou. A task já saiu de
   * `pendingBackgroundTasks` (o processo acabou), mas o desfecho ainda não chegou
   * a lugar durável: enquanto houver entrada aqui a sessão não é idle.
   */
  undeliveredBackgroundWakes?: Map<string, UndeliveredBackgroundWake>;
}

/** Aviso de background com publicação recusada, ainda em reentrega. */
export interface UndeliveredBackgroundWake {
  wakeId: string;
  kind: BackgroundWakeMeta["kind"];
  taskIds: string[];
  attempts: number;
  since: number;
}

export interface BackgroundWakeMeta {
  kind: "native_task_finished" | "native_task_lost";
  taskIds: string[];
}

export type NativeBackgroundTaskStatus = "completed" | "failed" | "stopped" | "killed";

export type NativeBackgroundTaskObservation =
  | { kind: "started"; task: NativeBackgroundTask }
  | {
      kind: "finished";
      task: NativeBackgroundTask;
      status: NativeBackgroundTaskStatus;
      summary?: string;
      outputFile?: string;
    }
  | { kind: "ignored" };

const TERMINAL_PATCH_STATUSES = new Set(["completed", "failed", "killed"]);

/**
 * Lê um envelope cru do provider e atualiza as tasks abertas da sessão.
 *
 * Só `task_notification` produz `finished`: é ela que traz resumo e arquivo de
 * saída. `task_updated` terminal tira a task da contagem de pendência (o
 * processo já acabou) mas não acorda ninguém — a notificação vem logo atrás.
 */
export function observeNativeBackgroundTaskEvent(
  holder: BackgroundWorkHolder,
  rawEvent: unknown,
  now = Date.now(),
): NativeBackgroundTaskObservation {
  if (!rawEvent || typeof rawEvent !== "object") return { kind: "ignored" };
  const event = rawEvent as Record<string, unknown>;
  if (event.type !== "system") return { kind: "ignored" };
  const taskId = typeof event.task_id === "string" ? event.task_id : null;
  if (!taskId) return { kind: "ignored" };

  if (event.subtype === "task_started") {
    // Task de housekeeping do provider: não é trabalho que alguém espera.
    if (event.skip_transcript === true) return { kind: "ignored" };
    const task: NativeBackgroundTask = {
      taskId,
      startedAt: now,
      ...(typeof event.tool_use_id === "string" ? { toolUseId: event.tool_use_id } : {}),
      ...(typeof event.description === "string" ? { description: event.description } : {}),
      ...(typeof event.task_type === "string" ? { taskType: event.task_type } : {}),
    };
    holder.pendingBackgroundTasks ??= new Map();
    holder.pendingBackgroundTasks.set(taskId, task);
    return { kind: "started", task };
  }

  if (event.subtype === "task_updated") {
    const patch = (event.patch ?? {}) as Record<string, unknown>;
    if (typeof patch.status === "string" && TERMINAL_PATCH_STATUSES.has(patch.status)) {
      holder.pendingBackgroundTasks?.delete(taskId);
    }
    return { kind: "ignored" };
  }

  if (event.subtype === "task_notification") {
    const known = holder.pendingBackgroundTasks?.get(taskId);
    holder.pendingBackgroundTasks?.delete(taskId);
    const status = normalizeNotificationStatus(event.status);
    return {
      kind: "finished",
      task: known ?? {
        taskId,
        startedAt: now,
        ...(typeof event.tool_use_id === "string" ? { toolUseId: event.tool_use_id } : {}),
      },
      status,
      ...(typeof event.summary === "string" ? { summary: event.summary } : {}),
      ...(typeof event.output_file === "string" ? { outputFile: event.output_file } : {}),
    };
  }

  return { kind: "ignored" };
}

function normalizeNotificationStatus(value: unknown): NativeBackgroundTaskStatus {
  if (value === "completed" || value === "failed" || value === "stopped" || value === "killed") return value;
  return "failed";
}

export interface PendingBackgroundWork {
  nativeTasks: NativeBackgroundTask[];
  jobIds: string[];
  /** Desfechos cuja publicação na fila durável foi recusada e está em reentrega. */
  undeliveredWakes: UndeliveredBackgroundWake[];
}

export function listPendingBackgroundWork(sessionName: string, holder: BackgroundWorkHolder): PendingBackgroundWork {
  const nativeTasks = [...(holder.pendingBackgroundTasks?.values() ?? [])];
  const undeliveredWakes = [...(holder.undeliveredBackgroundWakes?.values() ?? [])];
  let jobIds: string[] = [];
  try {
    jobIds = dbListPendingJobIdsForSession(sessionName);
  } catch (error) {
    // Sem banco não dá para provar pendência de job; as tasks nativas ainda contam.
    log.warn("Could not read pending jobs for idle check", { sessionName, error });
  }
  return { nativeTasks, jobIds, undeliveredWakes };
}

export function hasPendingBackgroundWork(work: PendingBackgroundWork): boolean {
  return work.nativeTasks.length > 0 || work.jobIds.length > 0 || work.undeliveredWakes.length > 0;
}

/** A sessão carrega trabalho de provider que morre, ou se perde, com o processo dela. */
export function hasProcessBoundBackgroundWork(holder: BackgroundWorkHolder): boolean {
  return Boolean(holder.pendingBackgroundTasks?.size || holder.undeliveredBackgroundWakes?.size);
}

export type IdleEvictionDecision =
  | { evict: false; reason: "not_idle" }
  | { evict: false; reason: "background_work"; work: PendingBackgroundWork; retryInMs: number }
  | { evict: true; reason: "idle"; lostNativeTasks: [] }
  | {
      evict: true;
      reason: "background_task_ttl";
      work: PendingBackgroundWork;
      lostNativeTasks: NativeBackgroundTask[];
    };

/**
 * Decide o despejo passivo de uma sessão sem turno.
 *
 * Jobs do Ravi sobrevivem ao despejo (o processo é do daemon e o desfecho é
 * entregue pela fila durável); tasks nativas morrem com o processo do provider,
 * então são elas que viram relato de falha quando o TTL de pendência estoura.
 */
export function decideIdleEviction(input: {
  sessionName: string;
  holder: BackgroundWorkHolder;
  idleMs: number;
  idleTtlMs: number;
  backgroundTtlMs?: number;
}): IdleEvictionDecision {
  if (input.idleTtlMs <= 0 || input.idleMs < input.idleTtlMs) return { evict: false, reason: "not_idle" };
  const work = listPendingBackgroundWork(input.sessionName, input.holder);
  if (!hasPendingBackgroundWork(work)) return { evict: true, reason: "idle", lostNativeTasks: [] };
  const backgroundTtlMs = Math.max(input.idleTtlMs, input.backgroundTtlMs ?? resolveRuntimeBackgroundTaskTtlMs());
  if (input.idleMs < backgroundTtlMs) {
    return {
      evict: false,
      reason: "background_work",
      work,
      retryInMs: Math.max(1_000, Math.min(input.idleTtlMs, backgroundTtlMs - input.idleMs)),
    };
  }
  return { evict: true, reason: "background_task_ttl", work, lostNativeTasks: work.nativeTasks };
}

export function buildNativeBackgroundTaskOutcomePrompt(input: {
  task: NativeBackgroundTask;
  status: NativeBackgroundTaskStatus;
  summary?: string;
  outputFile?: string;
}): string {
  const label = input.task.description ? ` (${input.task.description})` : "";
  const lines = [`[System] Tarefa em background ${input.task.taskId}${label} terminou: ${input.status}.`];
  if (input.summary?.trim()) lines.push(`Resumo: ${input.summary.trim()}`);
  if (input.outputFile) lines.push(`Saída completa: ${input.outputFile}`);
  lines.push("Retome de onde parou: entregue o resultado a quem estava esperando.");
  return lines.join("\n");
}

export function buildBackgroundTaskLostPrompt(input: { tasks: NativeBackgroundTask[]; idleMs: number }): string {
  const minutes = Math.round(input.idleMs / 60_000);
  const ids = input.tasks.map((task) => (task.description ? `${task.taskId} (${task.description})` : task.taskId));
  return [
    `[System] A sessão ficou ${minutes} min sem turno com tarefa(s) em background aberta(s) e foi encerrada: ${ids.join(", ")}.`,
    "A tarefa morreu com o processo do provider e não vai reportar conclusão. Trate como falha:",
    "avise quem estava esperando e refaça o trabalho se ainda fizer sentido.",
  ].join("\n");
}

export type BackgroundWakePublisher = (
  sessionName: string,
  payload: Record<string, unknown>,
  options?: { messageId?: string },
) => Promise<void>;

/**
 * Entrega um aviso de background pela fila durável de prompts.
 *
 * A fila acorda a sessão se ela não estiver viva. É uma tentativa só: quem
 * precisa que o desfecho sobreviva a uma recusa usa `deliverBackgroundWake`.
 */
export async function publishBackgroundWake(
  sessionName: string,
  prompt: string,
  meta: BackgroundWakeMeta,
  publish: BackgroundWakePublisher = publishSessionPrompt,
  options: { messageId?: string } = {},
): Promise<void> {
  const payload = {
    prompt,
    deliveryBarrier: "after_response",
    deliveryBarrierSource: "default",
    _backgroundTask: meta,
  };
  if (options.messageId) {
    await publish(sessionName, payload, { messageId: options.messageId });
    return;
  }
  await publish(sessionName, payload);
}

/**
 * Espera entre tentativas de reentrega. Somadas dão ~17 min: cobre uma queda
 * curta da fila sem segurar a sessão além do TTL de pendência.
 */
export const BACKGROUND_WAKE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 30_000, 120_000, 300_000, 600_000];

/**
 * Id estável do aviso. Toda tentativa do mesmo desfecho usa o mesmo id, então
 * uma publicação que entrou na fila mas respondeu com erro não vira dois turnos.
 */
export function backgroundWakeMessageId(sessionName: string, meta: BackgroundWakeMeta): string {
  return `native-task:${sessionName}:${meta.kind}:${[...meta.taskIds].sort().join(",")}`;
}

export interface BackgroundWakeFailedAttempt {
  error: unknown;
  attempt: number;
  willRetry: boolean;
  retryInMs?: number;
}

export interface BackgroundWakeDelivery {
  delivered: boolean;
  attempts: number;
  wakeId: string;
}

function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Entrega um aviso de background e só o dá por entregue quando a fila aceita.
 *
 * Enquanto a publicação é recusada, o aviso fica em `undeliveredBackgroundWakes`
 * do holder (a sessão não é tratada como idle) e é reentregue com o mesmo id.
 * Esgotadas as tentativas, o chamador é avisado com `willRetry: false` para
 * deixar o desfecho em lugar durável (trace): a memória não sobrevive ao daemon.
 * Nunca rejeita.
 */
export async function deliverBackgroundWake(input: {
  sessionName: string;
  prompt: string;
  meta: BackgroundWakeMeta;
  holder?: BackgroundWorkHolder;
  publish?: BackgroundWakePublisher;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onAttemptFailed?: (failure: BackgroundWakeFailedAttempt) => void;
  now?: () => number;
}): Promise<BackgroundWakeDelivery> {
  const wakeId = backgroundWakeMessageId(input.sessionName, input.meta);
  const delays = input.retryDelaysMs ?? BACKGROUND_WAKE_RETRY_DELAYS_MS;
  const sleep = input.sleep ?? sleepUnref;
  const holder = input.holder;
  const entry: UndeliveredBackgroundWake = {
    wakeId,
    kind: input.meta.kind,
    taskIds: [...input.meta.taskIds],
    attempts: 0,
    since: (input.now ?? Date.now)(),
  };
  // Pendente desde antes da primeira tentativa: entre a task sair da contagem e
  // a fila aceitar o aviso não existe janela em que a sessão pareça idle.
  if (holder) {
    holder.undeliveredBackgroundWakes ??= new Map();
    holder.undeliveredBackgroundWakes.set(wakeId, entry);
  }
  const settle = () => {
    if (holder?.undeliveredBackgroundWakes?.get(wakeId) === entry) holder.undeliveredBackgroundWakes.delete(wakeId);
  };

  for (;;) {
    entry.attempts += 1;
    try {
      await publishBackgroundWake(input.sessionName, input.prompt, input.meta, input.publish, { messageId: wakeId });
      settle();
      return { delivered: true, attempts: entry.attempts, wakeId };
    } catch (error) {
      const retryInMs = delays[entry.attempts - 1];
      const willRetry = retryInMs !== undefined;
      log.warn("Background wake publish rejected", {
        sessionName: input.sessionName,
        wakeId,
        attempt: entry.attempts,
        willRetry,
        error,
      });
      input.onAttemptFailed?.({ error, attempt: entry.attempts, willRetry, ...(willRetry ? { retryInMs } : {}) });
      if (!willRetry) {
        settle();
        return { delivered: false, attempts: entry.attempts, wakeId };
      }
      await sleep(retryInMs);
    }
  }
}
