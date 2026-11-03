import { z } from "zod";
import { ConsoleApiError } from "../api-error";
import { decideInTransaction } from "./store";
import type { AuthorizationExecutor } from "./identity";
import type { ProjectAction } from "./policy";

// Written only from the verified CLI adapter. This is a bounded continuation of
// that session, NOT a permanent service principal. Refresh/revoke/expiry stops it.
const storedActor = z.object({ organizationId: z.uuid(), userId: z.uuid(), delegation: z.object({
  installationId: z.uuid(), sessionId: z.uuid(), bindingId: z.uuid().nullable(), accessTokenJti: z.string().min(1).max(200),
}).strict() }).strict();

export async function storedActorCan(executor: AuthorizationExecutor, value: unknown, scope: {
  organizationId: string; projectId: string; installationId: string; userId?: string;
}, action: ProjectAction) {
  const parsed = storedActor.safeParse(value);
  if (!parsed.success || parsed.data.organizationId !== scope.organizationId ||
    parsed.data.delegation.installationId !== scope.installationId || (scope.userId && parsed.data.userId !== scope.userId)) return false;
  try {
    return (await decideInTransaction(executor, parsed.data, scope.projectId, action, crypto.randomUUID())).allowed;
  } catch (error) {
    if (error instanceof ConsoleApiError && error.status === 403) return false;
    throw error;
  }
}
