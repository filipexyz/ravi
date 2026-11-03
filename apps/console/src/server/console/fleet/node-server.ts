import { createServer, type ServerOptions } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { FleetError } from "./contract";
import { certificateFingerprint } from "./node-pki";
import type { NodeManagementService } from "./nodes";

async function readBody(request: IncomingMessage) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new FleetError("invalid_request", 400);
  let length = 0; const parts: Buffer[] = [];
  for await (const value of request) {
    const part = Buffer.from(value); length += part.length;
    if (length > 65_536) throw new FleetError("request_too_large", 413);
    parts.push(part);
  }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; }
  catch { throw new FleetError("invalid_json", 400); }
}
function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

/** TLS terminates here: forwarding headers can never assert an installation identity. */
export function createNodeServer(tls: Pick<ServerOptions, "key" | "cert" | "ca">, service: NodeManagementService) {
  return createServer({ ...tls, requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3",
    requestTimeout: 15_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, async (request, response) => {
    const socket = request.socket as TLSSocket;
    const certificate = socket.getPeerCertificate();
    if (!socket.authorized || !certificate.raw || request.headers.origin) { json(response, { error: { code: "installation_required" } }, 403); return; }
    const fingerprint = certificateFingerprint(certificate.raw);
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    try {
      if (request.method === "GET" && request.url === "/commands") {
        await service.heartbeat(fingerprint);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        // Bounded stream lifetime makes certificate renewal and service replacement converge.
        const until = Date.now() + 60_000;
        while (!controller.signal.aborted && Date.now() < until) {
          const node = await service.heartbeat(fingerprint);
          const command = await service.nextCommand(fingerprint);
          if (command) response.write(`event: command\nid: ${command.operationId}\ndata: ${JSON.stringify(command)}\n\n`);
          else response.write(`event: heartbeat\ndata: ${JSON.stringify(node)}\n\n`);
          await delay(3_000, undefined, { signal: controller.signal });
        }
        response.end();
      } else if (request.method === "POST" && request.url === "/receipts") {
        json(response, await service.receipt(fingerprint, await readBody(request)));
      } else if (request.method === "POST" && request.url === "/rotate") {
        json(response, await service.rotate(fingerprint, await readBody(request)));
      } else json(response, { error: { code: "not_found" } }, 404);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (response.headersSent) { response.end(); return; }
      json(response, { error: { code: error instanceof FleetError ? error.code : "fleet_unavailable" } }, error instanceof FleetError ? error.status : 503);
    }
  });
}
