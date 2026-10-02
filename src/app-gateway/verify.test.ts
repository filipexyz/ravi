import { beforeAll, describe, expect, it } from "bun:test";
import {
  assertionClaims,
  createFakeJwks,
  createTestKey,
  grantClaims,
  signToken,
  TEST_INSTALLATION_ID,
  TEST_ISSUER,
  TEST_ORG_ID,
  type TestKey,
} from "../test/app-gateway-tokens.js";
import { AppGatewayJwksClient, AppGatewayJwksUnavailableError } from "./jwks.js";
import { AppGatewayRefusal, AppGatewayVerifier, type VerifiedTargetGrant } from "./verify.js";

const GRANT_TYP = "ravi-app-target+jwt";
const ASSERTION_TYP = "JWT";
const BINDING = { installationId: TEST_INSTALLATION_ID, organizationId: TEST_ORG_ID };

let grantKey: TestKey;
let assertionKey: TestKey;
let ticketKey: TestKey;

beforeAll(async () => {
  grantKey = await createTestKey("pages-app-target-2026-10");
  assertionKey = await createTestKey("pages-viewer-assertion-2026-10");
  ticketKey = await createTestKey("pages-executor-relay-2026-10");
});

function setup(nowMs = Date.UTC(2026, 9, 1, 12)) {
  const clock = { now: nowMs };
  const jwks = createFakeJwks([grantKey, assertionKey, ticketKey]);
  const client = new AppGatewayJwksClient({
    url: "https://console.ravi.test/jwks",
    fetch: jwks.fetch,
    now: () => clock.now,
  });
  const verifier = new AppGatewayVerifier({ resolveKey: client.resolveKey, issuer: TEST_ISSUER, now: () => clock.now });
  return { clock, jwks, client, verifier };
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppGatewayRefusal);
    expect((error as AppGatewayRefusal).code as string).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
}

async function verifiedGrant(verifier: AppGatewayVerifier, nowMs: number): Promise<VerifiedTargetGrant> {
  const grant = await signToken({ key: grantKey, claims: grantClaims(nowMs), typ: GRANT_TYP });
  return verifier.verifyGrant(grant, BINDING);
}

