/**
 * Quem é dono de um job, do jeito que o daemon consegue verificar.
 *
 * O env inteiro do daemon só vai para um job que o operador criou com o
 * contexto dele verificado no daemon: o pedido chegou pelo gateway (ou por uma
 * tool no processo) com a chave do operador. Um CLI local sem contexto não
 * prova nada, porque qualquer processo da máquina consegue rodar
 * `ravi jobs run` sem `RAVI_CONTEXT_KEY`.
 */

import { getContext } from "../cli/context.js";
import { CRON_OPERATOR_OWNER, resolveCronOwnerPrincipalForCurrentTurn } from "../link/connector-turn.js";
import type { JobRecord } from "./types.js";

export const JOB_OPERATOR_OWNER = CRON_OPERATOR_OWNER;

/**
 * O dono verificado do pedido atual, ou null quando nada foi verificado.
 * `operator` só sai quando o pedido carrega o contexto do operador no daemon.
 */
export function resolveVerifiedJobOwner(): string | null {
  const store = getContext({ localOnly: true });
  if (store?.transport !== "gateway" && store?.transport !== "tool") return null;
  const owner = resolveCronOwnerPrincipalForCurrentTurn();
  return owner && owner !== "unknown" ? owner : null;
}

/**
 * Só um job do operador verificado, sem sessão e sem agent, herda o env do
 * daemon. `--session` e `--agent` põem o job no lugar de um agent, então ele
 * começa filtrado mesmo quando o operador o criou do terminal.
 */
export function jobInheritsDaemonEnv(job: Pick<JobRecord, "ownerPrincipal" | "agentId" | "sessionName">): boolean {
  return job.ownerPrincipal === JOB_OPERATOR_OWNER && !job.agentId && !job.sessionName;
}
