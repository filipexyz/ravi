// Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`) checks, Console
// `sandbox-gateway/listener` SPEC §Request Checks step 4.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  accessClaims,
  createSigner,
  signCompact,
  T,
  TEST_ACCESS_AUD,
  TEST_ACCESS_CLIENT_ID,
  TEST_ACCESS_TEAM_DOMAIN,
  TEST_NOW,
  type TestSigner,
} from "../test/sandbox-grant-tokens.js";
import { accessCertsUrl, verifyAccessAssertion, type VerifyAccessAssertionOptions } from "./access-jwt.js";

const ACCESS_HEADER = { alg: "RS256", kid: "access-key-1", typ: "JWT" };

describe("verifyAccessAssertion", () => {
  let team: TestSigner;
  let otherTeam: TestSigner;
  let good: string;

  const opts = (patch: Partial<VerifyAccessAssertionOptions> = {}): VerifyAccessAssertionOptions => ({
    teamDomain: TEST_ACCESS_TEAM_DOMAIN,
    aud: TEST_ACCESS_AUD,
    jwks: team.keySet,
    serviceTokenClientId: TEST_ACCESS_CLIENT_ID,
    now: TEST_NOW,
    ...patch,
  });
  const forge = (
    overrides: Record<string, unknown> = {},
    header: Record<string, unknown> = ACCESS_HEADER,
    signer = team,
  ) => signCompact(header, accessClaims(overrides), signer.privateKey);
  const reasonOf = async (token: unknown, patch: Partial<VerifyAccessAssertionOptions> = {}) => {
    const result = await verifyAccessAssertion(token, opts(patch));
    return result.ok ? "ok" : result.reason;
  };

  beforeAll(async () => {
    team = await createSigner("RS256", "access-key-1");
    otherTeam = await createSigner("RS256", "access-key-1");
    good = await forge();
  });

  test("accepts a service-token Access JWT for the stored team, AUD and client id", async () => {
    const result = await verifyAccessAssertion(good, opts());
    expect(result).toMatchObject({ ok: true, kid: "access-key-1" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.claims).toEqual({
      iss: `https://${TEST_ACCESS_TEAM_DOMAIN}`,
      aud: [TEST_ACCESS_AUD],
      sub: "",
      type: "app",
      common_name: TEST_ACCESS_CLIENT_ID,
      iat: T,
      exp: T + 300,
    });
    expect(accessCertsUrl(TEST_ACCESS_TEAM_DOMAIN)).toBe(`https://${TEST_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    expect(await reasonOf(await forge({ aud: TEST_ACCESS_AUD }))).toBe("ok");
    expect(await reasonOf(await forge({ aud: ["c".repeat(64), TEST_ACCESS_AUD] }))).toBe("ok");
  });

  test("wrong audience or issuer", async () => {
    expect(await reasonOf(await forge({ aud: ["c".repeat(64)] }))).toBe("audience_mismatch");
    expect(await reasonOf(good, { aud: "c".repeat(64) })).toBe("audience_mismatch");
    expect(await reasonOf(await forge({ iss: "https://evil.cloudflareaccess.com" }))).toBe("issuer_mismatch");
    expect(await reasonOf(await forge({ iss: `https://${TEST_ACCESS_TEAM_DOMAIN}/` }))).toBe("issuer_mismatch");
    // The issuer is derived from the stored team domain, never read from the token.
    expect(await reasonOf(good, { teamDomain: "evil.cloudflareaccess.com", jwks: team.keySet })).toBe(
      "issuer_mismatch",
    );
  });

  test("another team's key under the same kid, and an unknown kid", async () => {
    expect(await reasonOf(await forge({}, ACCESS_HEADER, otherTeam))).toBe("signature_invalid");
    expect(await reasonOf(good, { jwks: otherTeam.keySet })).toBe("signature_invalid");
    expect(await reasonOf(await forge({}, { ...ACCESS_HEADER, kid: "access-key-2" }))).toBe("key_unknown");
    const outage = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await reasonOf(good, { jwks: outage })).toBe("key_set_unavailable");
  });

  test("common_name is pinned when a client id is configured", async () => {
    expect(await reasonOf(await forge({ common_name: "other.access" }))).toBe("common_name_mismatch");
    expect(await reasonOf(await forge({ common_name: undefined }))).toBe("common_name_mismatch");
    expect(await reasonOf(await forge({ common_name: "other.access" }), { serviceTokenClientId: undefined })).toBe(
      "ok",
    );
    expect(await reasonOf(good, { serviceTokenClientId: "" })).toBe("config_invalid");
  });

  test("type must be app; a user identity token is refused", async () => {
    expect(await reasonOf(await forge({ type: "org", email: "a@b.c" }))).toBe("type_invalid");
    expect(await reasonOf(await forge({ type: undefined }))).toBe("type_invalid");
  });

  test("algorithm, header and time", async () => {
    const es = await createSigner("ES256", "access-key-1");
    expect(
      await reasonOf(await signCompact({ ...ACCESS_HEADER, alg: "ES256" }, accessClaims(), es.privateKey), {
        jwks: es.keySet,
      }),
    ).toBe("alg_not_allowed");
    expect(await reasonOf(await forge({}, { alg: "RS256", typ: "JWT" }))).toBe("kid_invalid");
    const crit = await signCompact({ ...ACCESS_HEADER, crit: ["x"], x: 1 }, accessClaims(), team.privateKey, {
      crit: { x: true },
    });
    expect(await reasonOf(crit)).toBe("crit_not_allowed");
    expect(await reasonOf(good, { now: new Date((T + 359) * 1000) })).toBe("ok");
    expect(await reasonOf(good, { now: new Date((T + 361) * 1000) })).toBe("expired");
    expect(await reasonOf(await forge({ nbf: T + 61 }))).toBe("not_yet_valid");
    expect(await reasonOf(await forge({ exp: undefined }))).toBe("timestamps_invalid");
    expect(await reasonOf("not.a.jwt!")).toBe("token_malformed");
  });

  test("configuration grammar is checked before the token", async () => {
    expect(await reasonOf(good, { teamDomain: "acme.example.com" })).toBe("config_invalid");
    expect(await reasonOf(good, { teamDomain: "https://acme.cloudflareaccess.com" })).toBe("config_invalid");
    expect(await reasonOf(good, { aud: "short" })).toBe("config_invalid");
  });
});
