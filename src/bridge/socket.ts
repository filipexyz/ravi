import { serveConsoleSocket } from "../sdk/gateway/console-socket.js";
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { runtimeIdentity } from "./auth.js";
import { bridgeStateDir, getBridgeStore } from "./store.js";
import { BridgeService, type BridgeRuntime } from "./service.js";

export function bridgeSocketPath() {
  return process.env.RAVI_BRIDGE_SOCKET || join(bridgeStateDir(), "bridge.sock");
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
  const socket = await serveConsoleSocket(service, identity, path);
  service.start();
  return {
    async stop() {
      service.stop();
      await socket.stop();
    },
  };
}
