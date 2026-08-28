import { describe, expect, it } from "bun:test";

import {
  CORS_REQUIRED_HEADERS,
  corsHeaders,
  isAllowedOrigin,
  isDevLocalhostOrigin,
  withCorsHeaders,
} from "./cors.js";

const CHROME_EXTENSION = "chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef";
const LISTED_ORIGIN = "http://127.0.0.1:8088";
const OTHER_LISTED = "https://app.example.test";
const UNKNOWN_ORIGIN = "https://evil.com";
const REQUIRED_HEADER_SET = new Set(CORS_REQUIRED_HEADERS.map((header) => header.toLowerCase()));

function allowHeaderSet(value: string | null): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean),
  );
}

function expectRequiredAllowHeaders(headers: Record<string, string>): void {
  const allowed = allowHeaderSet(headers["Access-Control-Allow-Headers"] ?? null);
  for (const header of REQUIRED_HEADER_SET) {
    expect(allowed.has(header)).toBe(true);
  }
}

describe("isAllowedOrigin", () => {
  it("allows chrome-extension:// origins without env", () => {
    expect(isAllowedOrigin(CHROME_EXTENSION, {})).toBe(true);
    expect(isAllowedOrigin("chrome-extension://short", {})).toBe(true);
  });

  it("echoes only origins listed in RAVI_CORS_ORIGINS", () => {
    const env = { RAVI_CORS_ORIGINS: `${LISTED_ORIGIN}, ${OTHER_LISTED}` };
    expect(isAllowedOrigin(LISTED_ORIGIN, env)).toBe(true);
    expect(isAllowedOrigin(OTHER_LISTED, env)).toBe(true);
    expect(isAllowedOrigin(UNKNOWN_ORIGIN, env)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1:8088/", env)).toBe(false);
  });

  it("does not treat * as an allowlist entry", () => {
    expect(isAllowedOrigin(UNKNOWN_ORIGIN, { RAVI_CORS_ORIGINS: "*" })).toBe(false);
    expect(isAllowedOrigin("*", { RAVI_CORS_ORIGINS: "*" })).toBe(false);
  });

  it("rejects missing or empty Origin", () => {
    expect(isAllowedOrigin(null, { RAVI_CORS_ORIGINS: LISTED_ORIGIN })).toBe(false);
    expect(isAllowedOrigin("", { RAVI_CORS_ORIGINS: LISTED_ORIGIN })).toBe(false);
  });

  it("keeps production closed when the localhost flag is unset", () => {
    expect(isAllowedOrigin(LISTED_ORIGIN, {})).toBe(false);
    expect(isAllowedOrigin("http://localhost:8088", {})).toBe(false);
  });

  it("RAVI_CORS_LOCALHOST=1 allows only loopback http origins", () => {
    const env = { RAVI_CORS_LOCALHOST: "1" };
    expect(isAllowedOrigin("http://127.0.0.1:8088", env)).toBe(true);
    expect(isAllowedOrigin("http://localhost:8088", env)).toBe(true);
    expect(isAllowedOrigin(UNKNOWN_ORIGIN, env)).toBe(false);
    expect(isAllowedOrigin("https://127.0.0.1:8088", env)).toBe(false);
    expect(isAllowedOrigin("http://127.0.0.1.evil.com:8088", env)).toBe(false);
    expect(isAllowedOrigin("http://localhost.evil.com:8088", env)).toBe(false);
  });
});

describe("isDevLocalhostOrigin", () => {
  it("accepts http loopback with or without an explicit port", () => {
    expect(isDevLocalhostOrigin("http://127.0.0.1:8088")).toBe(true);
    expect(isDevLocalhostOrigin("http://localhost:5173")).toBe(true);
    expect(isDevLocalhostOrigin("http://127.0.0.1")).toBe(true);
    expect(isDevLocalhostOrigin("http://localhost")).toBe(true);
  });

  it("rejects non-origin lookalikes", () => {
    expect(isDevLocalhostOrigin("http://127.0.0.1:8088/path")).toBe(false);
    expect(isDevLocalhostOrigin("http://user@127.0.0.1:8088")).toBe(false);
    expect(isDevLocalhostOrigin("not-a-url")).toBe(false);
  });
});

describe("corsHeaders", () => {
  it("echoes chrome-extension Origin and never sets *", () => {
    const headers = corsHeaders(CHROME_EXTENSION, null, {});
    expect(headers["Access-Control-Allow-Origin"]).toBe(CHROME_EXTENSION);
    expect(headers["Access-Control-Allow-Origin"]).not.toBe("*");
    expect(headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
    expectRequiredAllowHeaders(headers);
  });

  it("echoes a listed origin", () => {
    const headers = corsHeaders(LISTED_ORIGIN, null, { RAVI_CORS_ORIGINS: LISTED_ORIGIN });
    expect(headers["Access-Control-Allow-Origin"]).toBe(LISTED_ORIGIN);
    expect(Object.values(headers).includes("*")).toBe(false);
  });

  it("omits ACAO for an unknown origin", () => {
    const headers = corsHeaders(UNKNOWN_ORIGIN, null, { RAVI_CORS_ORIGINS: LISTED_ORIGIN });
    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers).toEqual({});
  });

  it("never sets Access-Control-Allow-Origin to *", () => {
    const cases: Array<[string | null, NodeJS.ProcessEnv]> = [
      [null, {}],
      ["*", {}],
      ["*", { RAVI_CORS_ORIGINS: "*" }],
      [UNKNOWN_ORIGIN, { RAVI_CORS_ORIGINS: "*" }],
      [LISTED_ORIGIN, { RAVI_CORS_ORIGINS: LISTED_ORIGIN }],
      [CHROME_EXTENSION, {}],
      [LISTED_ORIGIN, { RAVI_CORS_LOCALHOST: "1" }],
    ];
    for (const [origin, env] of cases) {
      const headers = corsHeaders(origin, null, env);
      expect(headers["Access-Control-Allow-Origin"] === "*").toBe(false);
    }
  });

  it("localhost flag allows 127.0.0.1:8088 and not evil.com", () => {
    const env = { RAVI_CORS_LOCALHOST: "1" };
    expect(corsHeaders("http://127.0.0.1:8088", null, env)["Access-Control-Allow-Origin"]).toBe(
      "http://127.0.0.1:8088",
    );
    expect(corsHeaders(UNKNOWN_ORIGIN, null, env)["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("OPTIONS preflight includes the four SDK headers", () => {
    const requested = "authorization,content-type,x-ravi-sdk-version,x-ravi-registry-hash";
    const headers = corsHeaders(CHROME_EXTENSION, requested, {});
    expectRequiredAllowHeaders(headers);
    const allowed = allowHeaderSet(headers["Access-Control-Allow-Headers"] ?? null);
    expect(allowed.has("authorization")).toBe(true);
    expect(allowed.has("content-type")).toBe(true);
    expect(allowed.has("x-ravi-sdk-version")).toBe(true);
    expect(allowed.has("x-ravi-registry-hash")).toBe(true);
  });

  it("includes the four required headers even when Access-Control-Request-Headers is absent", () => {
    expectRequiredAllowHeaders(corsHeaders(CHROME_EXTENSION, null, {}));
  });
});

describe("withCorsHeaders", () => {
  it("leaves the response unchanged when Origin is not allowed", () => {
    const response = new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    const next = withCorsHeaders(response, UNKNOWN_ORIGIN, null, {});
    expect(next.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(next.headers.get("content-type")).toBe("text/plain");
  });

  it("attaches the same CORS headers used by SSE and command responses", () => {
    const response = new Response("ok", { status: 200, headers: { "content-type": "text/event-stream" } });
    const next = withCorsHeaders(response, LISTED_ORIGIN, null, { RAVI_CORS_ORIGINS: LISTED_ORIGIN });
    expect(next.headers.get("Access-Control-Allow-Origin")).toBe(LISTED_ORIGIN);
    expect(next.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(next.headers.get("content-type")).toBe("text/event-stream");
    const allowed = allowHeaderSet(next.headers.get("Access-Control-Allow-Headers"));
    for (const header of REQUIRED_HEADER_SET) {
      expect(allowed.has(header)).toBe(true);
    }
  });
});
