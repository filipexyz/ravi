import { z } from "zod";
import { BridgeError } from "../../../bridge/protocol.js";
import { CONSOLE_STREAM_PATH } from "../console-contract.js";
import { consoleInvocationLive, type ConsoleInvocation } from "../console-context.js";
import { json } from "../errors.js";
import { journalSchema } from "../../../bridge/schemas.js";
import type { StreamChannel } from "./types.js";

const sessionViewOptions = z
  .object({
    projectId: z.string().uuid(),
    conversationId: z.string().uuid(),
    cursor: z.string().max(1500).optional(),
  })
  .strict();

/** The same channel registry drives runtime matching and all generated SDKs. */
export const sessionViewChannel: StreamChannel = {
  name: "session-view",
  meta: {
    methodName: "sessionView",
    pathPattern: "session-view",
    description: "Durable private session journal. Requires a fresh Console delegation; local runtime keys are denied.",
    optionsSchema: z.toJSONSchema(sessionViewOptions),
    payloadSchema: z.toJSONSchema(journalSchema),
    eventNames: ["journal", "gateway.error"],
  },
  match(segments, url) {
    return segments.length === 1 && segments[0] === "session-view"
      ? {
          channelPath: "session-view",
          scope: {
            permission: "access",
            objectType: "session",
            objectId: url.searchParams.get("conversationId") ?? "",
          },
        }
      : null;
  },
  consoleHandler: consoleSessionView,
  subscribe() {
    throw new BridgeError("CONSOLE_AUTHORITY_REQUIRED");
  },
};

/** Pull-based durable projection: slow readers retain their cursor, never silently lose events. */
export function consoleSessionView(request: Request, url: URL, invocation: ConsoleInvocation): Response {
  if (url.pathname !== CONSOLE_STREAM_PATH || request.method !== "GET")
    return json(403, { error: { code: "NOT_FOUND_OR_DENIED" } });
  const input = sessionViewOptions.parse(Object.fromEntries(url.searchParams));
  const { grant, service, enrollment } = invocation;
  if (
    grant.command !== "sessions.conversations.events" ||
    grant.access.kind !== "read" ||
    grant.access.resource !== "sessions.conversations" ||
    grant.access.action !== "events" ||
    grant.scope.kind !== "session" ||
    grant.scope.conversationId !== input.conversationId ||
    grant.projectId !== input.projectId ||
    (request.headers.has("last-event-id") && request.headers.get("last-event-id") !== input.cursor)
  )
    throw new BridgeError("NOT_FOUND_OR_DENIED");
  let cursor = input.cursor ?? null;
  const read = () => {
    if (!consoleInvocationLive(invocation)) throw new BridgeError("ACCESS_REVOKED");
    return journalSchema.parse(
      service.executeAuthorized(
        {
          command: "events",
          requestId: grant.operationId,
          createdAt: grant.createdAt,
          projectId: grant.projectId,
          conversationId: input.conversationId,
          cursor,
        },
        grant,
        enrollment,
      ),
    );
  };
  let first: ReturnType<typeof read> | null = read(); // Validate ownership and cursor before SSE headers.
  let closed = false;
  const startedAt = Date.now();
  const audit = (phase: "opened" | "closed", reason?: string) =>
    service.store.db
      .query(
        "INSERT INTO audit(created_at,enrollment_id,subject,request_id,operation,target,result) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        Date.now(),
        grant.enrollmentId,
        grant.sub,
        grant.operationId,
        `sdk.gateway.stream.${phase}`,
        input.conversationId,
        JSON.stringify({ policyRevision: grant.policyRevision, durationMs: Date.now() - startedAt, reason }),
      );
  audit("opened");
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    // Disconnect/daemon shutdown may race database closure. Never prolong access
    // or emit another private event to recover a failed close audit.
    try {
      audit("closed", reason);
    } catch {
      /* admission/open audit is already durable */
    }
  };
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      try {
        if (!first) await new Promise((resolve) => setTimeout(resolve, 250));
        if (closed) return;
        if (request.signal.aborted || !consoleInvocationLive(invocation)) {
          finish(request.signal.aborted ? "disconnected" : "authorization_expired");
          controller.close();
          return;
        }
        const batch = first ?? read();
        first = null;
        cursor = batch.cursor;
        controller.enqueue(encoder.encode(`id: ${cursor}\nevent: journal\ndata: ${JSON.stringify(batch)}\n\n`));
      } catch (error) {
        finish("failed");
        controller.enqueue(
          encoder.encode(
            `event: gateway.error\ndata: ${JSON.stringify({ code: error instanceof BridgeError ? error.code : "STREAM_FAILED" })}\n\n`,
          ),
        );
        controller.close();
      }
    },
    cancel() {
      finish("disconnected");
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