describe("Pages app gateway grant verification", () => {
  it("accepts a grant with the exact claim set bound to this installation", async () => {
    const { clock, verifier } = setup();
    const grant = await verifiedGrant(verifier, clock.now);
    expect(grant).toMatchObject({
      app: "slides",
      operations: ["slides.list", "slides.get"],
      installation: TEST_INSTALLATION_ID,
      raviOrgId: TEST_ORG_ID,
    });
  });

  it("refuses wrong family kid, typ, algorithm, and issuer", async () => {
    const { clock, verifier } = setup();
    const claims = grantClaims(clock.now);
    // Signed by the viewer-assertion family key.
    await expectRefusal(
      verifier.verifyGrant(await signToken({ key: assertionKey, claims, typ: GRANT_TYP }), BINDING),
      "app_gateway_grant_invalid",
    );
    // Right prefix but the key is from another family (kid points to a key that does not exist).
    await expectRefusal(
      verifier.verifyGrant(
        await signToken({ key: ticketKey, claims, typ: GRANT_TYP, kid: "pages-app-target-forged" }),
        BINDING,
      ),
      "app_gateway_grant_invalid",
    );
    await expectRefusal(
      verifier.verifyGrant(await signToken({ key: grantKey, claims, typ: "JWT" }), BINDING),
      "app_gateway_grant_invalid",
    );
    await expectRefusal(
      verifier.verifyGrant(
        await signToken({ key: grantKey, claims: { ...claims, iss: "https://evil.example" }, typ: GRANT_TYP }),
        BINDING,
      ),
      "app_gateway_grant_invalid",
    );
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", typ: GRANT_TYP, kid: grantKey.kid })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    await expectRefusal(verifier.verifyGrant(unsigned, BINDING), "app_gateway_grant_invalid");
  });

  it("refuses another installation or organization", async () => {
    const { clock, verifier } = setup();
    const grant = await signToken({ key: grantKey, claims: grantClaims(clock.now), typ: GRANT_TYP });
    await expectRefusal(
      verifier.verifyGrant(grant, { ...BINDING, installationId: "00000000-0000-4000-8000-000000000000" }),
      "app_gateway_grant_invalid",
    );
    await expectRefusal(
      verifier.verifyGrant(grant, { ...BINDING, organizationId: "00000000-0000-4000-8000-000000000000" }),
      "app_gateway_grant_invalid",
    );
  });

  it("enforces expiry with 5 s tolerance, lifetime, exact claims, and grammar", async () => {
    const { clock, verifier } = setup();
    const issuedAt = clock.now - 21_600_000;
    // exp = now - 3 s: inside the tolerance.
    const almost = await signToken({
      key: grantKey,
      claims: grantClaims(issuedAt + 3_000 - 6_000),
      typ: GRANT_TYP,
    });
    await expect(verifier.verifyGrant(almost, BINDING)).resolves.toBeTruthy();

    const expired = await signToken({ key: grantKey, claims: grantClaims(issuedAt - 6_000), typ: GRANT_TYP });
    await expectRefusal(verifier.verifyGrant(expired, BINDING), "app_gateway_grant_invalid");

    const iat = Math.floor(clock.now / 1000);
    for (const overrides of [
      { exp: iat + 21_601 },
      { exp: iat },
      { aud: ["https://apps.example.ravi.local/slides"] },
      { aud: "https://apps.example/*" },
      { app: "Slides" },
      { operations: [] },
      { operations: ["slides"] },
      { origins: ["http://demo.ravi.page"] },
      { origins: ["https://demo.ravi.page/path"] },
      { installation: "not-a-uuid" },
      { extra: true },
    ]) {
      const token = await signToken({ key: grantKey, claims: grantClaims(clock.now, overrides), typ: GRANT_TYP });
      await expectRefusal(verifier.verifyGrant(token, BINDING), "app_gateway_grant_invalid");
    }
    const missing = grantClaims(clock.now);
    delete missing.target;
    await expectRefusal(
      verifier.verifyGrant(await signToken({ key: grantKey, claims: missing, typ: GRANT_TYP }), BINDING),
      "app_gateway_grant_invalid",
    );
  });
});

describe("Pages app gateway viewer assertion verification", () => {
  it("accepts an assertion for the grant audience and refuses every mismatch", async () => {
    const { clock, verifier } = setup();
    const grant = await verifiedGrant(verifier, clock.now);
    const ok = await signToken({ key: assertionKey, claims: assertionClaims(clock.now), typ: ASSERTION_TYP });
    await expect(verifier.verifyAssertion(ok, grant)).resolves.toMatchObject({ raviUserId: "user_01JABCDEF" });

    const iat = Math.floor(clock.now / 1000);
    for (const overrides of [
      { aud: "https://other.example" },
      { aud: [grant.aud] },
      { actor: "agent" },
      { sub: "someone-else" },
      { exp: iat + 61 },
      { site: "00000000-0000-4000-8000-000000000000" },
      { project: "00000000-0000-4000-8000-000000000000" },
      { raviOrgId: "00000000-0000-4000-8000-000000000000" },
      { jti: "" },
    ]) {
      const token = await signToken({
        key: assertionKey,
        claims: assertionClaims(clock.now, overrides),
        typ: ASSERTION_TYP,
      });
      await expectRefusal(verifier.verifyAssertion(token, grant), "app_gateway_assertion_invalid");
    }

    // A lagging local clock does not refuse a fresh assertion (future iat, fixed 60 s life).
    const skewed = await signToken({
      key: assertionKey,
      claims: assertionClaims(clock.now + 30_000),
      typ: ASSERTION_TYP,
    });
    await expect(verifier.verifyAssertion(skewed, grant)).resolves.toBeTruthy();

    // A grant-family key never verifies an assertion, and the typ must be exact.
    await expectRefusal(
      verifier.verifyAssertion(
        await signToken({ key: grantKey, claims: assertionClaims(clock.now), typ: ASSERTION_TYP }),
        grant,
      ),
      "app_gateway_assertion_invalid",
    );
    await expectRefusal(
      verifier.verifyAssertion(
        await signToken({ key: assertionKey, claims: assertionClaims(clock.now), typ: GRANT_TYP }),
        grant,
      ),
      "app_gateway_assertion_invalid",
    );

    // Expired 6 s ago.
    const stale = await signToken({
      key: assertionKey,
      claims: assertionClaims(clock.now - 66_000),
      typ: ASSERTION_TYP,
    });
    await expectRefusal(verifier.verifyAssertion(stale, grant), "app_gateway_assertion_invalid");
  });
});

