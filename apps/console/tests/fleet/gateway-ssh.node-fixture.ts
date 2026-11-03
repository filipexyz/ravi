import { after as afterAll, before as beforeAll, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { Server, utils } from "ssh2";
import { SignJWT, importPKCS8 } from "jose";
import {
  gatewaySshExchange,
  gatewayOverSsh,
  type GatewayHttpCall,
} from "../../src/server/console/fleet/gateway-ssh";
import { CONSOLE_PROTOCOL, CONSOLE_PROOF_PATH, CONSOLE_SSH_COMMAND } from "../../src/shared/console-gateway";
import { canonicalBridgeJson } from "../../src/shared/human-bridge";
import type { BridgeBinding } from "../../src/server/console/fleet/bridge-config";
import type { Installation } from "../../src/server/console/fleet/contract";

const userKey = utils.generateKeyPairSync("ed25519").private,
  hostKey = utils.generateKeyPairSync("ed25519").private;
const host = utils.parseKey(hostKey),
  user = utils.parseKey(userKey);
if (host instanceof Error || user instanceof Error || Array.isArray(host) || Array.isArray(user))
  throw new Error();
const runtime = generateKeyPairSync("ed25519"),
  runtimeId = randomUUID();
const binding = {
  runtimeId,
  runtimePublicKey: runtime.publicKey.export({ type: "spki", format: "pem" }).toString(),
} as BridgeBinding;
const command = {
  fullName: "sessions.conversations.list",
  path: "/api/v1/sessions/conversations/list",
  scope: "resource",
  access: { kind: "read", resource: "sessions.conversations", action: "list", consoleScope: "project" },
};
const registry = { commands: [command] },
  digest = createHash("sha256").update(canonicalBridgeJson(registry)).digest("hex");
let broken = false,
  delegations = 0,
  commands = 0,
  authentications = 0,
  installation: Installation;
const connections = new Set<import("node:net").Socket>();
const dir = mkdtempSync(join(tmpdir(), "fleet-gateway-ssh-")),
  socketPath = join(dir, "gateway.sock");
const http = createServer(async (req, res) => {
  if (req.url === CONSOLE_PROOF_PATH) {
    const connectionId = randomUUID();
    const proof = await new SignJWT({
      protocol: CONSOLE_PROTOCOL,
      connectionId: broken ? randomUUID() : connectionId,
      registryDigest: digest,
    })
      .setProtectedHeader({ alg: "EdDSA" })
      .setIssuer(runtimeId)
      .setAudience(CONSOLE_PROTOCOL)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(
        await importPKCS8(runtime.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), "EdDSA"),
      );
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        protocol: CONSOLE_PROTOCOL,
        runtimeId,
        connectionId,
        proof,
        registry,
        registryDigest: digest,
      }),
    );
    return;
  }
  if (req.headers.authorization !== "Bearer delegated-test") {
    res.writeHead(401);
    res.end();
    return;
  }
  if (req.url?.includes("_stream")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('id: cursor-1\nevent: journal\ndata: {"events":[]}\n\n');
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ body: JSON.parse(body), sameSocket: true }));
});
http.on("connection", (s) => {
  connections.add(s);
  s.on("close", () => connections.delete(s));
});
const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on("error", () => {});
  client.on("authentication", (ctx) => {
    authentications++;
    if (
      ctx.method === "publickey" &&
      ctx.username === "bridge" &&
      ctx.key.data.equals(user.getPublicSSH()) &&
      (!ctx.signature || user.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
    )
      ctx.accept();
    else ctx.reject();
  });
  client.on("ready", () =>
    client.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, reject, info) => {
        if (info.command !== CONSOLE_SSH_COMMAND) return reject();
        commands++;
        const stream = acceptExec(),
          socket = createConnection(socketPath);
        stream.pipe(socket).pipe(stream);
        stream.on("close", () => socket.destroy());
        socket.on("error", () => stream.destroy());
      });
    }),
  );
});
beforeAll(async () => {
  await new Promise<void>((r) => http.listen(socketPath, r));
  await new Promise<void>((r) => ssh.listen(0, "127.0.0.1", r));
  installation = {
    hostname: "127.0.0.1",
    port: (ssh.address() as { port: number }).port,
    username: "bridge",
    hostFingerprint: `SHA256:${createHash("sha256").update(host.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
  } as Installation;
});
afterAll(async () => {
  for (const s of connections) s.destroy();
  await new Promise<void>((r) => http.close(() => r()));
  await new Promise<void>((r) => ssh.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
const call: GatewayHttpCall = {
  method: "POST",
  path: command.path,
  body: JSON.stringify({ projectId: randomUUID() }),
  operationId: randomUUID(),
  createdAt: Date.now(),
};
const delegate = async () => {
  delegations++;
  return "delegated-test";
};
test("restricted SSH carries HTTP proof and canonical request on the same channel", {
  timeout: 20000,
}, async () => {
  const response = await gatewaySshExchange(installation, userKey, binding, call, delegate, "127.0.0.1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { body: JSON.parse(call.body), sameSocket: true });
  assert.equal(commands, 1);
  assert.equal(delegations, 1);
});
test("bad host pin and bad signed runtime proof never receive delegation", { timeout: 20000 }, async () => {
  const before = delegations;
  await assert.rejects(
    gatewaySshExchange(
      { ...installation, hostFingerprint: `SHA256:${"a".repeat(43)}` },
      userKey,
      binding,
      call,
      delegate,
      "127.0.0.1",
    ),
  );
  broken = true;
  try {
    await assert.rejects(gatewaySshExchange(installation, userKey, binding, call, delegate, "127.0.0.1"));
  } finally {
    broken = false;
  }
  assert.equal(delegations, before);
});
test("SSE arrives before the stream ends, and cancellation releases SSH", { timeout: 20000 }, async () => {
  const response = await gatewaySshExchange(
    installation,
    userKey,
    binding,
    { ...call, method: "GET", path: "/api/v1/_stream/session-view", body: "" },
    delegate,
    "127.0.0.1",
  );
  const reader = response.body!.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /cursor-1/);
  await reader.cancel();
});
test("production address policy rejects loopback before authentication", async () => {
  const before = authentications;
  await assert.rejects(gatewayOverSsh(installation, userKey, binding, call, delegate), /target_not_allowed/);
  assert.equal(authentications, before);
});
