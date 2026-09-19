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

/** Quem pediu o job. Promoção automática e pedido explícito contam histórias diferentes. */
export type JobOrigin = "cli" | "agent" | "promotion";

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
  /** Quando o desfecho foi entregue na sessão. Null = ainda não avisado. */
  notifiedAt: number | null;
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
}
