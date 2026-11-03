import { and, eq } from "drizzle-orm";
import { db } from "@/server/db";
import { executorOperations } from "@/server/db/executor-schema";
import { ConsoleApiError } from "@/server/console/api-error";
import { hash, stableJson, type DelegationScope, type PageOperation } from "./protocol";
import { validateOperationReplay } from "./replay-policy";

export async function reserveOperation(operation: PageOperation, scope: DelegationScope): Promise<string | null> {
  if (operation.id !== "ravi.bases.views.rows.create") return null;
  const input = operation.input as { idempotencyKey?: unknown };
  if (typeof input?.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey)) {
    throw new ConsoleApiError(400, { error: "payload_invalid" });
  }
  const requestHash = hash(stableJson({ action: operation.id, input: operation.input, host: operation.host, origin: operation.origin }));
  const sessionHash = hash(operation.pagesSession);
  const fields = { organizationId: scope.organizationId, userId: scope.actorId, siteId: scope.siteId,
    action: operation.id, key: input.idempotencyKey, requestHash, sessionHash };
  await db.insert(executorOperations).values(fields).onConflictDoNothing();
  const [record] = await db.select().from(executorOperations).where(and(
    eq(executorOperations.organizationId, fields.organizationId), eq(executorOperations.userId, fields.userId),
    eq(executorOperations.siteId, fields.siteId), eq(executorOperations.action, fields.action), eq(executorOperations.key, fields.key),
  )).limit(1);
  if (!record) throw new ConsoleApiError(503, { error: "executor_unavailable" });
  validateOperationReplay(record, requestHash, sessionHash);
  // Not a get/delete one-shot token: Bases reserves the underlying write in its
  // transaction, with a unique source/session/operation/key. Pending after a
  // crash is safe to retry only inside that guaranteed window.
  return record.id;
}
export async function completeOperation(id: string | null) {
  if (id) await db.update(executorOperations).set({ status: "completed", completedAt: new Date() }).where(eq(executorOperations.id, id));
}
