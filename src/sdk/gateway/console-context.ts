import { AsyncLocalStorage } from "node:async_hooks";
import type { ConsoleGrant } from "./console-contract.js";
import type { BridgeService } from "../../bridge/service.js";
import type { Enrollment } from "../../bridge/store.js";
import type { CliCommandAccessInput, CliCommandAccessResult } from "../../cli/command-access.js";

export interface ConsoleInvocation {
  grant: ConsoleGrant;
  enrollment: Enrollment;
  service: BridgeService;
}
const invocations = new AsyncLocalStorage<ConsoleInvocation>();
export const currentConsoleInvocation = () => invocations.getStore();
export const withConsoleInvocation = <T>(value: ConsoleInvocation, fn: () => T) => invocations.run(value, fn);

/** Resolve a private session through the durable owner/project binding, never a name convention. */
export function consoleSessionTarget(ref: string): string | null {
  const invocation = currentConsoleInvocation();
  if (!invocation || !consoleInvocationLive(invocation) || invocation.grant.scope.kind !== "session") return null;
  const { grant, service, enrollment } = invocation;
  if (grant.scope.kind !== "session") return null;
  try {
    const row = service.store.authorizedConversation(
      grant.scope.conversationId,
      enrollment,
      grant.sub,
      grant.projectId,
    );
    if (
      !grant.agents.some((agent) => agent.id === row.agent_id) ||
      ![row.id, row.session_key, row.session_name].includes(ref)
    )
      return null;
    return row.session_key;
  } catch {
    return null;
  }
}

export function consoleInvocationLive(value: ConsoleInvocation): boolean {
  const { grant, service } = value;
  const enrollment = service.store.enrollment(grant.enrollmentId);
  const head = service.store.db
    .query<{ revision: number; digest: string }, [string, string, string]>(
      "SELECT revision,digest FROM delegation_heads WHERE enrollment_id=? AND subject=? AND project_id=?",
    )
    .get(grant.enrollmentId, grant.sub, grant.projectId);
  return (
    grant.exp * 1000 > Date.now() &&
    Boolean(
      enrollment?.active &&
        enrollment.epoch === grant.epoch &&
        head?.revision === grant.policyRevision &&
        head.digest === grant.policyDigest,
    )
  );
}

/** The signed decision is final; it never falls back to the local operator/provider chain. */
export function authorizeConsoleCommand(
  value: ConsoleInvocation,
  input: CliCommandAccessInput,
): CliCommandAccessResult {
  const { grant } = value;
  const allowed =
    consoleInvocationLive(value) &&
    grant.command === input.canonicalName &&
    Boolean(
      input.access &&
        input.access.kind === grant.access.kind &&
        input.access.resource === grant.access.resource &&
        input.access.action === grant.access.action,
    );
  return { allowed, attempted: [], errorMessage: allowed ? "" : "Console delegation does not authorize this command" };
}
