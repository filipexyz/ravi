import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reportRuntimeIntelligenceAttemptFeedback,
  requestRuntimeIntelligenceGrant,
} from "./intelligence-identity-client.js";

let server: Server | undefined;
let root: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
});

describe("local intelligence identity client", () => {
  test("never treats a same-UID fake identityd socket as authority", async () => {
    const socketPath = await listen((_request, response) => response.end("{}"));
    await expect(requestRuntimeIntelligenceGrant(grantRequest(), { socketPath })).rejects.toThrow(
      /owned by root|root-controlled/,
    );
  });

  test("sends the authoritative runtime/upstream request and validates grant plus forwarder", async () => {
    const received: { path?: string; body?: Record<string, unknown> } = {};
    const socketPath = await listen((request, response) => {
      received.path = request.url;
      readJson(request, (body) => {
        received.body = body;
        response.end(JSON.stringify(validGrantResponse("conn_a", "attempt_a")));
      });
    });

    const result = await requestRuntimeIntelligenceGrant(grantRequest(), {
      socketPath,
      skipSocketSecurityCheck: true,
    });
    expect(result.grant).toMatchObject({ connectionId: "conn_a", attemptId: "attempt_a", runtimeId: "runtime_a" });
    expect(result.forwarder).toEqual({
      scheme: "identityd-signing-forwarder-v1",
      verified: true,
      bindingHandle: "binding_conn_a",
      origin: "http://127.0.0.1:43123",
    });
    expect(received.path).toBe("/v1/intelligence/grant");
    expect(received.body).toMatchObject({
      runtimeId: "runtime_a",
      upstreamProvider: "openai",
      connectionIds: ["conn_a", "conn_b"],
      taskProfile: "workspace",
    });
  });

  test("rejects grants whose runtime or upstream differs from the request", async () => {
    const socketPath = await listen((_request, response) => {
      const payload = validGrantResponse("conn_a", "attempt_a");
      response.end(
        JSON.stringify({
          ...payload,
          grant: { ...payload.grant, runtimeId: "runtime_other", upstreamProvider: "openrouter" },
          authority: { ...payload.authority, runtimeId: "runtime_other" },
        }),
      );
    });
    await expect(
      requestRuntimeIntelligenceGrant(grantRequest(), { socketPath, skipSocketSecurityCheck: true }),
    ).rejects.toThrow("invalid intelligence grant response");
  });

  test("does not expose identityd response bodies on rejection", async () => {
    const socketPath = await listen((_request, response) => {
      response.statusCode = 403;
      response.end("upstream-secret-must-not-leak");
    });
    try {
      await requestRuntimeIntelligenceGrant(grantRequest(), { socketPath, skipSocketSecurityCheck: true });
      throw new Error("expected identityd rejection");
    } catch (error) {
      expect(String(error)).toContain("identityd rejected the request (403)");
      expect(String(error)).not.toContain("upstream-secret");
    }
  });

  test("advances the identityd cursor only after pre-effect credential feedback", async () => {
    let cursor = 0;
    const connections = ["conn_a", "conn_b"];
    const socketPath = await listen((request, response) => {
      if (request.url === "/v1/intelligence/grant") {
        const connection = connections[cursor] ?? "conn_b";
        response.end(JSON.stringify(validGrantResponse(connection, `attempt_${cursor + 1}`)));
        return;
      }
      readJson(request, (body) => {
        if (body.outcome === "credential_failed" && body.effectState === "none") cursor = 1;
        response.end(JSON.stringify({ recorded: true, nextAction: "advance", nextConnectionId: "conn_b" }));
      });
    });

    const first = await requestRuntimeIntelligenceGrant(grantRequest(), {
      socketPath,
      skipSocketSecurityCheck: true,
    });
    const feedback = await reportRuntimeIntelligenceAttemptFeedback(
      {
        attemptId: first.grant.attemptId,
        grantId: first.grant.grantId,
        runtimeId: first.grant.runtimeId,
        connectionId: first.grant.connectionId,
        sessionKey: "agent:main:main",
        outcome: "credential_failed",
        effectState: "none",
        failureKind: "auth_invalid",
      },
      { socketPath, skipSocketSecurityCheck: true },
    );
    const second = await requestRuntimeIntelligenceGrant(grantRequest(), {
      socketPath,
      skipSocketSecurityCheck: true,
    });

    expect(feedback).toEqual({ recorded: true, nextAction: "advance", nextConnectionId: "conn_b" });
    expect(second.grant.connectionId).toBe("conn_b");
  });

  test("reserves and terminalizes a distinct authoritative attempt for every physical-session turn", async () => {
    let grantCount = 0;
    const terminalized: Array<Record<string, unknown>> = [];
    const socketPath = await listen((request, response) => {
      if (request.url === "/v1/intelligence/grant") {
        grantCount += 1;
        response.end(JSON.stringify(validGrantResponse("conn_a", `attempt_turn_${grantCount}`)));
        return;
      }
      readJson(request, (body) => {
        terminalized.push(body);
        response.end(JSON.stringify({ recorded: true, nextAction: "retain" }));
      });
    });

    for (const outcome of ["succeeded", "provider_failed"] as const) {
      const turn = await requestRuntimeIntelligenceGrant(grantRequest(), {
        socketPath,
        skipSocketSecurityCheck: true,
      });
      await reportRuntimeIntelligenceAttemptFeedback(
        {
          attemptId: turn.grant.attemptId,
          grantId: turn.grant.grantId,
          runtimeId: turn.grant.runtimeId,
          connectionId: turn.grant.connectionId,
          sessionKey: "agent:main:main",
          outcome,
          effectState: outcome === "succeeded" ? "output_materialized" : "none",
        },
        { socketPath, skipSocketSecurityCheck: true },
      );
    }

    expect(grantCount).toBe(2);
    expect(terminalized.map((item) => item.outcome)).toEqual(["succeeded", "provider_failed"]);
  });

  test("rejects identityd advancement after a tool, output, or input side effect", async () => {
    const socketPath = await listen((_request, response) => {
      response.end(JSON.stringify({ recorded: true, nextAction: "advance", nextConnectionId: "conn_b" }));
    });
    for (const effectState of ["input_mutated", "tool_started", "output_materialized"] as const) {
      await expect(
        reportRuntimeIntelligenceAttemptFeedback(
          {
            attemptId: "attempt_a",
            grantId: "grant_a",
            runtimeId: "runtime_a",
            connectionId: "conn_a",
            sessionKey: "agent:main:main",
            outcome: "credential_failed",
            effectState,
          },
          { socketPath, skipSocketSecurityCheck: true },
        ),
      ).rejects.toThrow("after a side-effect boundary");
    }
  });
});

