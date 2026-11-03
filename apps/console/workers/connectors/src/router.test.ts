import { describe, expect, test } from "bun:test";

import type { ConnectorsWorkerEnv, HyperdriveBinding } from "./env";
import { signHmacRequest } from "./hmac";
import { createConnectorsWorker } from "./router";

// Requests rejected before any query: the database URL is never dialed.
const env = {
  RAVI_CONSOLE_DB: { connectionString: "postgres://nobody:nothing@127.0.0.1:1/none" } as HyperdriveBinding,
  RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT: "router-test-hmac-key",
  RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID: "k_router",
  RAVI_CONNECTORS_CLI_ACCESS_TOKEN_SECRET: "router-test-cli-secret",
  GOOGLE_OAUTH_CLIENT_ID: "client",
  GOOGLE_OAUTH_CLIENT_SECRET: "secret",
  WORKOS_API_KEY: "workos",
  RAVI_CONSOLE_BASE_URL: "https://console.test",
  RAVI_CONNECTORS_BASE_URL: "https://link.test",
  RAVI_CONNECTORS_KEY_VERSION: "1",
  RAVI_CONNECTORS_PENDING_GRANT_TTL_SECONDS: "600",
  RAVI_CONNECTORS_STEPUP_TTL_SECONDS: "300",
  RAVI_CONNECTORS_REAUTH_AFTER_DAYS: "90",
  RAVI_CONNECTORS_SUSPEND_AFTER_DAYS: "120",
} as unknown as ConnectorsWorkerEnv;

const worker = createConnectorsWorker({ adapters: () => new Map() });

async function call(request: Request): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(request, env, {
    waitUntil: (promise) => pending.push(promise),
    passThroughOnException() {},
  });
  await Promise.all(pending);
  return response;
}

describe("connectors router (no database)", () => {
  test("answers the health probe", async () => {
    const response = await call(new Request("https://link.test/"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "ravi-connectors" });
  });

  test("rejects UI calls with a bad HMAC signature", async () => {
    const bodyText = JSON.stringify({ userId: "u", organizationId: "o" });
    const headers = await signHmacRequest({
      method: "POST",
      path: "/ui/connect/list",
      bodyText,
      key: "wrong-key",
      keyId: "k_router",
    });
    const response = await call(
      new Request("https://link.test/ui/connect/list", { method: "POST", body: bodyText, headers }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("connector_unauthorized");
  });

  test("rejects UI calls without a valid actor before any query", async () => {
    const bodyText = JSON.stringify({ userId: "not-a-uuid", organizationId: "o" });
    const headers = await signHmacRequest({
      method: "POST",
      path: "/ui/connect/resolve",
      bodyText,
      key: "router-test-hmac-key",
      keyId: "k_router",
    });
    const response = await call(
      new Request("https://link.test/ui/connect/resolve", { method: "POST", body: bodyText, headers }),
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("payload_invalid");
  });

  test("rejects CLI calls without a bearer", async () => {
    const response = await call(new Request("https://link.test/cli/connect/list"));
    expect(response.status).toBe(401);
  });

  test("keeps the plain provider error on a callback without state", async () => {
    const response = await call(new Request("https://link.test/oauth/google/callback?error=access_denied"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("connector_provider_error");
  });
});
