import { describe, expect, it } from "bun:test";

import { ConnectorHttpError } from "./errors";
import {
  finishConnect,
  handleOAuthCallback,
  resolveConnect,
  startConnect,
  type OAuthRuntimeDeps,
} from "./oauth";

// The DB double throws on any query: these paths must answer before touching it.
const untouchableDb = {
  sql: new Proxy(() => {}, {
    apply() {
      throw new Error("db must not be queried");
    },
    get() {
      throw new Error("db must not be queried");
    },
  }),
  close: async () => {},
} as unknown as OAuthRuntimeDeps["db"];

const deps = {
  db: untouchableDb,
  rootWrapKey: {} as CryptoKey,
  dekKeyVersion: 1,
  adapters: new Map(),
  redirectBaseUrl: "https://link.ravi.so",
  consoleBaseUrl: "https://console.ravi.bot",
  pendingGrantTtlSeconds: 600,
} satisfies OAuthRuntimeDeps;

describe("connectors connect flow (no database)", () => {
  it("rejects an unknown provider before any membership, policy or grant query", async () => {
    const error = await startConnect(deps, {
      provider: "nope",
      organizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      origin: "cli",
      cliSessionId: null,
      localInstallationId: null,
      requestId: "req_1",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorHttpError);
    expect((error as ConnectorHttpError).status).toBe(400);
  });

  it("resolves an empty or oversized connect token as invalid", async () => {
    const actor = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      requestId: "req_2",
    };
    expect(await resolveConnect(deps, { ...actor, connectToken: "" })).toEqual({ state: "invalid" });
    expect(await resolveConnect(deps, { ...actor, connectToken: "x".repeat(300) })).toEqual({ state: "invalid" });
  });

  it("answers invalid for a malformed finish without reading the grant", async () => {
    const actor = {
      organizationId: "11111111-1111-4111-8111-111111111111",
      userId: "22222222-2222-4222-8222-222222222222",
      requestId: "req_3",
    };
    expect(await finishConnect(deps, { ...actor, pendingId: "not-a-uuid", resultToken: "r" })).toEqual({
      state: "invalid",
    });
    expect(
      await finishConnect(deps, {
        ...actor,
        pendingId: "33333333-3333-4333-8333-333333333333",
        resultToken: " ",
      }),
    ).toEqual({ state: "invalid" });
  });

  it("keeps the plain provider error when the callback has no state", async () => {
    const error = await handleOAuthCallback(deps, {
      provider: "google",
      code: null,
      state: null,
      error: "access_denied",
      requestId: "req_4",
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectorHttpError);
    expect((error as ConnectorHttpError).status).toBe(400);
    expect((error as ConnectorHttpError).code).toBe("connector_provider_error");
  });
});
