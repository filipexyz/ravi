import { BridgeError } from "../../bridge/protocol.js";
import type { BridgeService } from "../../bridge/service.js";
import { requestDigest } from "../../bridge/auth.js";
import { verifyConsoleRequest } from "./console-auth.js";
import { withConsoleInvocation, consoleSessionTarget, type ConsoleInvocation } from "./console-context.js";
import { CONSOLE_MAX_BODY, CONSOLE_STREAM_PATH } from "./console-contract.js";
import { handleGatewayRequest, type GatewayHandlerContext } from "./server.js";
import { json } from "./errors.js";

/** Dedicated authority boundary; the ordinary CLI listener never calls this. */
export async function handleConsoleRequest(
  request: Request,
  connectionId: string,
  service: BridgeService,
  gateway: GatewayHandlerContext,
): Promise<Response> {
  let dispatched = false;
  try {
    const raw = await boundedBody(request);
    const invocation = await verifyConsoleRequest(service, request, raw, connectionId);
    const { grant } = invocation;
    const url = new URL(request.url);
    const cmd = gateway.table.byPath.get(
      url.pathname === CONSOLE_STREAM_PATH ? "/api/v1/sessions/conversations/events" : url.pathname,
    );
    if (
      !cmd ||
      cmd.cliOnly ||
      cmd.scope === "superadmin" ||
      cmd.fullName !== grant.command ||
      !cmd.access?.consoleScope ||
      cmd.access.kind !== grant.access.kind ||
      cmd.access.resource !== grant.access.resource ||
      cmd.access.action !== grant.access.action
    )
      throw new BridgeError("NOT_FOUND_OR_DENIED");
    // Project membership is not authority for installation-wide commands. Private sessions
    // resolve their durable owner/project binding in the storage adapter, never by name.
    if (cmd.access.consoleScope !== grant.scope.kind) throw new BridgeError("RESOURCE_SCOPE_REQUIRED");
    if (cmd.groupPath !== "sessions.conversations") {
      if (grant.scope.kind === "session") {
        const body = JSON.parse(raw);
        const ref = body[cmd.access.resourceId ?? ""];
        if (typeof ref !== "string" || !withConsoleInvocation(invocation, () => consoleSessionTarget(ref)))
          throw new BridgeError("NOT_FOUND_OR_DENIED");
        // A session grant cannot change its agent or siblings. The command's
        // ordinary local flags remain available only with ordinary local authority.
        if (body.propagate === true) throw new BridgeError("RESOURCE_SCOPE_REQUIRED");
      }
    }
    if (request.headers.has("x-ravi-cwd") || request.headers.has("x-ravi-caller-cwd"))
      throw new BridgeError("INVALID_REQUEST");
    if (raw && Object.hasOwn(JSON.parse(raw), "cwd")) throw new BridgeError("INVALID_REQUEST");
    const fresh = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" ? undefined : raw,
      signal: request.signal,
    });
    const execute = () =>
      withConsoleInvocation(invocation, async () => {
        // Audit admission before any effect. A failure afterwards is uncertain,
        // never a claim that the operation did not execute.
        const audit = service.store.db
          .query(
            "INSERT INTO audit(created_at,enrollment_id,subject,request_id,operation,target,result) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            Date.now(),
            grant.enrollmentId,
            grant.sub,
            grant.operationId,
            grant.command,
            grant.scope.kind === "session" ? grant.scope.conversationId : grant.projectId,
            JSON.stringify({
              state: "admitted",
              origin: grant.origin.kind,
              policyRevision: grant.policyRevision,
            }),
          );
        dispatched = true;
        const response =
          (await handleGatewayRequest(fresh, { ...gateway, allowSuperadmin: false })) ??
          json(404, { error: "NOT_FOUND_OR_DENIED" });
        service.store.db.query("UPDATE audit SET result=? WHERE rowid=?").run(
          JSON.stringify({
            status: response.status,
            origin: grant.origin.kind,
            policyRevision: grant.policyRevision,
          }),
          audit.lastInsertRowid,
        );
        return response;
      });
    // Private-session mutations already atomically persist message, receipt and dispatch.
    if (cmd.groupPath === "sessions.conversations" || cmd.access.kind === "read") return await execute();
    return await journalCommand(invocation, raw, url.pathname, execute);
  } catch (error) {
    const effectState = error instanceof BridgeError ? error.effectState : dispatched ? "unknown" : "none";
    const code = error instanceof BridgeError ? error.code : dispatched ? "EXECUTION_UNKNOWN" : "INVALID_REQUEST";
    return json(
      effectState === "unknown" ? 503 : code === "INVALID_DELEGATION" || code === "ASSERTION_REPLAY" ? 401 : 403,
      {
        success: false,
        error: { code, message: code },
        effectState,
      },
    );
  }
}

async function boundedBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CONSOLE_MAX_BODY) throw new BridgeError("PAYLOAD_TOO_LARGE");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
  }
}

/** Generic effects cannot share an atomic transaction with arbitrary handlers. Unknown
 * admission is durable and is never executed a second time after a crash or lost reply. */
async function journalCommand(value: ConsoleInvocation, raw: string, path: string, execute: () => Promise<Response>) {
  const { grant, service } = value;
  const digest = requestDigest({ path, raw, createdAt: grant.createdAt, projectId: grant.projectId });
  const key = [grant.enrollmentId, grant.sub, grant.operationId] as const;
  const found = service.store.atomic(() => {
    if (
      service.store.db.query("SELECT 1 FROM receipts WHERE enrollment_id=? AND subject=? AND request_id=?").get(...key)
    )
      throw new BridgeError("IDEMPOTENCY_CONFLICT");
    const row = service.store.db
      .query<{ digest: string; status: number | null; body: string | null }, [string, string, string]>(
        "SELECT digest,status,body FROM gateway_receipts WHERE enrollment_id=? AND subject=? AND operation_id=?",
      )
      .get(...key);
    if (row) return row;
    if (grant.createdAt < Date.now() - 600_000 || grant.createdAt > Date.now() + 5000)
      throw new BridgeError("REQUEST_EXPIRED");
    service.store.db
      .query("INSERT INTO gateway_receipts(enrollment_id,subject,operation_id,digest) VALUES (?,?,?,?)")
      .run(...key, digest);
    return null;
  });
  if (found) {
    if (found.digest !== digest) throw new BridgeError("IDEMPOTENCY_CONFLICT");
    if (!found.status || found.body === null) throw new BridgeError("EXECUTION_UNKNOWN", "unknown");
    return new Response(found.body, { status: found.status, headers: { "content-type": "application/json" } });
  }
  const response = await execute();
  const body = await response.text();
  service.store.db
    .query("UPDATE gateway_receipts SET status=?,body=? WHERE enrollment_id=? AND subject=? AND operation_id=?")
    .run(response.status, body, ...key);
  return new Response(body, { status: response.status, headers: response.headers });
}
