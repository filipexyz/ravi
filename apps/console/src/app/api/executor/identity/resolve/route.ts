import { z } from "zod";
import { resolveOidcRuntimeIdentity } from "@/lib/auth/oidc-store";
import { getRuntimeOidcConfig } from "@/lib/auth/oidc-runtime";
import { ConsoleApiError } from "@/server/console/api-error";
import { boundedJson, hash, stableJson, verifyExecutorProof } from "@/server/console/executor/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const identitySchema = z.object({ issuer: z.string().url(), subject: z.string().min(1).max(512) }).strict();

export async function POST(request: Request) {
  try {
    if (process.env.RAVI_AUTH_MODE !== "oidc") throw new ConsoleApiError(503, { error: "executor_unconfigured" });
    const proof = await verifyExecutorProof((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""), "identity-resolve");
    const input = identitySchema.parse(await boundedJson(request));
    if (proof.bodyHash !== hash(stableJson(input)) || input.issuer !== (await getRuntimeOidcConfig(false)).issuer) {
      throw new ConsoleApiError(401, { error: "executor_unauthorized" });
    }
    const identity = await resolveOidcRuntimeIdentity(input);
    if (!identity) throw new ConsoleApiError(403, { error: "executor_identity_denied" });
    return Response.json(identity, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ConsoleApiError) return Response.json(error.payload, { status: error.status });
    if (error instanceof z.ZodError) return Response.json({ error: "payload_invalid" }, { status: 400 });
    return Response.json({ error: "executor_unavailable" }, { status: 503 });
  }
}
