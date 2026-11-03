import { afterEach, describe, expect, it } from "bun:test";

import { authorizeAdminRequest, getAdminToken } from "./auth";

const TOKEN = "test-admin-token-with-enough-length-aaaa";

function makeRequest(headers: Record<string, string> = {}) {
  return new Request("https://example.test/api/internal/admin/diagnose", { headers });
}

describe("getAdminToken", () => {
  const original = process.env.RAVI_ADMIN_TOKEN;
  afterEach(() => {
    if (original === undefined) delete process.env.RAVI_ADMIN_TOKEN;
    else process.env.RAVI_ADMIN_TOKEN = original;
  });

  it("returns null when the env value is missing", () => {
    delete process.env.RAVI_ADMIN_TOKEN;
    expect(getAdminToken()).toBeNull();
  });

  it("returns null when the env value is too short", () => {
    process.env.RAVI_ADMIN_TOKEN = "short";
    expect(getAdminToken()).toBeNull();
  });

  it("returns the trimmed value when it meets the minimum length", () => {
    process.env.RAVI_ADMIN_TOKEN = `  ${TOKEN}  `;
    expect(getAdminToken()).toBe(TOKEN);
  });
});

describe("authorizeAdminRequest", () => {
  it("returns false when no token is configured", () => {
    expect(authorizeAdminRequest(makeRequest({ authorization: `Bearer ${TOKEN}` }), null)).toBe(false);
  });

  it("returns false when authorization header is missing", () => {
    expect(authorizeAdminRequest(makeRequest(), TOKEN)).toBe(false);
  });

  it("returns false when authorization scheme is not Bearer", () => {
    expect(authorizeAdminRequest(makeRequest({ authorization: `Basic ${TOKEN}` }), TOKEN)).toBe(false);
  });

  it("returns false when token length differs", () => {
    expect(authorizeAdminRequest(makeRequest({ authorization: "Bearer too-short" }), TOKEN)).toBe(false);
  });

  it("returns false when token does not match", () => {
    expect(authorizeAdminRequest(makeRequest({ authorization: "Bearer wrong-token-with-enough-len-aaaa" }), TOKEN)).toBe(
      false,
    );
  });

  it("returns true for an exact Bearer match", () => {
    expect(authorizeAdminRequest(makeRequest({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true);
  });
});
