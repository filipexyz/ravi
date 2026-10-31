import { createServer, type Socket } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { z } from "zod";
import { MAX_FRAME_BYTES, MAX_RESPONSE_BYTES, type BridgeResult } from "./protocol.js";
import { runtimeIdentity, signedHello } from "./auth.js";
import { bridgeStateDir, getBridgeStore } from "./store.js";
import { BridgeService, type BridgeRuntime } from "./service.js";

export function bridgeSocketPath() {
  return process.env.RAVI_BRIDGE_SOCKET || join(bridgeStateDir(), "bridge.sock");
}
const envelope = z.object({ request: z.unknown(), delegation: z.string().min(1).max(24_000) }).strict();

async function writeFrame(socket: Socket, value: unknown) {
  const frame = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(frame) > MAX_RESPONSE_BYTES) throw new Error("Response limit");
  if (!socket.write(frame)) await once(socket, "drain");
}

/** No caller context key is accepted here. Every operation has a fresh signed delegation. */
export async function serveBridgeSocket(
  service: BridgeService,
  identity: ReturnType<typeof runtimeIdentity>,
  path: string,
) {
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    if (connections.size >= 32) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(45_000, () => socket.destroy());
    void (async () => {
      const connectionId = randomUUID();
      await writeFrame(socket, await signedHello(identity, connectionId));
      let buffer = Buffer.alloc(0);
      for await (const chunk of socket) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        // Stop before parsing any oversized/unbounded frame. Requests are serialized.
        if (buffer.length > MAX_FRAME_BYTES) throw new Error("Frame limit");
        let newline: number;
        while ((newline = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          let result: BridgeResult;
          try {
            const input = envelope.parse(JSON.parse(line.toString("utf8")));
            result = await service.handle(input.request, input.delegation, connectionId);
          } catch {
            result = { ok: false, requestId: "", error: "INVALID_REQUEST", effectState: "none" };
          }
          await writeFrame(socket, result);
        }
      }
    })().catch(() => socket.destroy());
  });
  server.listen(path);
  await once(server, "listening");
  chmodSync(path, 0o660);
  return {
    async stop() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function startHumanBridge(runtime: BridgeRuntime) {
  const store = getBridgeStore(),
    identity = runtimeIdentity(bridgeStateDir());
  const path = bridgeSocketPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o750 });
  // A stale socket is safe to reclaim only on the exclusively owned daemon path.
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error("Bridge path is not a socket");
    // Refuse an active listener; only ECONNREFUSED is stale.
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(path);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error("Bridge already running"));
      });
      probe.once("error", (error: NodeJS.ErrnoException) =>
        error.code === "ECONNREFUSED" ? resolve() : reject(error),
      );
    });
    unlinkSync(path);
  }
  const cursorKey = createHash("sha256").update("bridge-cursor-v1\0").update(identity.privateKey).digest("hex");
  const service = new BridgeService(store, identity.runtimeId, cursorKey, runtime);
  const socket = await serveBridgeSocket(service, identity, path);
  service.start();
  return {
    async stop() {
      service.stop();
      await socket.stop();
    },
  };
}
