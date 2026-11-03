import { describe, expect, test } from "bun:test";

import {
  buildP0SmokeEvents,
  parseRuntimeHostdArgs,
  runP0Smoke,
  type RuntimeFetch,
  type RuntimeHostInventory,
  type RuntimeHostdConfig,
} from "./runtime-hostd";

const inventory: RuntimeHostInventory = {
  architecture: "x86_64",
  capacity: {
    cpuCount: 16,
    totalMemoryMb: 65536,
  },
  health: {
    firecrackerPath: "/usr/local/bin/firecracker",
    kvmAvailable: true,
  },
  hostname: "ravi-runtime-ovh-1",
  placementClasses: ["p0", "outbound-hostd", "process-smoke", "x86_64", "kvm", "firecracker"],
};

const config: RuntimeHostdConfig = {
  consoleUrl: "https://console.test",
  controlToken: "runtime-control-token-with-enough-length",
  environment: "development",
  hostProvider: "ovh",
  imageName: "ravi-runtime-hostd",
  imageVersion: "p0-smoke",
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: null,
  region: "bhs",
  runtimeModel: null,
  runtimeProvider: "codex",
  sandboxDriver: "process",
  sessionKey: "agent:ravi-agents-cloud:p0-smoke",
  vercelBypassSecret: "vercel-bypass-secret",
};

describe("runtime-hostd args", () => {
  test("parses flags without transforming secrets", () => {
    const parsed = parseRuntimeHostdArgs([
      "smoke",
      "--console-url",
      "https://console.test/",
      "--organization-id=00000000-0000-4000-8000-000000000001",
      "--token",
      "secret-token",
    ]);

    expect(parsed.command).toBe("smoke");
    expect(parsed.flags["console-url"]).toBe("https://console.test/");
    expect(parsed.flags["organization-id"]).toBe("00000000-0000-4000-8000-000000000001");
    expect(parsed.flags.token).toBe("secret-token");
  });
});

describe("runtime-hostd smoke events", () => {
  test("uses canonical runtime event types and no lease token payload", () => {
    const events = buildP0SmokeEvents({
      managedRuntimeSessionId: "session-1",
      runtimeProvider: "codex",
      sandboxDriver: "process",
      sandboxId: "sandbox-1",
    });

    expect(events.map((event) => event.eventType)).toEqual([
      "thread.started",
      "turn.started",
      "status",
      "assistant.message",
      "turn.complete",
    ]);
    expect(JSON.stringify(events)).not.toContain("ravi_rlt_");
  });
});

describe("runtime-hostd p0 smoke", () => {
  test("registers host/image, validates lease, emits events, and redacts token from summary", async () => {
    const calls: Array<{ body: unknown; headers: Headers; path: string }> = [];
    const fetchImpl = (async (url, init) => {
      const parsedUrl = new URL(url.toString());
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : null;
      const headers = new Headers(init?.headers);
      calls.push({ body, headers, path: parsedUrl.pathname });

      if (parsedUrl.pathname.endsWith("/hosts/register")) {
        return jsonResponse({ host: { id: "host-1" }, status: "ok", version: 1 });
      }
      if (parsedUrl.pathname.endsWith("/hosts/heartbeat")) {
        return jsonResponse({ status: "ok", version: 1 });
      }
      if (parsedUrl.pathname.endsWith("/images/register")) {
        return jsonResponse({ image: { id: "image-1" }, status: "ok", version: 1 });
      }
      if (parsedUrl.pathname.endsWith("/leases/request")) {
        return jsonResponse({
          lease: { id: "lease-1" },
          leaseToken: "ravi_rlt_secret",
          status: "ok",
          version: 1,
        });
      }
      if (parsedUrl.pathname.endsWith("/leases/claim")) {
        return jsonResponse({ status: "ok", version: 1 });
      }
      if (parsedUrl.pathname.endsWith("/leases/validate")) {
        return jsonResponse({
          managedRuntimeSessionId: "managed-session-1",
          status: "ok",
          version: 1,
        });
      }
      if (parsedUrl.pathname.endsWith("/events")) {
        return jsonResponse({
          accepted: 5,
          managedRuntimeSessionId: "managed-session-1",
          status: "ok",
          version: 1,
        }, 202);
      }

      return jsonResponse({ code: "not_found", status: "error" }, 404);
    }) satisfies RuntimeFetch;

    const summary = await runP0Smoke(config, {
      fetchImpl,
      inventory,
      sandboxId: "p0-smoke-test",
    });

    expect(calls.map((call) => call.path)).toEqual([
      "/api/internal/runtime/hosts/register",
      "/api/internal/runtime/hosts/heartbeat",
      "/api/internal/runtime/images/register",
      "/api/internal/runtime/leases/request",
      "/api/internal/runtime/leases/claim",
      "/api/internal/runtime/leases/validate",
      "/api/internal/runtime/events",
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${config.controlToken}`);
    expect(calls[0]?.headers.get("x-vercel-protection-bypass")).toBe("vercel-bypass-secret");
    expect(summary).toEqual({
      consoleUrl: "https://console.test",
      driver: "process",
      hostId: "host-1",
      imageId: "image-1",
      leaseId: "lease-1",
      managedRuntimeSessionId: "managed-session-1",
      sandboxId: "p0-smoke-test",
      status: "completed",
    });
    expect(JSON.stringify(summary)).not.toContain("ravi_rlt_secret");
    expect(JSON.stringify(summary)).not.toContain("vercel-bypass-secret");
    expect(JSON.stringify(calls.at(-1)?.body)).toContain("turn.complete");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status,
  });
}
