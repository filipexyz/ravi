import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { join } from "node:path";
import {
  inspectExecutionPlane,
  isNetworkIsolationError,
  looksLikeRaviSourceTree,
  probeUnixSocket,
  probeUnixSocketDetailed,
} from "./execution-plane.js";

function existsFrom(paths: string[]): (path: string) => boolean {
  const set = new Set(paths);
  return (path) => set.has(path);
}

describe("inspectExecutionPlane", () => {
  it("treats an ordinary host process as host, even when unused providers exist", () => {
    const stateDir = "/home/user/.ravi";
    const snapshot = inspectExecutionPlane({
      env: {},
      cwd: "/home/user/project",
      stateDir,
      exists: existsFrom([stateDir, join(stateDir, "ravi.db")]),
    });

    expect(snapshot.plane).toBe("host");
    expect(snapshot.runtimeContext).toBe(false);
    expect(snapshot.daemonIsolationLikely).toBe(false);
    expect(snapshot.markers.join(" ")).not.toContain("pi");
  });

  it("does not infer provider pi from isolation markers", () => {
    const stateDir = "/home/user/.ravi";
    const snapshot = inspectExecutionPlane({
      env: {
        RAVI_EXECUTION_PLANE: "provider-sandbox",
        RAVI_CONTEXT_KEY: "rctx_test",
        CODEX_SANDBOX: "danger-full-access",
      },
      cwd: "/workspace/agent",
      stateDir,
      exists: existsFrom([stateDir, join(stateDir, "ravi.db"), "/.dockerenv"]),
    });

    expect(snapshot.plane).toBe("provider-sandbox");
    expect(snapshot.runtimeContext).toBe(true);
    expect(snapshot.daemonIsolationLikely).toBe(true);
    expect(snapshot.markers).toContain("codex-sandbox");
    expect(snapshot.markers.some((marker) => marker.includes("pi"))).toBe(false);
  });

  it("classifies Codex sandbox env as provider-sandbox without a container", () => {
    const snapshot = inspectExecutionPlane({
      env: { CODEX_SANDBOX_NETWORK: "restricted" },
      cwd: "/tmp/agent",
      stateDir: "/tmp/missing",
      exists: () => false,
    });

    expect(snapshot.plane).toBe("provider-sandbox");
    expect(snapshot.markers).toContain("codex-sandbox-network");
  });

  it("requires runtime context plus a container before assuming a sandbox", () => {
    const containerOnly = inspectExecutionPlane({
      env: {},
      cwd: "/repo",
      stateDir: "/repo/.ravi",
      exists: existsFrom(["/.dockerenv", "/repo/.ravi", "/repo/.ravi/ravi.db"]),
    });
    const isolatedContainer = inspectExecutionPlane({
      env: { RAVI_CONTEXT_KEY: "rctx_test" },
      cwd: "/repo",
      stateDir: "/repo/.ravi",
      exists: existsFrom(["/.dockerenv", "/repo/.ravi", "/repo/.ravi/ravi.db"]),
    });

    expect(containerOnly.plane).toBe("host");
    expect(isolatedContainer.plane).toBe("provider-sandbox");
  });

  it("lets an explicit host plane win over Codex markers", () => {
    const snapshot = inspectExecutionPlane({
      env: { RAVI_EXECUTION_PLANE: "host", CODEX_SANDBOX: "1" },
      cwd: "/repo",
      stateDir: "/tmp/missing",
      exists: () => false,
    });

    expect(snapshot.plane).toBe("host");
  });
});

describe("looksLikeRaviSourceTree", () => {
  it("accepts a tree that has provider-runtime source", () => {
    expect(looksLikeRaviSourceTree("/repo", existsFrom(["/repo/src/permissions/provider-runtime.ts"]))).toBe(true);
  });

  it("accepts a tree that has doctor and pages sources", () => {
    expect(
      looksLikeRaviSourceTree(
        "/repo",
        existsFrom(["/repo/src/cli/commands/doctor.ts", "/repo/src/cli/commands/pages.ts"]),
      ),
    ).toBe(true);
  });

  it("rejects an agent workspace cwd", () => {
    expect(looksLikeRaviSourceTree("/agents/main", () => false)).toBe(false);
  });
});

