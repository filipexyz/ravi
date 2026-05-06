/**
 * End-to-end round-trip test for `@ravi-os/sdk`.
 *
 * Uses the live gateway + the typed `RaviClient` driven by `createHttpTransport`
 * to verify the full pipeline matches the contract the codegen emitted:
 *   - URL routing (groupSegments + command → /api/v1/...)
 *   - Flat JSON body (id passed positionally → `{ id }` on the wire)
 *   - 2xx JSON response surfaced unchanged to the caller
 *   - 4xx ValidationError mapped through `errors.ts`
 *
 * `artifacts.show` is the open-route piloto and matches the existing gateway
 * smoke test, so any drift here also bubbles in the gateway test.
 */

import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ArtifactsCommands } from "../../src/cli/commands/artifacts.js";
import { buildRegistry } from "../../src/cli/registry-snapshot.js";
import { createArtifact } from "../../src/artifacts/store.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../src/test/ravi-state.js";
import { startGateway, type GatewayHandle } from "../../src/sdk/gateway/server.js";

import { RaviClient } from "../../packages/ravi-os-sdk/src/index.js";
import { createHttpTransport } from "../../packages/ravi-os-sdk/src/transport/http.js";
import { RaviValidationError } from "../../packages/ravi-os-sdk/src/errors.js";

const registry = buildRegistry([ArtifactsCommands]);

let stateDir: string | null = null;
let handle: GatewayHandle | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sdk-roundtrip-");
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

function buildClient(): RaviClient {
  const transport = createHttpTransport({
    baseUrl: handle!.url,
    contextKey: "rctx_test_open_route",
  });
  return new RaviClient(transport);
}

describe("SDK round-trip — RaviClient over http transport", () => {
  it("artifacts.show returns the artifact payload (open route, no auth required)", async () => {
    const artifact = createArtifact({
      kind: "report",
      title: "SDK round-trip smoke",
      summary: "Created by the @ravi-os/sdk round-trip integration test.",
      tags: ["sdk", "roundtrip"],
    });

    const client = buildClient();
    const result = (await client.artifacts.show(artifact.id)) as {
      artifact: { id: string; kind: string };
      links: unknown[];
      events: unknown[];
    };

    expect(result.artifact.id).toBe(artifact.id);
    expect(result.artifact.kind).toBe("report");
    expect(Array.isArray(result.links)).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("maps 4xx validation errors to RaviValidationError", async () => {
    // Hit the transport directly with a body that violates the input schema
    // (missing required `id`). The typed RaviClient method would never let us
    // express this — that's the point: the transport is the seam where the
    // error mapping lives, and that's what we're verifying.
    const transport = createHttpTransport({
      baseUrl: handle!.url,
      contextKey: "rctx_test_open_route",
    });
    let caught: unknown;
    try {
      await transport.call({
        groupSegments: ["artifacts"],
        command: "show",
        body: {},
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RaviValidationError);
    const validation = caught as RaviValidationError;
    expect(validation.command).toBe("artifacts.show");
    expect(Array.isArray(validation.issues)).toBe(true);
    expect(validation.issues.some((i) => i.path?.[0] === "id")).toBe(true);
  });
});