function grantRequest() {
  return {
    selection: { profileId: "profile_a", connectionIds: ["conn_a", "conn_b"] },
    runtimeProvider: "codex" as const,
    upstreamProvider: "openai",
    model: "gpt-5.4",
    runtimeId: "runtime_a",
    agentId: "main",
    sessionKey: "agent:main:main",
    taskProfile: "workspace",
  };
}

function validGrantResponse(connectionId: string, attemptId: string) {
  return {
    grant: {
      version: 1,
      grantId: `grant_${connectionId}`,
      attemptId,
      runtimeId: "runtime_a",
      profileId: "profile_a",
      connectionId,
      connectionRevision: "revision_1",
      sessionCompatibilityKey: `compat_${connectionId}_1`,
      runtimeProvider: "codex",
      upstreamProvider: "openai",
      model: "gpt-5.4",
      proxyOrigin: "https://hub.example.com",
      audience: "ravi-hub-intelligence",
      expiresAt: Date.now() + 60_000,
    },
    authority: {
      scheme: "identityd-hub-grant-v1",
      verified: true,
      attemptId,
      runtimeId: "runtime_a",
      profileId: "profile_a",
      connectionId,
    },
    forwarder: {
      scheme: "identityd-signing-forwarder-v1",
      verified: true,
      bindingHandle: `binding_${connectionId}`,
      origin: "http://127.0.0.1:43123",
    },
  };
}

async function listen(handler: RequestListener): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "ravi-identity-client-"));
  const socketPath = join(root, "identityd.sock");
  server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return socketPath;
}

function readJson(request: Parameters<RequestListener>[0], callback: (body: Record<string, unknown>) => void): void {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => callback(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
}
