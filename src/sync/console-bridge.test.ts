import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { enqueueSyncEvent, getSyncCursor, inspectSyncRecord } from "./db.js";
import { ConsoleSyncBridge } from "./console-bridge.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-sync-bridge-test-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
});

describe("ConsoleSyncBridge", () => {
  it("no-ops without linked credentials", async () => {
    const bridge = new ConsoleSyncBridge({ readCredentials: () => null });
    await expect(bridge.push()).resolves.toMatchObject({ linked: false, status: "unlinked" });
    await expect(bridge.pull()).resolves.toMatchObject({ linked: false, status: "unlinked" });
  });

  it("uploads batches with per-event projectRef and reuses cloud-auth refresh on AUTH_EXPIRED", async () => {
    const event = enqueueSyncEvent({
      domain: "crm",
      eventType: "crm.test",
      entityType: "item",
      entityId: "one",
      idempotencyKey: "one",
      payload: { ok: true },
    });
    const credentials = fakeCredentials("old");
    let writes = 0;
    let calls = 0;
    const client = {
      consoleUrl: credentials.consoleUrl,
      requestJson: async (_method: string, path: string, body: unknown, token?: string) => {
        calls += 1;
        expect(path).toBe("/api/cli/sync/events");
        if (calls === 1) throw new CloudAuthError("AUTH_EXPIRED", "expired", { status: 401 });
        expect(token).toBe("new-access");
        const events = (body as { events: Array<{ eventId: string; projectRef?: string }> }).events;
        expect(events[0]?.eventId).toBe(event!.eventId);
        expect(events[0]?.projectRef).toBe("proj-a");
        return {
          version: 1,
          accepted: 1,
          duplicates: 0,
          events: [{ eventId: events[0]!.eventId, accepted: true, duplicate: false, sequence: "42" }],
        };
      },
      refresh: async () => fakeCredentials("new"),
    };
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      writeCredentials: () => {
        writes += 1;
      },
      deleteCredentials: () => {},
      createClient: () => client as never,
    });

    await expect(bridge.push({ projectRef: "proj-a" })).resolves.toMatchObject({
      linked: true,
      status: "uploaded",
      attempted: 1,
      acked: 1,
    });
    expect(writes).toBe(1);
    expect(inspectSyncRecord(event!.id)?.record.status).toBe("acked");
    expect(getSyncCursor("sync", "last_upload")?.cursorValue).toBe("42");
  });

  it("uses Console events[] duplicate responses as ack and avoids sent-only rows", async () => {
    const event = enqueueSyncEvent({
      domain: "crm",
      eventType: "crm.test",
      entityType: "item",
      entityId: "dup",
      idempotencyKey: "dup",
      payload: { ok: true },
    })!;
    const credentials = fakeCredentials("old");
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      createClient: () =>
        ({
          consoleUrl: credentials.consoleUrl,
          requestJson: async (_method: string, _path: string, body: unknown) => {
            const events = (body as { events: Array<{ eventId: string }> }).events;
            return {
              version: 1,
              accepted: 0,
              duplicates: 1,
              events: [{ eventId: events[0]!.eventId, accepted: false, duplicate: true, sequence: 9 }],
            };
          },
        }) as never,
    });

    await expect(bridge.push()).resolves.toMatchObject({ acked: 1, failed: 0 });
    expect(inspectSyncRecord(event.id)?.record.status).toBe("acked");
  });

  it("does not send runtime_trace rows through generic sync upload", async () => {
    enqueueSyncEvent({
      domain: "runtime_trace",
      eventType: "runtime.trace.export",
      entityType: "session_events",
      entityId: "1-1",
      idempotencyKey: "trace:1",
      payload: { session: {}, turns: [], events: [], toolCalls: [], blobs: [] },
    });
    const credentials = fakeCredentials("old");
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      createClient: () =>
        ({
          consoleUrl: credentials.consoleUrl,
          requestJson: async () => {
            throw new Error("generic sync upload should not be called for runtime_trace");
          },
        }) as never,
    });

    await expect(bridge.push()).resolves.toMatchObject({ linked: true, status: "noop", attempted: 0 });
  });

  it("requires domain for pull before calling Console", async () => {
    const credentials = fakeCredentials("old");
    let calls = 0;
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      createClient: () =>
        ({
          consoleUrl: credentials.consoleUrl,
          requestJson: async () => {
            calls += 1;
            return {};
          },
        }) as never,
    });

    await expect(bridge.pull()).resolves.toMatchObject({ status: "failed", errorCode: "DOMAIN_REQUIRED" });
    expect(calls).toBe(0);
  });

  it("pulls and acks with domain plus organization scope by default", async () => {
    const credentials = fakeCredentials("old");
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      createClient: () =>
        ({
          consoleUrl: credentials.consoleUrl,
          requestJson: async (method: string, path: string, body: unknown) => {
            calls.push({ method, path, body });
            if (method === "GET") {
              expect(path).toBe("/api/cli/sync/events?domain=crm&scope=organization&limit=1");
              return {
                events: [
                  {
                    eventId: "remote_1",
                    sequence: "100",
                    domain: "crm",
                    type: "crm.remote",
                    entityType: "activity",
                    entityId: "act_1",
                    payload: { ok: true },
                  },
                ],
                nextCursor: "100",
              };
            }
            expect(path).toBe("/api/cli/sync/ack");
            expect(body).toMatchObject({ domain: "crm", scope: "organization", cursor: "100" });
            return {};
          },
        }) as never,
    });

    await expect(
      bridge.pull({
        domain: "crm",
        limit: 1,
        handlers: { crm: () => "applied" },
      }),
    ).resolves.toMatchObject({ status: "downloaded", downloaded: 1, applied: 1, cursor: "100" });
    expect(calls.map((call) => call.method)).toEqual(["GET", "POST"]);
  });

  it("marks remote failures locally without throwing", async () => {
    const event = enqueueSyncEvent({
      domain: "crm",
      eventType: "crm.test",
      entityType: "item",
      entityId: "one",
      idempotencyKey: "one",
      payload: { ok: true },
    })!;
    const credentials = fakeCredentials("old");
    const bridge = new ConsoleSyncBridge({
      readCredentials: () => credentials,
      createClient: () =>
        ({
          consoleUrl: credentials.consoleUrl,
          requestJson: async () => {
            throw new CloudAuthError("SERVER_UNAVAILABLE", "down", { status: 503 });
          },
        }) as never,
    });

    await expect(bridge.push()).resolves.toMatchObject({
      linked: true,
      status: "failed",
      failed: 1,
      errorCode: "SERVER_UNAVAILABLE",
    });
    expect(inspectSyncRecord(event.id)?.record.status).toBe("failed");
  });
});

function fakeCredentials(prefix: string): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.test",
    installationId: "install_1",
    accessToken: `${prefix}-access`,
    refreshToken: `${prefix}-refresh`,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scopes: [],
    user: null,
    organization: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
