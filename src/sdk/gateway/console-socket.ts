import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { requestDigest, type runtimeIdentity } from "../../bridge/auth.js";
import type { BridgeService } from "../../bridge/service.js";
import { consoleRuntimeProof } from "./console-auth.js";
import { CONSOLE_MAX_BODY, CONSOLE_PROOF_PATH } from "./console-contract.js";
import { createGatewayHandlerContext, type GatewayHandlerContext } from "./server.js";
import { handleConsoleRequest } from "./console-handler.js";
import { buildMetaPayload } from "./route-table.js";

/** A fixed Unix HTTP socket behind restricted SSH. No command framing, shell or port forwarding. */
export async function serveConsoleSocket(
  service: BridgeService,
  identity: ReturnType<typeof runtimeIdentity>,
  path: string,
  gateway: GatewayHandlerContext = createGatewayHandlerContext(),
) {
  const connections = new Map<Socket, string>();
  const registry = buildMetaPayload(gateway.table);
  const catalog = {
    ...registry,
    commands: registry.commands.filter((cmd) => cmd.access?.consoleScope && cmd.scope !== "superadmin"),
  };
  catalog.commandCount = catalog.commands.length;
  const server = createServer(
    { maxHeaderSize: 32_768, requestTimeout: 35_000, headersTimeout: 10_000 },
    async (incoming, outgoing) => {
      const abort = new AbortController();
      outgoing.once("close", () => abort.abort());
      try {
        const target = incoming.url ?? "";
        if (!target.startsWith("/api/v1/") || target.startsWith("//") || /[\r\n#]/.test(target)) throw new Error();
        const connectionId = connections.get(incoming.socket);
        if (!connectionId) throw new Error();
        if (incoming.method === "GET" && target === CONSOLE_PROOF_PATH) {
          const proof = await consoleRuntimeProof(identity, connectionId, requestDigest(catalog));
          // Registry is authoritative metadata from this same pinned runtime; no browser catalog is accepted.
          outgoing.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          outgoing.end(JSON.stringify({ ...proof, registry: catalog, registryDigest: requestDigest(catalog) }));
          return;
        }
        const body = await readBody(incoming);
        if (incoming.method === "GET" && body.length) throw new Error("GET body is not supported");
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        // The target is fixed, not an HTTP proxy. Reject noncanonical URL normalization.
        const url = new URL(target, "http://ravi.internal");
        if (url.pathname + url.search !== target) throw new Error();
        const request = new Request(url.toString(), {
          method: incoming.method,
          headers,
          body: incoming.method === "GET" ? undefined : body,
          signal: abort.signal,
        });
        const response = await handleConsoleRequest(request, connectionId, service, gateway);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) {
          const reader = response.body.getReader();
          const onAbort = () => void reader.cancel();
          abort.signal.addEventListener("abort", onAbort, { once: true });
          try {
            while (!abort.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              if (!outgoing.write(value)) await Promise.race([once(outgoing, "drain"), once(outgoing, "close")]);
            }
          } finally {
            abort.signal.removeEventListener("abort", onAbort);
            await reader.cancel();
          }
        }
        outgoing.end();
      } catch {
        if (!outgoing.headersSent) outgoing.writeHead(400, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { code: "INVALID_REQUEST" } }));
      }
    },
  );
  server.maxRequestsPerSocket = 32;
  server.on("connection", (socket) => {
    if (connections.size >= 32) {
      socket.destroy();
      return;
    }
    connections.set(socket, randomUUID());
    socket.setTimeout(35_000, () => socket.destroy());
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
  });
  server.listen(path);
  await once(server, "listening");
  chmodSync(path, 0o660);
  return {
    async stop() {
      for (const socket of connections.keys()) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > CONSOLE_MAX_BODY) throw new Error("Body limit");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
