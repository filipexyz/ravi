import { describe, expect, it } from "bun:test";
import { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { fakeCompactJws } from "../test/app-gateway-tokens.js";
import { fetchRelayTicket, isAcceptedRelayUrl, parseRelayTicket } from "./ticket-client.js";

const TICKET = fakeCompactJws();

function ticketResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ticket: TICKET,
    expiresAt: 1790000900,
    renewAt: 1790000720,
    relayUrl: "wss://ravi.page/_ravi/executor-relay/v1/connect",
    protocol: "ravi.executor-relay.v1",
    issuer: "https://console.ravi.bot",
    installationId: "6f1c2b8e-1d2c-4b5a-9e8f-0a1b2c3d4e5f",
    organizationId: "0e3c1c9a-2f4b-4d6e-8a1b-3c5d7e9f1a2b",
    ...overrides,
  };
}

function credentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.ravi.test",
    installationId: "local-installation",
    accessToken: "old-access",
    refreshToken: "refresh",
    accessTokenExpiresAt: null,
    scopes: ["console.apps.relay"],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

describe("Pages app gateway relay ticket client", () => {
  it("posts an empty body, refreshes once on AUTH_EXPIRED, and keeps the ticket out of errors", async () => {
    const calls: Array<{ url: string; auth: string | null; body: string | null }> = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("authorization"), body: (init?.body as string) ?? null });
      if (url.endsWith("/api/cli/auth/refresh")) {
        return Response.json({ accessToken: "new-access", refreshToken: "refresh-2", scopes: ["console.apps.relay"] });
      }
      if (headers.get("authorization") === "Bearer old-access") {
        return Response.json({ error: { code: "AUTH_EXPIRED", message: "expired" } }, { status: 401 });
      }
      return Response.json(ticketResponse());
    };
    const client = new ConsoleApiClient({ consoleUrl: "https://console.ravi.test", fetch: fetchImpl });
    const written: CloudCredentials[] = [];
    const creds = credentials();
    const ticket = await fetchRelayTicket({
      client,
      credentials: creds,
      store: { write: (value) => written.push(value), delete: () => {} },
    });
    expect(ticket.installationId).toBe("6f1c2b8e-1d2c-4b5a-9e8f-0a1b2c3d4e5f");
    const ticketCalls = calls.filter((call) => call.url.endsWith("/api/cli/apps/relay-ticket"));
    expect(ticketCalls.map((call) => call.auth)).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect(ticketCalls.every((call) => call.body === "{}")).toBe(true);
    expect(written).toHaveLength(1);
    expect(creds.accessToken).toBe("new-access");
  });

  it("refuses malformed responses without echoing the ticket", () => {
    for (const overrides of [
      { ticket: "not-a-jwt" },
      { protocol: "other" },
      { renewAt: 1790000901 },
      { installationId: "local" },
      { relayUrl: "https://ravi.page/connect" },
      { relayUrl: "ws://ravi.page/connect" },
      { relayUrl: "wss://user:pass@ravi.page/connect" },
    ]) {
      let caught: unknown;
      try {
        parseRelayTicket(ticketResponse(overrides), {});
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CloudAuthError);
      expect((caught as CloudAuthError).code).toBe("PAYLOAD_INVALID");
      expect((caught as Error).message).not.toContain(TICKET);
    }
  });

  it("accepts ws only for loopback hosts or the explicit insecure override", () => {
    expect(isAcceptedRelayUrl("wss://ravi.page/_ravi/executor-relay/v1/connect", {})).toBe(true);
    expect(isAcceptedRelayUrl("ws://127.0.0.1:8787/connect", {})).toBe(true);
    expect(isAcceptedRelayUrl("ws://localhost:8787/connect", {})).toBe(true);
    expect(isAcceptedRelayUrl("ws://[::1]:8787/connect", {})).toBe(true);
    expect(isAcceptedRelayUrl("ws://relay.dev.example/connect", {})).toBe(false);
    expect(isAcceptedRelayUrl("ws://relay.dev.example/connect", { RAVI_ALLOW_INSECURE_CONSOLE_URL: "true" })).toBe(
      true,
    );
    expect(isAcceptedRelayUrl("https://ravi.page/connect", {})).toBe(false);
  });
});
