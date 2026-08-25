import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  inspectExecutionPlane,
  isNetworkIsolationError,
  looksLikeRaviSourceTree,
  probeUnixSocket,
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
    expect(
      looksLikeRaviSourceTree("/repo", existsFrom(["/repo/src/permissions/provider-runtime.ts"])),
    ).toBe(true);
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
    expect(isNetworkIsolationError(Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" }))).toBe(
      true,
    );
    expect(isNetworkIsolationError(new Error("unable to connect"))).toBe(true);
    expect(isNetworkIsolationError(new Error("payload was invalid"))).toBe(false);
  });
});

describe("probeUnixSocket", () => {
  it("returns false for a missing socket", async () => {
    expect(await probeUnixSocket("/tmp/ravi-missing-cli-gateway.sock")).toBe(false);
  });
});
