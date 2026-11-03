import { ZodError } from "zod";
import { ConsoleApiError } from "../api-error";
import type { AuthorizationActor } from "./identity";
import { authorizationStore } from "./store";

export type PolicyHttpDependencies = {
  authenticate: (request: Request) => Promise<AuthorizationActor | null>;
  canonicalOrigin: (requestUrl: string) => string;
  store?: typeof authorizationStore;
};
const MAX_BODY_BYTES = 128 * 1024;

export async function handlePolicyRequest(request: Request, segments: readonly string[], dependencies: PolicyHttpDependencies) {
  const response = (body: unknown, status = 200) => Response.json(body, { status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  try {
    const actor = await dependencies.authenticate(request);
    if (!actor) return response({ error: "unauthenticated" }, 401);
    const store = dependencies.store ?? authorizationStore;
    if (request.method === "GET" && segments.length === 0) return response(await store.read(actor));
    if (request.method !== "POST" || segments.length !== 1 || !["draft", "preview", "publish", "rollback", "simulate"].includes(segments[0]!)) {
      return response({ error: "not_found" }, 404);
    }
    // Strict for every auth mode, not the legacy hosted fallback accepting no Origin.
    if (request.headers.get("origin") !== dependencies.canonicalOrigin(request.url) ||
      ![null, "same-origin"].includes(request.headers.get("sec-fetch-site"))) return response({ error: "csrf_origin_invalid" }, 403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return response({ error: "json_required" }, 415);
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) return response({ error: "payload_too_large" }, 413);
    const reader = request.body?.getReader();
    if (!reader) return response({ error: "invalid_json" }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); return response({ error: "payload_too_large" }, 413); }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let body: unknown;
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return response({ error: "invalid_json" }, 400); }
    if (segments[0] === "draft") return response(await store.saveDraft(actor, body));
    if (segments[0] === "preview") return response(await store.preview(actor, body));
    if (segments[0] === "publish") return response(await store.publish(actor, body));
    if (segments[0] === "simulate") return response(await store.simulate(actor, body));
    return response(await store.prepareRollback(actor, body));
  } catch (error) {
    if (error instanceof ConsoleApiError) return response(error.payload, error.status);
    // Do not echo policy input, tokens, database statements or provider errors.
    if (error instanceof ZodError) return response({ error: "authorization_input_invalid", fields: error.issues.map((issue) => issue.path.join(".")).slice(0, 20) }, 400);
    return response({ error: "authorization_unavailable" }, 503);
  }
}
