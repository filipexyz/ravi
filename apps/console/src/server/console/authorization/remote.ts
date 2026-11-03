/** Versioned decision query for a verified linked human. Not an execution token
 * and not a claim that a Ravi permission provider is installed. */
import { z, ZodError } from "zod";
import { authenticateCliRequest } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";
import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { ConsoleApiError } from "../api-error";
import { PROJECT_ACTIONS } from "./policy";
import { authorizationStore } from "./store";

export const decisionRequestSchema = z.object({
  version: z.literal(1), resource: z.object({ type: z.literal("project"), id: z.uuid() }).strict(),
  action: z.enum(PROJECT_ACTIONS),
}).strict();

export async function handleRemoteDecision(request: Request) {
  const requestId = crypto.randomUUID();
  const respond = (body: unknown, status = 200) => Response.json(body, { status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  try {
    const auth = await authenticateCliRequest(request, requestId, { touch: false, access: "read", actor: "contact", unlinkedReads: "refuse" });
    if (!auth.delegation) return respond({ error: "linked_human_required" }, 403);
    if (!auth.scopes.includes("console.projects.read")) return respond({ error: "scope_required" }, 403);
    if (request.method !== "POST") return respond({ error: "method_not_allowed" }, 405);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return respond({ error: "json_required" }, 415);
    const reader = request.body?.getReader();
    if (!reader) return respond({ error: "invalid_request" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) { await reader.cancel(); return respond({ error: "payload_too_large" }, 413); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return respond({ error: "invalid_request" }, 400); }
    const input = decisionRequestSchema.parse(decoded);
    const delegation = projectAuthorizationFromCli(auth);
    const decision = await authorizationStore.decide({ userId: auth.user.id, organizationId: auth.organization.id, delegation }, input.resource.id, input.action, requestId);
    return respond({ version: 1, requestId, ...decision, action: input.action, resource: input.resource,
      subject: { type: "linked_human", userId: auth.user.id, organizationId: auth.organization.id,
        installationId: delegation.installationId, bindingId: delegation.bindingId },
      evaluatedAt: new Date().toISOString(), cacheMaxAgeSeconds: 0, reusableCapability: false,
      agentAttestation: "not_supported" });
  } catch (error) {
    if (error instanceof CliApiError) return respond({ error: error.code }, error.status);
    if (error instanceof ConsoleApiError) return respond(error.payload, error.status);
    if (error instanceof ZodError) return respond({ error: "invalid_request" }, 400);
    return respond({ error: "authorization_unavailable" }, 503);
  }
}
