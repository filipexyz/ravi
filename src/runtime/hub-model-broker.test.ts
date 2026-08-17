import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHubModelBroker, resetHubModelBrokerCapabilityForTests } from "./hub-model-broker.js";

let server: Server | undefined;
let root: string | undefined;
const PROFILE_ID = "550e8400-e29b-41d4-a716-446655440000";
const RUNTIME_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTION_ID = "44444444-4444-4444-8444-444444444444";
const CAPABILITY = "A".repeat(43);

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
  server = undefined;
  root = undefined;
  resetHubModelBrokerCapabilityForTests();
});

describe("HubModelBroker adapter", () => {
  test("maps strict identityd wire to a generic lease without leaking connection authority", async () => {
    const received: { path?: string; authorization?: string; body?: Record<string, unknown> } = {};
    const socketPath = await listen((request, response) => {
      received.path = request.url;
      received.authorization = request.headers.authorization;
      readJson(request, (body) => {
        received.body = body;
        response.statusCode = 201;
        response.end(JSON.stringify(validLeaseResponse()));
      });
    });
    const broker = createHubModelBroker({ socketPath, capabilityToken: CAPABILITY, skipSocketSecurityCheck: true });
    const route = await broker.resolveRoute(resolveInput());
    expect(received.path).toBe("/v1/model-broker/leases");
    expect(received.authorization).toBe(`Bearer ${CAPABILITY}`);
    expect(received.body).toEqual({
      version: 1,
      purpose: "model_broker_route_lease",
      profileRef: PROFILE_ID,
      runtimeId: RUNTIME_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      turnId: "turn_a",
    });
    expect(route).toMatchObject({
      brokerId: "hub",
      leaseId: GRANT_ID,
      routeRevision: "route_a",
      compatibilityRevision: "compat_a",
      runtimeProvider: "pi",
      transport: {
        origin: "http://127.0.0.1:43123",
        publicHeaders: { "x-ravi-binding": "binding_a" },
      },
    });
    expect(JSON.stringify(route)).not.toContain(CONNECTION_ID);
    expect(JSON.stringify(route)).not.toContain("model-gateway.internal.ravi");
  });

  test("lets identityd resolve the canonical profile without caller-selected authority", async () => {
    let body: Record<string, unknown> | undefined;
    const socketPath = await listen((request, response) => {
      readJson(request, (value) => {
        body = value;
        response.statusCode = 201;
        response.end(JSON.stringify(validLeaseResponse()));
      });
    });
    const broker = createHubModelBroker({ socketPath, capabilityToken: CAPABILITY, skipSocketSecurityCheck: true });
    await broker.resolveRoute(resolveInput("canonical"));

    expect(body).toEqual({
      version: 1,
      purpose: "model_broker_route_lease",
      runtimeId: RUNTIME_ID,
      agentId: "main",
      sessionKey: "agent:main:main",
      turnId: "turn_a",
    });
  });

  test("maps only retry_ready to advance and rejects post-effect advancement", async () => {
    const received: Array<{ path?: string; body?: Record<string, unknown> }> = [];
    const socketPath = await listen((request, response) => {
      const entry: { path?: string; body?: Record<string, unknown> } = { path: request.url };
      received.push(entry);
      readJson(request, (body) => {
        entry.body = body;
        response.end(
          JSON.stringify({
            version: 1,
            attemptId: ATTEMPT_ID,
            turnId: "turn_a",
            status: "retry_ready",
            retryable: true,
            replayed: false,
          }),
        );
      });
    });
    const broker = createHubModelBroker({ socketPath, skipSocketSecurityCheck: true });
    const feedback = feedbackInput("none");
    await expect(broker.reportAttempt(feedback)).resolves.toEqual({ recorded: true, nextAction: "advance" });
    expect(received[0]).toEqual({
      path: `/v1/model-broker/attempts/${ATTEMPT_ID}/feedback`,
      body: {
        version: 1,
        purpose: "model_broker_attempt_feedback",
        leaseId: GRANT_ID,
        runtimeId: RUNTIME_ID,
        sessionKey: "agent:main:main",
        outcome: "credential_failed",
        effectState: "none",
      },
    });
    await expect(broker.reportAttempt(feedbackInput("tool_started"))).rejects.toThrow("side-effect boundary");
  });

  test("requires 201 for lease creation and redacts rejected response bodies", async () => {
    const socketPath = await listen((_request, response) => {
      response.statusCode = 403;
      response.end("upstream-secret-must-not-leak");
    });
    const broker = createHubModelBroker({ socketPath, skipSocketSecurityCheck: true });
    try {
      await broker.resolveRoute(resolveInput());
      throw new Error("expected rejection");
    } catch (error) {
      expect(String(error)).toContain("identityd rejected the request (403)");
      expect(String(error)).not.toContain("upstream-secret");
    }
  });

  test("fails closed when supervision requires an inherited capability", async () => {
    const previousRequired = process.env.RAVI_INTELLIGENCE_REQUIRE_CAPABILITY_FD;
    const previousFd = process.env.RAVI_IDENTITYD_CAPABILITY_FD;
    process.env.RAVI_INTELLIGENCE_REQUIRE_CAPABILITY_FD = "true";
    delete process.env.RAVI_IDENTITYD_CAPABILITY_FD;
    try {
      await expect(
        createHubModelBroker({ socketPath: "/tmp/must-not-be-used.sock", skipSocketSecurityCheck: true }).resolveRoute(
          resolveInput(),
        ),
      ).rejects.toThrow("capability is required");
    } finally {
      if (previousRequired === undefined) delete process.env.RAVI_INTELLIGENCE_REQUIRE_CAPABILITY_FD;
      else process.env.RAVI_INTELLIGENCE_REQUIRE_CAPABILITY_FD = previousRequired;
      if (previousFd === undefined) delete process.env.RAVI_IDENTITYD_CAPABILITY_FD;
      else process.env.RAVI_IDENTITYD_CAPABILITY_FD = previousFd;
    }
  });

  test("reads the capability once from an inherited descriptor and reuses it for feedback", async () => {
    const authorizations: string[] = [];
    const socketPath = await listen((request, response) => {
      authorizations.push(request.headers.authorization ?? "");
      if (request.url === "/v1/model-broker/leases") {
        readJson(request, () => {
          response.statusCode = 201;
          response.end(JSON.stringify(validLeaseResponse()));
        });
        return;
      }
      readJson(request, () => {
        response.end(
          JSON.stringify({
            version: 1,
            attemptId: ATTEMPT_ID,
            turnId: "turn_a",
            status: "blocked",
            retryable: false,
            replayed: false,
          }),
        );
      });
    });
    const capabilityPath = join(root!, "capability");
    writeFileSync(capabilityPath, `${CAPABILITY}\n`, { mode: 0o600 });
    const capabilityFd = openSync(capabilityPath, "r");
    const broker = createHubModelBroker({ capabilityFd, socketPath, skipSocketSecurityCheck: true });

    await broker.resolveRoute(resolveInput());
    await broker.reportAttempt({ ...feedbackInput("none"), outcome: "abandoned" });

    expect(authorizations).toEqual([`Bearer ${CAPABILITY}`, `Bearer ${CAPABILITY}`]);
  });
});

