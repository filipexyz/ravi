import { describe, expect, it } from "bun:test";
import { RequestIdDedupe } from "./dedupe.js";
import { PING_FRAME, parseInboundFrame, serializeErrorFrame, serializeResultFrame } from "./frames.js";
import { resolveAppGatewayPrincipal } from "./principal.js";

const REQUEST_ID = "0b6c2f0e-6a4f-4f2a-9d55-3c1f6f3f8a11";
const INSTALLATION_ID = "6f1c2b8e-1d2c-4b5a-9e8f-0a1b2c3d4e5f";

function invoke(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "apps.invoke",
    v: 1,
    requestId: REQUEST_ID,
    appId: "slides",
    operation: "slides.list",
    assertion: "a.b.c",
    grant: "d.e.f",
    body: { args: ["--limit", "10"] },
    ...overrides,
  });
}

describe("Pages app gateway frames", () => {
  it("parses relay.ready, pong, and apps.invoke", () => {
    const ready = JSON.stringify({
      type: "relay.ready",
      v: 1,
      installationId: INSTALLATION_ID,
      ticketExpiresAt: 1790000900,
      maxFrameBytes: 1179648,
      invokeTimeoutMs: 30000,
      pingIntervalMs: 25000,
    });
    expect(parseInboundFrame(ready, false)).toMatchObject({
      kind: "ready",
      frame: { installationId: INSTALLATION_ID },
    });
    expect(parseInboundFrame('{"type":"pong"}', false)).toEqual({ kind: "pong" });
    expect(parseInboundFrame(Buffer.from(invoke()), false)).toMatchObject({
      kind: "invoke",
      frame: { requestId: REQUEST_ID, appId: "slides" },
    });
    expect(PING_FRAME).toBe('{"type":"ping"}');
  });

  it("treats binary, unknown types, extra fields, wrong version, and oversize frames as protocol errors", () => {
    const cases: Array<[string | Buffer, boolean]> = [
      [invoke(), true],
      ['{"type":"apps.result","v":1}', false],
      ['{"type":"pong","v":1}', false],
      [invoke({ extra: 1 }), false],
      [invoke({ v: 2 }), false],
      [invoke({ requestId: 42 }), false],
      ["not json", false],
      [
        JSON.stringify({ type: "relay.ready", v: 1, installationId: INSTALLATION_ID, padding: "x".repeat(5000) }),
        false,
      ],
      [invoke({ body: { args: ["x".repeat(1_179_648)] } }), false],
    ];
    for (const [data, isBinary] of cases) {
      expect(parseInboundFrame(data, isBinary).kind).toBe("protocol-error");
    }
  });

  it("answers payload_invalid for a well-formed invoke whose fields fail step 1", () => {
    for (const overrides of [
      { requestId: "not-a-uuid" },
      { appId: "Slides" },
      { operation: "list" },
      { assertion: 1 },
      { grant: null },
      { body: [] },
      { body: undefined },
    ]) {
      const parsed = parseInboundFrame(invoke(overrides), false);
      expect(parsed.kind).toBe("invalid-invoke");
    }
  });

  it("serializes result and error frames with v1 and status 200", () => {
    expect(JSON.parse(serializeResultFrame(REQUEST_ID, undefined))).toEqual({
      type: "apps.result",
      v: 1,
      requestId: REQUEST_ID,
      status: 200,
      body: null,
    });
    expect(JSON.parse(serializeErrorFrame(REQUEST_ID, "app_gateway_rate_limited"))).toEqual({
      type: "apps.error",
      v: 1,
      requestId: REQUEST_ID,
      error: "app_gateway_rate_limited",
    });
  });
});

describe("Pages app gateway request id dedupe", () => {
  it("refuses replays inside 120 s and refuses new ids when full instead of evicting", () => {
    let now = 0;
    const dedupe = new RequestIdDedupe({ maxEntries: 2, now: () => now });
    expect(dedupe.admit("a")).toBe("admitted");
    expect(dedupe.admit("a")).toBe("replayed");
    expect(dedupe.admit("b")).toBe("admitted");
    expect(dedupe.admit("c")).toBe("full");
    now = 119_999;
    expect(dedupe.admit("a")).toBe("replayed");
    now = 120_000;
    expect(dedupe.admit("c")).toBe("admitted");
    expect(dedupe.admit("a")).toBe("admitted");
  });
});

describe("Pages app gateway local principal", () => {
  const binding = {
    contactId: "contact-1",
    actorPrincipal: "contact:contact-1",
    consoleUserId: "user_1",
    orgId: "org_1",
    installationId: INSTALLATION_ID,
  };

  it("maps exactly one matching cached Link to a contact", () => {
    expect(
      resolveAppGatewayPrincipal({
        raviUserId: "user_1",
        raviOrgId: "org_1",
        siteId: "site_1",
        installationId: INSTALLATION_ID,
        bindings: [binding, { ...binding, contactId: "contact-2", orgId: "org_2" }],
      }),
    ).toEqual({ actorPrincipal: "contact:contact-1", surfacePrincipal: "pages_site:site_1", contactId: "contact-1" });
  });

  it("falls back to the Ravi user when no Link, another installation, or several Links match", () => {
    const base = { raviUserId: "user_1", raviOrgId: "org_1", siteId: "site_1", installationId: INSTALLATION_ID };
    for (const bindings of [
      [],
      [{ ...binding, installationId: "00000000-0000-4000-8000-000000000000" }],
      [binding, { ...binding, contactId: "contact-2", installationId: "" }],
    ]) {
      expect(resolveAppGatewayPrincipal({ ...base, bindings })).toEqual({
        actorPrincipal: "ravi_user:user_1",
        surfacePrincipal: "pages_site:site_1",
        contactId: null,
      });
    }
  });
});
