/**
 * End-to-end integration test for the SDK gateway piloto: `artifacts.show`.
 *
 * Spins up the real gateway against an isolated Ravi state, creates an artifact
 * via the live store, and exercises the HTTP surface with `fetch`. Validates
 * the full pipeline that the CLI takes (registry → dispatch → handler →
 * response) without going through Commander.
 */

import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ArtifactsCommands } from "../../cli/commands/artifacts.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { createArtifact } from "../../artifacts/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { startGateway, type GatewayHandle } from "./server.js";

const registry = buildRegistry([ArtifactsCommands]);

let stateDir: string | null = null;
let handle: GatewayHandle | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sdk-gateway-artifacts-show-");
  handle = startGateway({ host: "127.0.0.1", port: 0, registry });
});

afterEach(async () => {
  if (handle) {
    await handle.stop();
    handle = null;
  }
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("gateway piloto — artifacts.show", () => {
  it("returns 200 with artifact details for a valid id (flat body)", async () => {
    const artifact = createArtifact({
      kind: "report",
      title: "Gateway smoke",
      summary: "Created by the artifacts.show piloto integration test.",
      tags: ["gateway", "piloto"],
    });

    const res = await fetch(`${handle!.url}/api/v1/artifacts/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: artifact.id }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { id: string; kind: string; title?: string };
      links: unknown[];
      events: unknown[];
    };
    expect(body.artifact.id).toBe(artifact.id);
    expect(body.artifact.kind).toBe("report");
    expect(Array.isArray(body.links)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
  });

  it("rejects the wrapped {args} form as unknown keys", async () => {
    const artifact = createArtifact({ kind: "report", title: "Gateway wrapped-rejection smoke" });

    const res = await fetch(`${handle!.url}/api/v1/artifacts/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: [artifact.id] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string[]; code: string }[] };
    expect(body.error).toBe("ValidationError");
    expect(body.issues.some((i) => i.path[0] === "args" && i.code === "unrecognized_keys")).toBe(true);
  });

  it("strips rendering flags (asJson) from the contract", async () => {
    const artifact = createArtifact({ kind: "report", title: "strip-rendering-flags smoke" });
    const res = await fetch(`${handle!.url}/api/v1/artifacts/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: artifact.id, asJson: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string[]; code: string }[] };
    expect(body.error).toBe("ValidationError");
    expect(body.issues.some((i) => i.path[0] === "asJson" && i.code === "unrecognized_keys")).toBe(true);
  });

  it("returns 400 ValidationError when the body is empty", async () => {
    const res = await fetch(`${handle!.url}/api/v1/artifacts/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: { path: string[] }[] };
    expect(body.error).toBe("ValidationError");
    expect(body.issues.some((i) => i.path[0] === "id")).toBe(true);
  });

  it("returns 404 for an unknown command path", async () => {
    const res = await fetch(`${handle!.url}/api/v1/artifacts/does_not_exist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NotFound");
  });

  it("/api/v1/_meta/registry surfaces the artifacts.show command path", async () => {
    const res = await fetch(`${handle!.url}/api/v1/_meta/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      commands: { fullName: string; path: string }[];
    };
    const showCmd = body.commands.find((c) => c.fullName === "artifacts.show");
    expect(showCmd).toBeDefined();
    expect(showCmd?.path).toBe("/api/v1/artifacts/show");
  });
});
