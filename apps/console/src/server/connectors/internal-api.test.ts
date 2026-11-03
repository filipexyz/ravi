import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import type { ConsoleAuthState } from "@/lib/auth/session";

import { ConsoleConnectorClientError } from "./console-client";
import {
  connectorErrorResponse,
  isConnectorAdminRole,
  isImpersonatedSession,
  openConnectorRequest,
  readConnectorBody,
  replaceConnectorGateDepsForTests,
} from "./internal-api";

const auth = { mode: "workos", viewer: { email: "me@example.test", mark: "M", name: "Me" } } as ConsoleAuthState;
const impersonated = {
  ...auth,
  initialAuth: { impersonator: { email: "support@example.test", reason: null } },
} as unknown as ConsoleAuthState;

function post(body: string, headers: Record<string, string> = {}) {
  return new NextRequest("https://console.example.test/api/internal/connectors/x", {
    body,
    headers: { "sec-fetch-site": "same-origin", "x-request-id": "req-unit", ...headers },
    method: "POST",
  });
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("connectorErrorResponse", () => {
  test("keeps a Worker 4xx code and turns a Worker 5xx into a bad gateway", async () => {
    const notFound = connectorErrorResponse(new ConsoleConnectorClientError(404, "not_found", "x"), "r");
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ code: "not_found", status: "error" });
    expect(notFound.headers.get("cache-control")).toBe("no-store");

    const ceiling = connectorErrorResponse(new ConsoleConnectorClientError(409, "connector_policy_above_ceiling", "x"), "r");
    expect(ceiling.status).toBe(409);

    const down = connectorErrorResponse(new ConsoleConnectorClientError(503, "internal_error", "x"), "r");
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ code: "internal_error", status: "error" });
  });

  test("a refusal keeps a reason the screens tell apart, and only that", async () => {
    const shared = connectorErrorResponse(
      new ConsoleConnectorClientError(403, "connector_disabled_by_org", "x", "shared_not_allowed"),
      "r",
    );
    expect(await shared.json()).toEqual({ code: "connector_disabled_by_org", reason: "shared_not_allowed", status: "error" });
    const other = connectorErrorResponse(new ConsoleConnectorClientError(403, "connector_disabled_by_org", "x", "agent_required"), "r");
    expect(await other.json()).toEqual({ code: "connector_disabled_by_org", status: "error" });
  });

  test("a Worker 401 refused the Console's signature: a bad gateway, never 'your session ended'", async () => {
    const response = connectorErrorResponse(new ConsoleConnectorClientError(401, "connector_unauthorized", "x"), "r");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "connector_service_unavailable", status: "error" });
  });

  test("anything else is an internal error", async () => {
    const response = connectorErrorResponse(new Error("boom"), "r");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "internal_error", status: "error" });
  });
});

describe("readConnectorBody", () => {
  const schema = z.object({ displayName: z.string().optional() });

  test("an empty body counts as {}", async () => {
    expect(await readConnectorBody(post(""), schema)).toEqual({});
    expect(await readConnectorBody(post("  \n"), schema)).toEqual({});
  });

  test("invalid JSON, a body over 16 KB and a schema mismatch are refused", async () => {
    expect(await readConnectorBody(post("{nope"), schema)).toBeNull();
    expect(await readConnectorBody(post(JSON.stringify({ displayName: "x".repeat(16 * 1024) })), schema)).toBeNull();
    expect(await readConnectorBody(post(JSON.stringify({ displayName: 5 })), schema)).toBeNull();
  });

  test("unknown fields are dropped", async () => {
    expect(await readConnectorBody(post(JSON.stringify({ displayName: "Work", projectRef: "p" })), schema)).toEqual({
      displayName: "Work",
    });
  });
});

describe("openConnectorRequest", () => {
  test("refuses writes from an impersonation session, lets it read", async () => {
    restore = replaceConnectorGateDepsForTests({ authState: async () => impersonated });
    const write = await openConnectorRequest(post("{}"));
    expect(write).toBeInstanceOf(NextResponse);
    expect((write as NextResponse).status).toBe(403);
    expect(await (write as NextResponse).json()).toEqual({ code: "impersonation", status: "error" });

    const read = await openConnectorRequest(post("{}"), "read");
    expect(read).not.toBeInstanceOf(NextResponse);
    expect(read).toMatchObject({ auth: impersonated, requestId: "req-unit" });
  });

  test("the person's own session passes", async () => {
    restore = replaceConnectorGateDepsForTests({ authState: async () => auth });
    expect(await openConnectorRequest(post("{}"))).toMatchObject({ auth, requestId: "req-unit" });
    expect(isImpersonatedSession(auth)).toBe(false);
    expect(isImpersonatedSession(impersonated)).toBe(true);
  });
});

describe("isConnectorAdminRole", () => {
  test("only owners and admins manage the organization's connectors", () => {
    expect(isConnectorAdminRole("owner")).toBe(true);
    expect(isConnectorAdminRole("admin")).toBe(true);
    for (const role of ["developer", "viewer", "billing", "", null, undefined, "Owner"]) {
      expect(isConnectorAdminRole(role)).toBe(false);
    }
  });
});
