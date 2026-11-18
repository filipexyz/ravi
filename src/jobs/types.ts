/**
 * Jobs: execução de chamada longa fora do turno.
 *
 * O problema que isto resolve: quando um agente roda um comando longo, o **turno
 * fica presa** nele. A mensagem seguinte da pessoa enfileira atrás do comando, o
 * agente não responde, e o runtime só sabe avisar que está ocupado — aviso é
 * sintoma, não solução.
 *
 * Aqui a chamada vira um job:
 *
 * 1. o comando é despachado para background e o agente recebe um id imediatamente;
 * 2. o turno segue livre — a próxima mensagem é processada na hora;
 * 3. quando o job termina, o desfecho volta para a sessão e o agente continua;
 * 4. o agente controla a chamada quando quiser (`wait`, `tail`, `kill`).
 *
 * O processo é do Ravi, não do provider: é isso que permite destacar, observar e
 * matar sem depender de suporte de cada runtime.
 */

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "killed";

export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "killed"];

export function isJobTerminal(status: JobStatus): boolean {
  return JOB_TERMINAL_STATUSES.includes(status);
}

/** Quem pediu o job. Promoção automática, detach por tempo e pedido explícito contam histórias diferentes. */
export type JobOrigin = "cli" | "agent" | "promotion" | "detach";

/**
 * Estado da entrega do desfecho na sessão.
 *
 * `pending`: ninguém está entregando. `inflight`: uma publicação foi reservada
 * e está em voo — ninguém mais publica até ela fechar ou a reserva envelhecer.
 * `notified`: chegou na fila da sessão.
 */
export type JobDeliveryState = "pending" | "inflight" | "notified";

export interface JobRecord {
  id: string;
  sessionName: string | null;
  agentId: string | null;
  command: string;
  cwd: string | null;
  status: JobStatus;
  pid: number | null;
  exitCode: number | null;
  signal: string | null;
  logPath: string;
  origin: JobOrigin;
  /**
   * Dono verificado no daemon quando o job foi criado: `operator` só quando o
   * pedido chegou ao daemon com o contexto do operador. Null quando ninguém foi
   * verificado (CLI local sem contexto, registro do detach, linha antiga).
   */
  ownerPrincipal: string | null;
  /** Quando o desfecho foi entregue na sessão. Null = ainda não avisado. */
  notifiedAt: number | null;
  /** Último motivo de falha ao entregar o desfecho; null quando nunca falhou. */
  deliveryError: string | null;
  deliveryAttempts: number;
  deliveryState: JobDeliveryState;
  /** Quando a entrega em voo foi reservada; null fora de `inflight`. */
  deliveryClaimedAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface JobCreateInput {
  id?: string;
  sessionName?: string | null;
  agentId?: string | null;
  command: string;
  cwd?: string | null;
  logPath: string;
  origin?: JobOrigin;
  /** Só quem resolveu o dono num contexto verificado do daemon passa isto. */
  ownerPrincipal?: string | null;
}
