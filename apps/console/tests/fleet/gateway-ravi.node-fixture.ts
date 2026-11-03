import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Server, utils } from "ssh2";
import { importPKCS8, SignJWT } from "jose";
import { gatewaySshExchange, type GatewayHttpCall } from "../../src/server/console/fleet/gateway-ssh";
import {
  CONSOLE_PROTOCOL,
  CONSOLE_SSH_COMMAND,
  CONSOLE_STREAM_PATH,
  consoleRequestMaterial,
} from "../../src/shared/console-gateway";
import type { Installation } from "../../src/server/console/fleet/contract";
import type { BridgeBinding } from "../../src/server/console/fleet/bridge-config";

async function main() {
  const fixture = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
  const { socketPath, enrollment, identity, signer, project, subject } = fixture;
  const hostKey = utils.generateKeyPairSync("ed25519").private,
    userKey = utils.generateKeyPairSync("ed25519").private;
  const host = utils.parseKey(hostKey);
  if (host instanceof Error || Array.isArray(host)) throw new Error();
  const clients = new Set<import("ssh2").Connection>();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (ctx) => (ctx.method === "publickey" ? ctx.accept() : ctx.reject()));
    client.on("ready", () =>
      client.on("session", (accept) =>
        accept().on("exec", (exec, reject, info) => {
          if (info.command !== CONSOLE_SSH_COMMAND) return reject();
          const stream = exec(),
            socket = createConnection(socketPath);
          stream.pipe(socket).pipe(stream);
          stream.on("close", () => socket.destroy());
          socket.on("error", () => stream.destroy());
        }),
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const installation = {
    hostname: "127.0.0.1",
    port: (server.address() as { port: number }).port,
    username: "fixture",
    hostFingerprint: `SHA256:${createHash("sha256").update(host.getPublicSSH()).digest("base64").replace(/=+$/, "")}`,
  } as Installation;
  const binding = { runtimeId: identity.runtimeId, runtimePublicKey: identity.publicKey } as BridgeBinding;
  async function invoke(
    command: string,
    fields: Record<string, unknown> = {},
    operationId = randomUUID(),
    createdAt = Date.now(),
    who = subject,
    stream = false,
  ) {
    const raw = stream
      ? ""
      : JSON.stringify({ projectId: project, requestId: operationId, createdAt, ...fields });
    const path = stream
      ? `${CONSOLE_STREAM_PATH}?${new URLSearchParams({ projectId: project, conversationId: String(fields.conversationId), cursor: String(fields.cursor) })}`
      : `/api/v1/sessions/conversations/${command}`;
    const call: GatewayHttpCall = {
      method: stream ? "GET" : "POST",
      path,
      body: raw,
      operationId,
      createdAt,
    };
    return gatewaySshExchange(
      installation,
      userKey,
      binding,
      call,
      async (proof) => {
        const cmd = proof.registry.commands.find((c) => c.fullName === `sessions.conversations.${command}`)!;
        assert.ok(cmd);
        return new SignJWT({
          protocol: CONSOLE_PROTOCOL,
          orgId: enrollment.orgId,
          installationId: enrollment.installationId,
          enrollmentId: enrollment.id,
          epoch: enrollment.epoch,
          projectId: project,
          connectionId: proof.connectionId,
          policyRevision: 1,
          policyDigest: "a".repeat(64),
          origin: { kind: "automation", automationId: "fixture", deliveryId: operationId },
          operationId,
          createdAt,
          requestDigest: createHash("sha256")
            .update(consoleRequestMaterial(call.method, path, raw, operationId, createdAt))
            .digest("hex"),
          command: cmd.fullName,
          access: { kind: cmd.access.kind, resource: cmd.access.resource, action: cmd.access.action },
          scope: fields.conversationId
            ? { kind: "session", conversationId: fields.conversationId }
            : { kind: "project" },
          agents: [{ id: "main", capabilities: [], approvalCapabilities: [] }],
          canSend: true,
          canApprove: false,
        })
          .setProtectedHeader({ alg: "EdDSA", kid: enrollment.issuerKeyId })
          .setIssuer(enrollment.issuer)
          .setSubject(who)
          .setAudience(`ravi:${identity.runtimeId}:gateway:v1`)
          .setIssuedAt()
          .setExpirationTime("30s")
          .setJti(randomUUID())
          .sign(await importPKCS8(signer.privateKey, "EdDSA"));
      },
      "127.0.0.1",
    );
  }
  try {
    const created = await invoke("create", { agentId: "main" });
    assert.equal(created.status, 200);
    const { conversationId } = (await created.json()) as { conversationId: string };
    const snapshot = (await (await invoke("open", { conversationId })).json()) as { cursor: string };
    const operationId = randomUUID(),
      createdAt = Date.now(),
      fields = { conversationId, text: "fixture execution", expectedVersion: 0 };
    const first = await invoke("send", fields, operationId, createdAt);
    assert.equal(first.status, 200);
    const receipt = (await first.json()) as { turnId: string };
    const duplicate = await invoke("send", fields, operationId, createdAt);
    assert.deepEqual(await duplicate.json(), receipt);
    assert.notEqual(
      (await invoke("send", { ...fields, text: "different" }, operationId, createdAt)).status,
      200,
    );
    assert.notEqual(
      (await invoke("open", { conversationId }, randomUUID(), Date.now(), randomUUID())).status,
      200,
    );
    const eventResponse = await invoke(
      "events",
      { conversationId, cursor: snapshot.cursor },
      randomUUID(),
      Date.now(),
      subject,
      true,
    );
    assert.equal(eventResponse.status, 200);
    const reader = eventResponse.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /message.accepted/);
    await reader.cancel();
    const cancel = await invoke("cancel", { conversationId, turnId: receipt.turnId });
    assert.equal(cancel.status, 200);
    const confirmed = await (await invoke("receipt", { targetRequestId: operationId })).json();
    assert.deepEqual(confirmed, receipt);
    process.stdout.write(
      JSON.stringify({ result: "PASS", kind: "real-ravi-gateway-fleet-ssh", model: "fixture", checks: 8 }) +
        "\n",
    );
  } finally {
    for (const client of clients) client.end();
    await new Promise<void>((r) => server.close(() => r()));
  }
}
main().catch(() => {
  process.stderr.write("Gateway integration failed\n");
  process.exitCode = 1;
});
