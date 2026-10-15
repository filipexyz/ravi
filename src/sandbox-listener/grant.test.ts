// Daemon-side grant verifier cases, a port of Console's
// `src/shared/sandbox/grant-verify.test.ts`: the two verifiers must reach the
// same verdict with the same reason code for every token here.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  createLocalJWKSet,
  errors as joseErrors,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from "jose";
import {
  b64,
  createSigner,
  encoder,
  GRANT_HEADER,
  grantClaims,
  signCompact,
  T,
  TEST_CONSOLE_ISSUER,
  TEST_GRANT_KID,
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
  TEST_NOW,
  TEST_RUN_ID,
  type TestSigner,
} from "../test/sandbox-grant-tokens.js";
import { installationAudience, SANDBOX_GRANT_TYP } from "./contract.js";
import { type SandboxGrantRejectReason, verifySandboxGrant, type VerifySandboxGrantOptions } from "./grant.js";

describe("verifySandboxGrant (daemon)", () => {
  let issuer: TestSigner;
  let attacker: TestSigner;
  let good: string;

  const opts = (patch: Partial<VerifySandboxGrantOptions> = {}): VerifySandboxGrantOptions => ({
    jwks: issuer.keySet,
    consoleIssuer: TEST_CONSOLE_ISSUER,
    installationId: TEST_INSTALLATION_A,
    now: TEST_NOW,
    ...patch,
  });
  const forge = (payload: unknown, header: Record<string, unknown> = GRANT_HEADER) =>
    signCompact(header, payload, issuer.privateKey);
  const reasonOf = async (token: unknown, patch: Partial<VerifySandboxGrantOptions> = {}) => {
    const result = await verifySandboxGrant(token, opts(patch));
    return result.ok ? "ok" : result.reason;
  };

  beforeAll(async () => {
    issuer = await createSigner("ES256", TEST_GRANT_KID);
    attacker = await createSigner("ES256", TEST_GRANT_KID);
    good = await forge(grantClaims());
  });

  test("accepts a well-formed grant and rebuilds the claims from validated fields only", async () => {
    const result = await verifySandboxGrant(good, opts());
    expect(result).toMatchObject({
      ok: true,
      kid: TEST_GRANT_KID,
      installationId: TEST_INSTALLATION_A,
      runId: TEST_RUN_ID,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.claims).toEqual({
      iss: TEST_CONSOLE_ISSUER,
      aud: installationAudience(TEST_INSTALLATION_A),
      sub: `sandbox-run:${TEST_RUN_ID}`,
      org: "org_123",
      inst: TEST_INSTALLATION_A,
      agent: "ravi",
      task: "task-1",
      caps: ["mutate:task:task-1", "read:task:task-1"],
      cmds: ["tasks.done", "tasks.show"],
      iat: T,
      nbf: T,
      exp: T + 600,
      jti: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    // There is no default Console origin: a missing issuer is misuse, not a
    // verdict (a token without `iss` must never equal an undefined issuer).
    const { consoleIssuer: _issuer, ...withoutIssuer } = opts();
    const noIss = await forge(grantClaims({ iss: undefined }));
    // @ts-expect-error consoleIssuer is required
    await expect(verifySandboxGrant(noIss, withoutIssuer)).rejects.toBeInstanceOf(TypeError);
    await expect(verifySandboxGrant(good, opts({ consoleIssuer: "" }))).rejects.toBeInstanceOf(TypeError);
  });

  test("ignores unknown claims and a payload-level alg", async () => {
    const result = await verifySandboxGrant(await forge(grantClaims({ extra: "x", alg: "none" })), opts());
    expect(result.ok).toBe(true);
    expect(result.ok && result.claims).not.toHaveProperty("extra");
  });

  describe("algorithm confusion", () => {
    test("alg none", async () => {
      const noneHeader = { alg: "none", kid: TEST_GRANT_KID, typ: SANDBOX_GRANT_TYP };
      expect(await reasonOf(`${b64(noneHeader)}.${b64(grantClaims())}.`)).toBe("token_malformed");
      expect(await reasonOf(`${b64(noneHeader)}.${b64(grantClaims())}.AAAA`)).toBe("alg_not_allowed");
    });

    test("HS256 with the public key material as the secret", async () => {
      const spki = await exportSPKI(issuer.publicKey);
      const secrets = [encoder.encode(JSON.stringify(issuer.publicJwk)), encoder.encode(spki)];
      for (const secret of secrets) {
        const token = await new SignJWT(grantClaims())
          .setProtectedHeader({ ...GRANT_HEADER, alg: "HS256" })
          .sign(secret);
        expect(await reasonOf(token)).toBe("alg_not_allowed");
      }
    });

    test("ES384, declared or smuggled into the key set", async () => {
      const p384 = await generateKeyPair("ES384", { extractable: true });
      const jwk384 = { ...(await exportJWK(p384.publicKey)), kid: "sandbox-grant-384", use: "sig" };
      const mixed = createLocalJWKSet({ keys: [issuer.publicJwk, { ...jwk384, alg: "ES384" }] });
      const declared = await signCompact(
        { ...GRANT_HEADER, alg: "ES384", kid: "sandbox-grant-384" },
        grantClaims(),
        p384.privateKey,
      );
      expect(await reasonOf(declared, { jwks: mixed })).toBe("alg_not_allowed");
      const smuggled = createLocalJWKSet({ keys: [jwk384] });
      expect(
        await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, kid: "sandbox-grant-384" }), { jwks: smuggled }),
      ).toBe("key_unknown");
    });
  });

  describe("protected header", () => {
    test("typ, kid grammar and kid resolution", async () => {
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, typ: "JWT" }))).toBe("typ_mismatch");
      expect(await reasonOf(await forge(grantClaims(), { alg: "ES256", kid: TEST_GRANT_KID }))).toBe("typ_mismatch");
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, kid: "SANDBOX-GRANT-1" }))).toBe(
        "kid_invalid",
      );
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, kid: "pages-viewer-assertion-1" }))).toBe(
        "kid_invalid",
      );
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, kid: "sandbox-gate-1" }))).toBe(
        "kid_invalid",
      );
      expect(await reasonOf(await forge(grantClaims(), { alg: "ES256", typ: SANDBOX_GRANT_TYP }))).toBe("kid_invalid");
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, kid: "sandbox-grant-zzz" }))).toBe(
        "key_unknown",
      );
      const duplicate = createLocalJWKSet({ keys: [issuer.publicJwk, { ...issuer.publicJwk, x: issuer.publicJwk.y }] });
      expect(await reasonOf(good, { jwks: duplicate })).toBe("key_unknown");
    });

    test("crit is never allowed, in any shape", async () => {
      const crit = await signCompact(
        { ...GRANT_HEADER, crit: ["x-ravi-test"], "x-ravi-test": true },
        grantClaims(),
        issuer.privateKey,
        {
          crit: { "x-ravi-test": true },
        },
      );
      expect(await reasonOf(crit)).toBe("crit_not_allowed");
      for (const value of [[], null, "x"]) {
        expect(await reasonOf(`${b64({ ...GRANT_HEADER, crit: value })}.${b64(grantClaims())}.AAAA`)).toBe(
          "crit_not_allowed",
        );
      }
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, b64: false }))).toBe("ok");
    });

    test("jwk, jku, x5u and x5c never supply the key", async () => {
      const embedded = await signCompact(
        { ...GRANT_HEADER, jwk: { ...attacker.publicJwk } },
        grantClaims(),
        attacker.privateKey,
      );
      expect(await reasonOf(embedded)).toBe("signature_invalid");
      const jku = await signCompact(
        { ...GRANT_HEADER, jku: "https://evil.example/jwks" },
        grantClaims(),
        attacker.privateKey,
      );
      expect(await reasonOf(jku)).toBe("signature_invalid");
      const x5 = await signCompact(
        { ...GRANT_HEADER, x5u: "https://evil.example/c", x5c: ["AAAA"] },
        grantClaims(),
        attacker.privateKey,
      );
      expect(await reasonOf(x5)).toBe("signature_invalid");
      // On a genuinely signed token the same headers are ignored, not fatal.
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, jku: "https://evil.example/jwks" }))).toBe(
        "ok",
      );
      expect(await reasonOf(await forge(grantClaims(), { ...GRANT_HEADER, jwk: attacker.publicJwk }))).toBe("ok");
    });
  });

  describe("token shape and tampering", () => {
    test("non-strings, wrong segment counts and oversized input are malformed, fast", async () => {
      for (const token of [undefined, null, 123, { token: good }, "a.b", "a.b.c.d", ` ${good}`, `${good}\n`]) {
        expect(await reasonOf(token)).toBe("token_malformed");
      }
      const started = performance.now();
      expect(await reasonOf(`${"a".repeat(400_000)}.${"b".repeat(400_000)}.${"c".repeat(200_000)}`)).toBe(
        "token_malformed",
      );
      expect(performance.now() - started).toBeLessThan(50);
    });

    test("tampered signature or payload, non-object payloads", async () => {
      const [header, , signature] = good.split(".") as [string, string, string];
      expect(
        await reasonOf(`${header}.${b64(grantClaims({ task: "task-2", caps: ["read:task:task-2"] }))}.${signature}`),
      ).toBe("signature_invalid");
      expect(await reasonOf(await signCompact(GRANT_HEADER, grantClaims(), attacker.privateKey))).toBe(
        "signature_invalid",
      );
      expect(await reasonOf(await forge([grantClaims()]))).toBe("token_malformed");
      expect(await reasonOf(await forge("hello"))).toBe("token_malformed");
    });
  });

  describe("audience, installation, issuer and subject", () => {
    test("aud must be one installation string and equal inst", async () => {
      const cases: Array<[Record<string, unknown>, SandboxGrantRejectReason]> = [
        [{ aud: [installationAudience(TEST_INSTALLATION_A)] }, "audience_invalid"],
        [{ aud: "https://console.ravi.bot" }, "audience_invalid"],
        [
          { aud: installationAudience(TEST_INSTALLATION_A.toUpperCase()), inst: TEST_INSTALLATION_A.toUpperCase() },
          "audience_invalid",
        ],
        [{ inst: TEST_INSTALLATION_B }, "inst_mismatch"],
        [{ inst: undefined }, "inst_mismatch"],
      ];
      for (const [patch, reason] of cases) expect(await reasonOf(await forge(grantClaims(patch)))).toBe(reason);
    });

    test("a valid grant for another installation is refused", async () => {
      expect(await reasonOf(good, { installationId: TEST_INSTALLATION_B })).toBe("audience_mismatch");
      const forB = await forge(
        grantClaims({ aud: installationAudience(TEST_INSTALLATION_B), inst: TEST_INSTALLATION_B }),
      );
      expect(await reasonOf(forB)).toBe("audience_mismatch");
      expect(await reasonOf(forB, { installationId: TEST_INSTALLATION_B })).toBe("ok");
    });

    test("issuer is compared byte for byte against the configured origin", async () => {
      expect(await reasonOf(await forge(grantClaims({ iss: `${TEST_CONSOLE_ISSUER}/` })))).toBe("issuer_mismatch");
      expect(await reasonOf(await forge(grantClaims({ iss: "https://evil.example" })))).toBe("issuer_mismatch");
      expect(await reasonOf(good, { consoleIssuer: "https://console.example.test" })).toBe("issuer_mismatch");
      const staging = await forge(grantClaims({ iss: "https://console.example.test" }));
      expect(await reasonOf(staging, { consoleIssuer: "https://console.example.test" })).toBe("ok");
    });

    test("subject, organization, agent and jti grammar", async () => {
      const cases: Array<[Record<string, unknown>, SandboxGrantRejectReason | "ok"]> = [
        [{ sub: "user_1" }, "subject_invalid"],
        [{ sub: `sandbox-run:${TEST_RUN_ID.toUpperCase()}` }, "subject_invalid"],
        [{ sub: "sandbox-run:sbr_abc" }, "subject_invalid"],
        [{ org: "" }, "org_invalid"],
        [{ org: 1 }, "org_invalid"],
        [{ agent: ["ravi"] }, "agent_invalid"],
        [{ jti: "not-a-uuid" }, "jti_invalid"],
      ];
      for (const agent of ["*", "operator", "root", "system", "Operator", "ravi/evil", "", "-x", "_x"])
        cases.push([{ agent }, "agent_invalid"]);
      for (const [patch, reason] of cases) expect(await reasonOf(await forge(grantClaims(patch)))).toBe(reason);
    });
  });

  describe("time", () => {
    const at = (seconds: number) => ({ now: new Date((T + seconds) * 1000) });

    test("lifetime cap at 3900 seconds", async () => {
      expect(await reasonOf(await forge(grantClaims({ exp: T + 3900 })))).toBe("ok");
      expect(await reasonOf(await forge(grantClaims({ exp: T + 3901 })))).toBe("lifetime_exceeded");
      expect(await reasonOf(await forge(grantClaims({ exp: T + 3900 })), at(3959))).toBe("ok");
    });

    test("60 second skew on exp, nbf and iat", async () => {
      expect(await reasonOf(await forge(grantClaims({ exp: T })), at(60))).toBe("expired");
      expect(await reasonOf(await forge(grantClaims({ exp: T + 1 })), at(60))).toBe("ok");
      expect(await reasonOf(good, at(700))).toBe("expired");
      expect(await reasonOf(await forge(grantClaims({ nbf: T + 60, exp: T + 660 })))).toBe("ok");
      expect(await reasonOf(await forge(grantClaims({ nbf: T + 61, exp: T + 660 })))).toBe("not_yet_valid");
      expect(await reasonOf(await forge(grantClaims({ iat: T + 120, nbf: T + 120, exp: T + 720 })))).toBe(
        "not_yet_valid",
      );
    });

    test("timestamps must be present, integer and ordered", async () => {
      const cases: Array<[Record<string, unknown>, SandboxGrantRejectReason]> = [
        [{ nbf: undefined }, "timestamps_invalid"],
        [{ iat: undefined }, "timestamps_invalid"],
        [{ nbf: T - 10 }, "timestamps_invalid"],
        [{ exp: T }, "timestamps_invalid"],
        [{ exp: T + 600.5 }, "timestamps_invalid"],
        [{ exp: String(T + 600) }, "timestamps_invalid"],
      ];
      for (const [patch, reason] of cases) expect(await reasonOf(await forge(grantClaims(patch)))).toBe(reason);
    });
  });

  describe("cmds, caps, task and llm", () => {
    test("cmds grammar, canonical form and allowlist", async () => {
      const cases: Array<[unknown, SandboxGrantRejectReason | "ok"]> = [
        [["tasks._stream"], "cmds_malformed"],
        [["tasks..show"], "cmds_malformed"],
        [["Tasks.show"], "cmds_malformed"],
        [["tasks"], "cmds_malformed"],
        [["a.b.c.d.e.f.g.h.i"], "cmds_malformed"],
        [["tasks.show", "tasks.done"], "cmds_not_canonical"],
        [["tasks.show", "tasks.show"], "cmds_not_canonical"],
        [["tasks.comment"], "cmds_not_allowlisted"],
        [["agents.permissions"], "cmds_not_allowlisted"],
        [Array.from({ length: 33 }, (_, i) => `a.b${String(i).padStart(2, "0")}`), "cmds_too_many"],
        [[], "cmds_empty"],
        ["tasks.show", "cmds_empty"],
        [["tasks.block", "tasks.done", "tasks.fail", "tasks.report", "tasks.show"], "ok"],
      ];
      for (const [cmds, reason] of cases) expect(await reasonOf(await forge(grantClaims({ cmds })))).toBe(reason);
    });

    test("caps are exactly read|mutate:task:<grant.task>", async () => {
      const cases: Array<[Record<string, unknown>, SandboxGrantRejectReason]> = [
        [{ caps: ["read:task:task-2"] }, "caps_task_mismatch"],
        [{ caps: ["mutate:task:task-2", "read:task:task-1"] }, "caps_task_mismatch"],
        [{ caps: ["read:task:*"] }, "caps_malformed"],
        [{ caps: ["execute:group:tasks", "read:task:task-1"] }, "caps_malformed"],
        [{ caps: ["read:task:task-1", "mutate:task:task-1"] }, "caps_not_canonical"],
        [{ caps: [] }, "caps_empty"],
        [{ task: undefined }, "task_required"],
        [{ task: "a".repeat(65), caps: [`read:task:${"a".repeat(65)}`] }, "task_malformed"],
      ];
      for (const [patch, reason] of cases) expect(await reasonOf(await forge(grantClaims(patch)))).toBe(reason);
    });

    test("llm policy shape", async () => {
      expect(await reasonOf(await forge(grantClaims({ llm: { models: ["claude-sonnet-4-5"], budgetUsd: 1 } })))).toBe(
        "ok",
      );
      expect(await reasonOf(await forge(grantClaims({ llm: { models: [], budgetUsd: 1 } })))).toBe("llm_invalid");
      expect(await reasonOf(await forge(grantClaims({ llm: { models: ["m"], budgetUsd: "1" } })))).toBe("llm_invalid");
      expect(await reasonOf(await forge(grantClaims({ llm: null })))).toBe("llm_invalid");
    });
  });

  describe("key set outages", () => {
    test("a key set that cannot load is key_set_unavailable, never a 401 reason", async () => {
      const failing: JWTVerifyGetKey[] = [
        async () => {
          throw new joseErrors.JWKSTimeout();
        },
        async () => {
          throw new TypeError("fetch failed");
        },
        async () => {
          throw new Error("boom");
        },
      ];
      for (const jwks of failing) expect(await reasonOf(good, { jwks })).toBe("key_set_unavailable");
      const unknown: JWTVerifyGetKey = async () => {
        throw new joseErrors.JWKSNoMatchingKey();
      };
      expect(await reasonOf(good, { jwks: unknown })).toBe("key_unknown");
    });

    test("results never leak the token or an error message", async () => {
      const jwks: JWTVerifyGetKey = async () => {
        throw new TypeError(`fetch failed for ${good}`);
      };
      const text = JSON.stringify(await verifySandboxGrant(good, opts({ jwks })));
      expect(text).not.toContain(good.slice(0, 20));
      expect(text).not.toContain("fetch failed");
    });
  });
});