describe("Pages app gateway JWKS client", () => {
  it("refreshes after 300 s and keeps a stale set for at most 3600 s when Console fails", async () => {
    const { clock, jwks, verifier } = setup();
    await verifiedGrant(verifier, clock.now);
    expect(jwks.fetchCount).toBe(1);

    clock.now += 299_000;
    await verifiedGrant(verifier, clock.now);
    expect(jwks.fetchCount).toBe(1);

    clock.now += 2_000;
    jwks.fail = true;
    await verifiedGrant(verifier, clock.now);
    expect(jwks.fetchCount).toBe(2);

    // Inside the stale window a failing Console is not retried on every invoke.
    clock.now += 10_000;
    await verifiedGrant(verifier, clock.now);
    expect(jwks.fetchCount).toBe(2);

    clock.now = clock.now - 311_000 + 3_601_000;
    const grant = await signToken({ key: grantKey, claims: grantClaims(clock.now), typ: GRANT_TYP });
    await expectRefusal(verifier.verifyGrant(grant, BINDING), "app_gateway_unavailable");

    jwks.fail = false;
    await expect(verifier.verifyGrant(grant, BINDING)).resolves.toBeTruthy();
  });

  it("refetches an unknown kid at most once per 30 s and answers unavailable when that refetch fails", async () => {
    const { clock, jwks, client, verifier } = setup();
    const lateKey = await createTestKey("pages-app-target-rotated");
    await verifiedGrant(verifier, clock.now);
    expect(jwks.fetchCount).toBe(1);

    const rotated = await signToken({ key: lateKey, claims: grantClaims(clock.now), typ: GRANT_TYP });
    await expectRefusal(verifier.verifyGrant(rotated, BINDING), "app_gateway_grant_invalid");
    expect(jwks.fetchCount).toBe(2);

    // Published now, but the cooldown keeps the second unknown-kid refetch off.
    jwks.keys = [...jwks.keys, lateKey.publicJwk];
    clock.now += 10_000;
    await expectRefusal(verifier.verifyGrant(rotated, BINDING), "app_gateway_grant_invalid");
    expect(jwks.fetchCount).toBe(2);

    clock.now += 21_000;
    await expect(verifier.verifyGrant(rotated, BINDING)).resolves.toBeTruthy();
    expect(jwks.fetchCount).toBe(3);

    const unknown = await createTestKey("pages-app-target-unknown");
    jwks.fail = true;
    clock.now += 31_000;
    await expect(
      client.resolveKey({ alg: "ES256", kid: unknown.kid }, { payload: "", protected: "", signature: "" }),
    ).rejects.toBeInstanceOf(AppGatewayJwksUnavailableError);
  });

  it("answers unavailable when no set was ever fetched", async () => {
    const { clock, jwks, verifier } = setup();
    jwks.fail = true;
    const grant = await signToken({ key: grantKey, claims: grantClaims(clock.now), typ: GRANT_TYP });
    await expectRefusal(verifier.verifyGrant(grant, BINDING), "app_gateway_unavailable");
  });
});
