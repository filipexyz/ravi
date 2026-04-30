import { getActiveServer, isValidContextKey, subscribe } from "../auth.js";
import { RaviClient } from "./sdk/client.js";
import { createHttpTransport } from "./sdk/transport/http.js";

const DEFAULT_TIMEOUT_MS = 6000;

let cached = null; // { serverId, client }
let invalidated = false;

subscribe(() => {
  invalidated = true;
  cached = null;
});

function buildClient(server) {
  assertValidServerContextKey(server);
  const transport = createHttpTransport({
    baseUrl: server.baseUrl,
    contextKey: server.contextKey,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  return new RaviClient(transport);
}

export class NoActiveServerError extends Error {
  constructor() {
    super("No active server configured. Open the extension options page to add one.");
    this.name = "NoActiveServerError";
  }
}

export class InvalidContextKeyError extends Error {
  constructor() {
    super("Active server context key is invalid. Open the extension options page and paste an rctx_* runtime context key.");
    this.name = "InvalidContextKeyError";
  }
}

function assertValidServerContextKey(server) {
  if (!isValidContextKey(server?.contextKey)) {
    throw new InvalidContextKeyError();
  }
}

export async function getClient() {
  const server = await getActiveServer();
  if (!server) throw new NoActiveServerError();
  if (cached?.serverId === server.id && !invalidated) {
    return { client: cached.client, server };
  }
  const client = buildClient(server);
  cached = { serverId: server.id, client };
  invalidated = false;
  return { client, server };
}

export async function withClient(fn) {
  const { client, server } = await getClient();
  return fn(client, server);
}

export async function callBinary({ groupSegments, command, body }) {
  const server = await getActiveServer();
  if (!server) throw new NoActiveServerError();
  assertValidServerContextKey(server);
  const transport = createHttpTransport({
    baseUrl: server.baseUrl,
    contextKey: server.contextKey,
    timeoutMs: DEFAULT_TIMEOUT_MS * 2,
  });
  const response = await transport.call({ groupSegments, command, body, binary: true });
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = await response.arrayBuffer();
  return { contentType, body: buffer };
}
