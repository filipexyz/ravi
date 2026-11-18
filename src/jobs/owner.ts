/**
 * Quem é dono de um job, do jeito que o daemon consegue verificar.
 *
 * O env inteiro do daemon só vai para um job que o operador criou com o
 * contexto dele verificado no daemon: o pedido chegou pelo gateway (ou por uma
 * tool no processo) com a chave do operador. É o caminho do `ravi` instalado
 * no terminal do operador, que despacha para o gateway com a credencial dele.
 * Um CLI local sem contexto (checkout de dev, ou `env -u RAVI_CONTEXT_KEY`) não
 * prova nada e grava o job sem dono.
 */

import { getContext } from "../cli/context.js";
import { CRON_OPERATOR_OWNER, resolveCronOwnerPrincipalForCurrentTurn } from "../link/connector-turn.js";
import type { JobRecord } from "./types.js";

export const JOB_OPERATOR_OWNER = CRON_OPERATOR_OWNER;

/**
 * O dono verificado do pedido atual, ou null quando nada foi verificado.
 * `operator` só sai quando o pedido carrega o contexto do operador no daemon.
 */
export function resolveVerifiedJobOwner(
  deps: { transport?: () => string | undefined; resolveOwner?: () => string } = {},
): string | null {
  const transport = deps.transport ? deps.transport() : getContext({ localOnly: true })?.transport;
  if (transport !== "gateway" && transport !== "tool") return null;
  const owner = (deps.resolveOwner ?? resolveCronOwnerPrincipalForCurrentTurn)();
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