function resolveInput(profileRef = PROFILE_ID) {
  return {
    profileRef,
    runtimeId: RUNTIME_ID,
    agentId: "main",
    sessionKey: "agent:main:main",
    turnId: "turn_a",
  };
}

function feedbackInput(effectState: "none" | "tool_started") {
  return {
    leaseId: GRANT_ID,
    attemptId: ATTEMPT_ID,
    turnId: "turn_a",
    runtimeId: RUNTIME_ID,
    sessionKey: "agent:main:main",
    outcome: "credential_failed" as const,
    effectState,
  };
}

function validLeaseResponse() {
  return {
    grant: {
      version: 1,
      grantId: GRANT_ID,
      attemptId: ATTEMPT_ID,
      turnId: "turn_a",
      runtimeId: RUNTIME_ID,
      profileRef: PROFILE_ID,
      connectionId: CONNECTION_ID,
      routeRevision: "route_a",
      compatibilityRevision: "compat_a",
      runtimeProvider: "pi",
      upstreamProvider: "kimi",
      model: "kimi-k2.5",
      proxyOrigin: "https://model-gateway.internal.ravi",
      audience: "ravi-hub-model-broker",
      expiresAt: Date.now() + 60_000,
    },
    authority: {
      scheme: "identityd-hub-model-broker-v1",
      verified: true,
      attemptId: ATTEMPT_ID,
      turnId: "turn_a",
      runtimeId: RUNTIME_ID,
      profileRef: PROFILE_ID,
    },
    forwarder: {
      scheme: "identityd-signing-forwarder-v1",
      verified: true,
      bindingHandle: "binding_a",
      origin: "http://127.0.0.1:43123",
      protocol: "openai-completions",
      requestPath: "/v1/chat/completions",
    },
  };
}

async function listen(handler: RequestListener): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "ravi-hub-model-broker-"));
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
