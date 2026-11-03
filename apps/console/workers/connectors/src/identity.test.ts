import { describe, expect, test } from "bun:test";

import { decodeIdTokenClaims, sameAccount } from "./identity";

function fakeIdToken(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

describe("id_token identity", () => {
  test("reads sub and a lower-cased email from the payload", () => {
    expect(decodeIdTokenClaims(fakeIdToken({ sub: "1234567890", email: "Ana@Example.COM" }))).toEqual({
      sub: "1234567890",
      email: "ana@example.com",
    });
  });

  test("handles base64url payloads with non-ASCII claims", () => {
    const token = fakeIdToken({ sub: "42", email: "jose@example.com", name: "José Ünïcode ~~ ??>>" });
    expect(decodeIdTokenClaims(token)).toEqual({ sub: "42", email: "jose@example.com" });
  });

  test("returns null for missing, malformed or claimless tokens", () => {
    expect(decodeIdTokenClaims(undefined)).toBeNull();
    expect(decodeIdTokenClaims("not-a-jwt")).toBeNull();
    expect(decodeIdTokenClaims("a.%%%.c")).toBeNull();
    expect(decodeIdTokenClaims(fakeIdToken({ aud: "client" }))).toBeNull();
  });

  test("compares accounts by sub, then by email, else unknown", () => {
    expect(sameAccount({ sub: "1", email: "a@x.com" }, { sub: "1", email: "b@x.com" })).toBe(true);
    expect(sameAccount({ sub: "1", email: "a@x.com" }, { sub: "2", email: "a@x.com" })).toBe(false);
    expect(sameAccount({ sub: null, email: "A@x.com" }, { sub: "2", email: "a@x.com" })).toBe(true);
    expect(sameAccount({ sub: null, email: null }, { sub: "2", email: "a@x.com" })).toBeNull();
  });
});
