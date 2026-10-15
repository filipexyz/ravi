/**
 * In-process audit labels that ride in `ToolContext.agentId` without naming an
 * agent. They label logs and attribution only and never reach authorization:
 * a caller running under one decides from its runtime context record alone.
 *
 * Empty for now: no audit-only label exists on this branch. A feature that adds
 * one (for example a Pages app gateway) registers it here.
 */
const AUDIT_ONLY_AGENT_LABELS: ReadonlySet<string> = new Set<string>();

/**
 * The agent id an authorization request may name for a caller: its own agent
 * id, or undefined when it is an audit-only label.
 *
 * Use it only where an agent id becomes a subject or fills a context record.
 * The local-operator check (`isLocalOperatorScope`) keeps the raw id, so a label
 * without a context record still fails closed instead of becoming the operator.
 */
export function authorizationAgentId(agentId: string | null | undefined): string | undefined {
  return agentId && !AUDIT_ONLY_AGENT_LABELS.has(agentId) ? agentId : undefined;
}

/**
 * The capability context an authorization request carries for a caller.
 *
 * The record's own `agentId` wins. Otherwise the caller's agent fills it,
 * unless that id is an audit-only label, which must never reach providers as
 * an `agent:<label>` subject.
 */
export function authorizationContext<T extends { agentId?: string | null }>(
  context: T,
  callerAgentId: string | null | undefined,
): T {
  if (context.agentId) return context;
  const agentId = authorizationAgentId(callerAgentId);
  return agentId ? { ...context, agentId } : context;
}
