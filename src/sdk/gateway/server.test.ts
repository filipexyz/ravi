import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { z } from "zod";

import { Arg, Command, Group, Option, Returns } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { startGateway, type GatewayHandle } from "./server.js";

@Group({ name: "demo", description: "Server demo", scope: "open" })
class ServerDemoCommands {
  @Command({ name: "echo", description: "Echo" })
  @Returns(z.object({ ok: z.literal(true), name: z.string() }))
  echo(@Arg("name") name: string, @Option({ flags: "--shout" }) shout?: boolean) {
    void shout;
    return { ok: true as const, name };
  }
}

const registry = buildRegistry([ServerDemoCommands]);

let handle: GatewayHandle;

beforeAll(() => {
  handle = startGateway({ host: "127.0.0.1", port: 0, registry });
});

afterAll(async () => {
  await handle.stop();
});

describe("gateway server — meta + health", () => {
  it("/health returns 200", async () => {
    const res = await fetch(`${handle.url}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("/api/v1/_meta/version returns gateway+registryHash", async () => {
    const res = await fetch(`${handle.url}/api/v1/_meta/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gateway: string; registryHash: string };
    expect(typeof body.gateway).toBe("string");
    expect(body.registryHash).toBe(handle.registryHash);
  });

  it("/api/v1/_meta/registry mirrors the registry command count", async () => {
    const res = await fetch(`${handle.url}/api/v1/_meta/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commandCount: number; commands: { fullName: string }[] };
    expect(body.commandCount).toBe(registry.commands.length);
    expect(body.commands.find((c) => c.fullName === "demo.echo")).toBeDefined();
  });

  it("/api/v1/_meta/registry rejects POST", async () => {
    const res = await fetch(`${handle.url}/api/v1/_meta/registry`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});

describe("gateway server — dispatch over HTTP", () => {
  it("POST to a real command returns 200 with the handler payload (flat body)", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "luis" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string };
    expect(body).toEqual({ ok: true, name: "luis" });
  });

  it("POST with empty body returns 400 ValidationError with structured issues", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("ValidationError");
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.some((i) => i.path[0] === "name")).toBe(true);
  });

  it("POST with malformed JSON returns 400 BadRequest", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("BadRequest");
  });

  it("POST to a missing command returns 404", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/does_not_exist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NotFound");
  });

  it("GET on a command path returns 405", async () => {
    const res = await fetch(`${handle.url}/api/v1/demo/echo`);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("MethodNotAllowed");
  });

  it("unknown root path returns 404", async () => {
    const res = await fetch(`${handle.url}/no-such-thing`);
    expect(res.status).toBe(404);
  });
});
