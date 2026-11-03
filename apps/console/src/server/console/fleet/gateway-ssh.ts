import { lookup } from "node:dns/promises";
import { Agent, request as httpRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { Client, type ClientChannel } from "ssh2";
import { importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import {
  CONSOLE_PROTOCOL,
  CONSOLE_PROOF_PATH,
  CONSOLE_SSH_COMMAND,
  CONSOLE_MAX_RESPONSE,
  CONSOLE_MAX_BODY,
} from "@/shared/console-gateway";
import { canonicalBridgeJson } from "@/shared/human-bridge";
import { FleetError, type Installation } from "./contract";
import { matchesHostKey, privateSshAddress, validatePrivateKey } from "./ssh-probe";
import { sshPortPolicy } from "./ssh-policy";
import type { BridgeBinding } from "./bridge-config";

const commandSchema = z
  .object({
    fullName: z.string(),
    path: z.string(),
    scope: z.string(),
    access: z
      .object({
        kind: z.enum(["read", "mutate"]),
        resource: z.string(),
        action: z.string(),
        consoleScope: z.enum(["installation", "project", "session"]),
        resourceId: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const proofSchema = z.object({
  protocol: z.literal(CONSOLE_PROTOCOL),
  runtimeId: z.string().uuid(),
  connectionId: z.string().uuid(),
  proof: z.string(),
  registry: z.object({ commands: z.array(commandSchema).max(2000) }).passthrough(),
  registryDigest: z.string().length(64),
});
export type GatewayProof = z.infer<typeof proofSchema>;
export type GatewayCommand = GatewayProof["registry"]["commands"][number];
export interface GatewayHttpCall {
  method: "POST" | "GET";
  path: string;
  body: string;
  operationId: string;
  createdAt: number;
}
export type DelegateGateway = (proof: GatewayProof, call: GatewayHttpCall) => Promise<string>;

export async function gatewayOverSsh(
  installation: Installation,
  key: string,
  binding: BridgeBinding,
  call: GatewayHttpCall,
  delegate: DelegateGateway,
  signal?: AbortSignal,
) {
  if (!sshPortPolicy().includes(installation.port)) throw new FleetError("target_not_allowed", 403);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(installation.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new FleetError("host_unreachable", 503)), 3000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!addresses.length || addresses.some((a) => !privateSshAddress(a.address)))
    throw new FleetError("target_not_allowed", 403);
  validatePrivateKey(key);
  return gatewaySshExchange(installation, key, binding, call, delegate, addresses[0]!.address, signal);
}

/** Testable SSH byte transport. The public entry above enforces address policy. */
export async function gatewaySshExchange(
  installation: Installation,
  key: string,
  binding: BridgeBinding,
  call: GatewayHttpCall,
  delegate: DelegateGateway,
  address: string,
  signal?: AbortSignal,
): Promise<Response> {
  if (signal?.aborted) throw new FleetError("gateway_cancelled", 499);
  if (
    !/^\/api\/v1\//.test(call.path) ||
    /[\r\n#]/.test(call.path) ||
    Buffer.byteLength(call.body) > CONSOLE_MAX_BODY
  )
    throw new FleetError("invalid_request");
  const client = new Client();
  let agent: Agent | undefined,
    closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    signal?.removeEventListener("abort", close);
    agent?.destroy();
    client.destroy();
  };
  const timeout = setTimeout(close, 35_000);
  signal?.addEventListener("abort", close, { once: true });
  try {
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      client.on("error", () => reject(new FleetError("gateway_unavailable", 503)));
      client.once("close", () => reject(new FleetError("gateway_unavailable", 503)));
      client.once("ready", () =>
        client.exec(CONSOLE_SSH_COMMAND, { pty: false }, (error, stream) => {
          if (error) return reject(new FleetError("gateway_unavailable", 503));
          stream.stderr.on("data", () => {});
          resolve(stream);
        }),
      );
      client.connect({
        host: address,
        port: installation.port,
        username: installation.username,
        privateKey: key,
        readyTimeout: 8000,
        agentForward: false,
        tryKeyboard: false,
        hostVerifier: (raw: Buffer) => matchesHostKey(raw, installation.hostFingerprint),
      });
    });
    agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    agent.createConnection = () => channel as unknown as Socket;
    // SSH channels are Duplex streams, not TCP sockets; the enclosing 35s deadline
    // owns their lifetime. HTTP keepalive reuses exactly this channel.
    agent.keepSocketAlive = () => true;
    agent.reuseSocket = () => {};
    const exchange = (method: string, path: string, body: string, token?: string) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "ravi.internal",
            port: 80,
            path,
            method,
            agent,
            headers: {
              host: "ravi.internal",
              ...(token ? { authorization: `Bearer ${token}` } : {}),
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          resolve,
        );
        req.once("error", () => reject(new FleetError("gateway_unavailable", 503)));
        req.end(body);
      });
    const hello = await exchange("GET", CONSOLE_PROOF_PATH, "");
    if (hello.statusCode !== 200) throw new FleetError("gateway_runtime_untrusted", 403);
    const proof = proofSchema.parse(JSON.parse(await boundedText(hello)));
    const verified = await jwtVerify(proof.proof, await importSPKI(binding.runtimePublicKey, "EdDSA"), {
      algorithms: ["EdDSA"],
      issuer: binding.runtimeId,
      audience: CONSOLE_PROTOCOL,
      maxTokenAge: "30s",
      clockTolerance: 0,
    });
    const digest = createHash("sha256").update(canonicalBridgeJson(proof.registry)).digest("hex");
    if (
      proof.runtimeId !== binding.runtimeId ||
      verified.payload.connectionId !== proof.connectionId ||
      verified.payload.protocol !== CONSOLE_PROTOCOL ||
      verified.payload.registryDigest !== digest ||
      proof.registryDigest !== digest
    )
      throw new FleetError("gateway_runtime_untrusted", 403);
    const delegation = await delegate(proof, call);
    if (closed) throw new FleetError("gateway_cancelled", 499);
    const incoming = await exchange(call.method, call.path, call.body, delegation);
    const contentType = incoming.headers["content-type"] ?? "application/json";
    if (!contentType.startsWith("text/event-stream")) {
      const text = await boundedText(incoming);
      close();
      return new Response(text, {
        status: incoming.statusCode ?? 502,
        headers: { "content-type": contentType, "cache-control": "no-store" },
      });
    }
    const iterator = incoming[Symbol.asyncIterator]();
    let total = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            close();
            return;
          }
          total += next.value.length;
          if (total > CONSOLE_MAX_RESPONSE) throw new Error();
          controller.enqueue(new Uint8Array(next.value));
        } catch {
          controller.error(new FleetError("gateway_unavailable", 503));
          close();
        }
      },
      async cancel() {
        incoming.destroy();
        close();
        await iterator.return?.();
      },
    });
    return new Response(stream, {
      status: incoming.statusCode ?? 502,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    close();
    if (error instanceof FleetError) throw error;
    throw new FleetError("gateway_unavailable", 503);
  }
}
async function boundedText(incoming: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > CONSOLE_MAX_RESPONSE) {
      incoming.destroy();
      throw new FleetError("gateway_response_too_large", 503);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
