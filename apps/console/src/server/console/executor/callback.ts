import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db";
import { ConsoleApiError } from "@/server/console/api-error";
import { findPagesSessionByToken, pagesPrivateAuthRepositoryForDb, pagesSessionActorKind } from "@/server/console/pages/auth";
import { execPagesConnector, pagesConnectorExecErrorBody, type PagesConnectorHostDeps } from "@/server/console/pages/connectors/host";
import { DELEGATED_PAGE_ACTIONS } from "./delegation";
import { completeOperation, reserveOperation } from "./ledger";
import { boundedJson, hash, pageOperationSchema, verifyDelegation, verifyExecutorProof } from "./protocol";

const callbackSchema = z.object({ delegation: z.string().min(1).max(16_384), operation: pageOperationSchema }).strict();
export async function executeDelegatedOperation(request: Request): Promise<Response> {
  try {
    const proof = await verifyExecutorProof((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""), "operation-callback");
    const { delegation, operation } = callbackSchema.parse(await boundedJson(request));
    if (proof.delegationHash !== hash(delegation)) throw new ConsoleApiError(401, { error: "executor_unauthorized" });
    const scope = await verifyDelegation(delegation, operation);
    if (!DELEGATED_PAGE_ACTIONS.has(operation.id)) throw new ConsoleApiError(403, { error: "executor_action_forbidden" });
    const session = await findPagesSessionByToken({ repository: pagesPrivateAuthRepositoryForDb(), sessionToken: operation.pagesSession });
    if (!session || pagesSessionActorKind(session) !== "human_viewer" || session.userId !== scope.actorId ||
        session.siteId !== scope.siteId || session.organizationId !== scope.organizationId) {
      throw new ConsoleApiError(401, { error: "executor_unauthorized" });
    }
    const [site] = await db.select().from(schema.pageSites).where(eq(schema.pageSites.id, scope.siteId)).limit(1);
    if (!site || site.activeReleaseId !== scope.releaseId || site.organizationId !== scope.organizationId || site.projectId !== scope.projectId) {
      throw new ConsoleApiError(403, { error: "executor_scope_changed" });
    }
    const recordId = await reserveOperation(operation, scope);
    // The marker is a local function dependency, NEVER parsed from HTTP.
    // Re-enter the original service so revocation and resource/view checks run
    // for first calls and replays alike. Pages worker owns this server-only seam.
    const result = await execPagesConnector(operation, { executorCallback: true } as PagesConnectorHostDeps & { executorCallback: true });
    await completeOperation(recordId);
    return Response.json({ output: result.output }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ConsoleApiError) return Response.json(pagesConnectorExecErrorBody(error), { status: error.status });
    if (error instanceof z.ZodError) return Response.json({ error: "payload_invalid" }, { status: 400 });
    return Response.json({ error: "executor_unavailable" }, { status: 503 });
  }
}