describe("isNetworkIsolationError", () => {
  it("recognizes fetch and socket failures", () => {
    expect(isNetworkIsolationError(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isNetworkIsolationError(new Error("unable to connect"))).toBe(true);
    expect(isNetworkIsolationError(new Error("payload was invalid"))).toBe(false);
  });
});

describe("probeUnixSocket", () => {
  it("returns false for a missing socket without rejecting", async () => {
    await expect(probeUnixSocket("/tmp/ravi-missing-cli-gateway.sock")).resolves.toBe(false);
  });
});

type FakeConnect = "hang" | "connect" | "refuse" | "vanish";

/** A socket whose `connect()` follows a script, one entry per attempt. */
function scriptedSockets(script: FakeConnect[]): { createSocket: () => Socket; count: () => number } {
  let attempts = 0;
  return {
    count: () => attempts,
    createSocket: () => {
      const behaviour = script[Math.min(attempts, script.length - 1)] ?? "hang";
      attempts += 1;
      const fake = new EventEmitter() as EventEmitter & { connect: () => void; destroy: () => void };
      fake.connect = () => {
        if (behaviour === "connect") queueMicrotask(() => fake.emit("connect"));
        if (behaviour === "refuse") {
          queueMicrotask(() => fake.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })));
        }
        if (behaviour === "vanish") {
          queueMicrotask(() => fake.emit("error", Object.assign(new Error("gone"), { code: "ENOENT" })));
        }
        // "hang": never answers; the attempt timeout decides.
      };
      fake.destroy = () => {};
      return fake as unknown as Socket;
    },
  };
}

describe("probeUnixSocket retry", () => {
  // The probe only reaches `connect` when the socket file exists.
  const existing = import.meta.path;

  it("a single short attempt reads a slow connect as unreachable (the old behaviour)", async () => {
    const sockets = scriptedSockets(["hang"]);
    const result = await probeUnixSocketDetailed(existing, { timeoutMs: 20, attempts: 1, ...sockets });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(sockets.count()).toBe(1);
  });

  it("reaches a daemon whose first attempts are slower than the attempt timeout", async () => {
    const sockets = scriptedSockets(["hang", "hang", "connect"]);
    const result = await probeUnixSocketDetailed(existing, { timeoutMs: 20, backoffMs: [5], ...sockets });
    expect(result).toEqual({ ok: true });
    expect(sockets.count()).toBe(3);
  });

  it("uses a retrying default: probeUnixSocket survives one slow attempt", async () => {
    const sockets = scriptedSockets(["hang", "connect"]);
    const result = await probeUnixSocketDetailed(existing, { timeoutMs: 20, backoffMs: [5], ...sockets });
    expect(result.ok).toBe(true);
    // The exported defaults must keep retrying, otherwise the fix is a no-op.
    const defaults = scriptedSockets(["hang", "connect"]);
    expect(await probeUnixSocketDetailed(existing, { timeoutMs: 20, ...defaults })).toEqual({ ok: true });
  });

  it("reports timeout vs refused so callers can tell a busy daemon from a dead one", async () => {
    const hung = await probeUnixSocketDetailed(existing, {
      timeoutMs: 10,
      backoffMs: [1],
      ...scriptedSockets(["hang"]),
    });
    const refused = await probeUnixSocketDetailed(existing, {
      timeoutMs: 10,
      backoffMs: [1],
      ...scriptedSockets(["refuse"]),
    });
    expect(hung).toMatchObject({ ok: false, reason: "timeout" });
    expect(refused).toMatchObject({ ok: false, reason: "refused", code: "ECONNREFUSED" });
  });

  it("does not retry a socket that vanishes between the existence check and connect", async () => {
    const sockets = scriptedSockets(["vanish"]);
    const result = await probeUnixSocketDetailed(existing, { timeoutMs: 10, backoffMs: [1], ...sockets });
    expect(result).toMatchObject({ ok: false, reason: "missing", code: "ENOENT" });
    expect(sockets.count()).toBe(1);
  });

  it("reports a missing socket as definite, without retrying", async () => {
    const sockets = scriptedSockets(["hang"]);
    const started = Date.now();
    const result = await probeUnixSocketDetailed("/tmp/ravi-missing-cli-gateway.sock", { ...sockets });
    expect(result).toEqual({ ok: false, reason: "missing" });
    expect(sockets.count()).toBe(0);
    expect(Date.now() - started).toBeLessThan(100);
  });
});
