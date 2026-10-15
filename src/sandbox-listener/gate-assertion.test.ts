// Gate request assertion binding (Console `sandbox-gateway/gate` SPEC §Gate
// Request Assertion; `listener` SPEC §Request Checks step 5).

import { beforeAll, describe, expect, test } from "bun:test";
import {
  createSigner,
  GATE_HEADER,
  gateAssertionClaims,
  GRANT_HEADER,
  grantClaims,
  signCompact,
  T,
  TEST_INSTALLATION_A,
  TEST_INSTALLATION_B,
  TEST_NOW,
  TEST_REQUEST,
  TEST_REQUEST_BODY_TEXT,
  TEST_REQUEST_ID,
  TEST_RUN_ID,
  type TestSigner,
} from "../test/sandbox-grant-tokens.js";
import { installationAudience, runSubject } from "./contract.js";
import {
  commandIdFromPath,
  GateAssertionReplayCache,
  type GateAssertionRunRecord,
  sha256Base64url,
  verifyGateAssertion,
  type VerifyGateAssertionOptions,
} from "./gate-assertion.js";

const OTHER_RUN_ID = "sbr_zzzzzzzzzzzzzzzzzzzzzzzzzz";

describe("verifyGateAssertion", () => {
  let gate: TestSigner;
  let grantIssuer: TestSigner;
  let grant: string;
  let good: string;

  /** The listener's run table: one record for the test run, holding the stored grant's hash. */
  const runTable = (records: GateAssertionRunRecord[]) => (runId: string) =>
    records.find((record) => record.runId === runId) ?? null;
  const storedRun = (): GateAssertionRunRecord => ({ runId: TEST_RUN_ID, grantSha256: sha256Base64url(grant) });

  const opts = (patch: Partial<VerifyGateAssertionOptions> = {}): VerifyGateAssertionOptions => ({
    jwks: gate.keySet,
    installationId: TEST_INSTALLATION_A,
    resolveRun: runTable([storedRun()]),
    request: { ...TEST_REQUEST, requestId: TEST_REQUEST_ID },
    listenerStartedAt: T - 100,
    replayCache: new GateAssertionReplayCache(),
    now: TEST_NOW,
    ...patch,
  });
  const forge = (overrides: Record<string, unknown> = {}, header: Record<string, unknown> = GATE_HEADER) =>
    signCompact(header, gateAssertionClaims(grant, overrides), gate.privateKey);
  const reasonOf = async (token: unknown, patch: Partial<VerifyGateAssertionOptions> = {}) => {
    const result = await verifyGateAssertion(token, opts(patch));
    return result.ok ? "ok" : result.reason;
  };

  beforeAll(async () => {
    gate = await createSigner("ES256", "sandbox-gate-1");
    grantIssuer = await createSigner("ES256", "sandbox-grant-1");
    grant = await signCompact(GRANT_HEADER, grantClaims(), grantIssuer.privateKey);
    good = await forge();
  });

  test("accepts an assertion bound to this exact request, run and grant", async () => {
    const result = await verifyGateAssertion(good, opts());
    expect(result).toMatchObject({ ok: true, kid: "sandbox-gate-1", run: storedRun() });
    if (!result.ok) throw new Error(result.reason);
    expect(result.claims).toEqual({
      iss: "https://gw.ravi.bot",
      aud: installationAudience(TEST_INSTALLATION_A),
      sub: runSubject(TEST_RUN_ID),
      jti: TEST_REQUEST_ID,
      cmd: "tasks.report",
      bodySha256: sha256Base64url(TEST_REQUEST.body),
      grantSha256: sha256Base64url(grant),
      iat: T,
      exp: T + 30,
    });
    // The hash helper treats text as its UTF-8 bytes; the verifier itself only takes bytes.
    expect(sha256Base64url(TEST_REQUEST_BODY_TEXT)).toBe(sha256Base64url(TEST_REQUEST.body));
  });

  test("commandIdFromPath follows the §Identifiers grammar on the raw target", () => {
    expect(commandIdFromPath("/api/v1/tasks/report")).toBe("tasks.report");
    expect(commandIdFromPath("/api/v1/a/b/c/d/e/f/g/h")).toBe("a.b.c.d.e.f.g.h");
    for (const target of [
      "/api/v1/tasks",
      "/api/v1/tasks/_stream",
      "/api/v1/_meta/registry",
      "/api/v1/tasks//report",
      "/api/v1/tasks/report/",
      "/api/v1/../tasks/report",
      "/api/v1/tasks/%72eport",
      "/api/v1/Tasks/report",
      "/api/v1/tasks/report?x=1",
      "/api/v1/tasks/report#f",
      "/api/v1/tasks/./report",
      "/api/v2/tasks/report",
      "/healthz",
      "/api/v1/a/b/c/d/e/f/g/h/i",
    ]) {
      expect(commandIdFromPath(target)).toBeNull();
    }
  });

  describe("required inputs are a type error, never a silent pass", () => {
    test("replayCache, listenerStartedAt, resolveRun and a byte body", async () => {
      const { replayCache: _cache, ...withoutCache } = opts();
      // @ts-expect-error replayCache is required
      await expect(verifyGateAssertion(good, withoutCache)).rejects.toBeInstanceOf(TypeError);
      const { listenerStartedAt: _startedAt, ...withoutStart } = opts();
      // @ts-expect-error listenerStartedAt is required
      await expect(verifyGateAssertion(good, withoutStart)).rejects.toBeInstanceOf(TypeError);
      const { resolveRun: _resolveRun, ...withoutResolve } = opts();
      // @ts-expect-error resolveRun is required
      await expect(verifyGateAssertion(good, withoutResolve)).rejects.toBeInstanceOf(TypeError);
      // A fractional or negative start time is misuse as well.
      await expect(verifyGateAssertion(good, opts({ listenerStartedAt: T + 0.5 }))).rejects.toBeInstanceOf(TypeError);
      await expect(
        verifyGateAssertion(
          good,
          // @ts-expect-error body must be a Uint8Array
          opts({ request: { ...TEST_REQUEST, body: TEST_REQUEST_BODY_TEXT, requestId: TEST_REQUEST_ID } }),
        ),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe("request binding", () => {
    test("method and raw target", async () => {
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, method: "GET", requestId: TEST_REQUEST_ID } })).toBe(
        "request_method_invalid",
      );
      expect(
        await reasonOf(good, {
          request: { ...TEST_REQUEST, target: "/api/v1/tasks/_stream", requestId: TEST_REQUEST_ID },
        }),
      ).toBe("request_path_invalid");
      // A query on the raw target never resolves: the caller passes `req.url` as received.
      expect(
        await reasonOf(good, {
          request: { ...TEST_REQUEST, target: "/api/v1/tasks/report?x=1", requestId: TEST_REQUEST_ID },
        }),
      ).toBe("request_path_invalid");
      // A valid target for another command does not match the `cmd` claim.
      expect(
        await reasonOf(good, {
          request: { ...TEST_REQUEST, target: "/api/v1/tasks/done", requestId: TEST_REQUEST_ID },
        }),
      ).toBe("cmd_mismatch");
      expect(await reasonOf(await forge({ cmd: "tasks.done" }))).toBe("cmd_mismatch");
    });

    test("body hash", async () => {
      expect(
        await reasonOf(good, {
          request: {
            ...TEST_REQUEST,
            body: new TextEncoder().encode(`${TEST_REQUEST_BODY_TEXT} `),
            requestId: TEST_REQUEST_ID,
          },
        }),
      ).toBe("body_hash_mismatch");
      expect(await reasonOf(await forge({ bodySha256: sha256Base64url("{}") }))).toBe("body_hash_mismatch");
      expect(await reasonOf(await forge({ bodySha256: undefined }))).toBe("body_hash_mismatch");
    });

    test("jti equals X-Ravi-Request-Id and is a UUID", async () => {
      const other = "9b2b7a2e-2c7d-4b1a-8d5e-1f2a3b4c5d6e";
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, requestId: other } })).toBe("jti_mismatch");
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, requestId: null } })).toBe("request_id_invalid");
      expect(await reasonOf(good, { request: { ...TEST_REQUEST, requestId: "not-a-uuid" } })).toBe(
        "request_id_invalid",
      );
      expect(
        await reasonOf(await forge({ jti: "x" }), { request: { ...TEST_REQUEST, requestId: TEST_REQUEST_ID } }),
      ).toBe("jti_invalid");
    });

    test("issuer and audience", async () => {
      expect(await reasonOf(await forge({ iss: "https://console.ravi.bot" }))).toBe("issuer_mismatch");
      expect(await reasonOf(await forge({ aud: installationAudience(TEST_INSTALLATION_B) }))).toBe("audience_mismatch");
      expect(await reasonOf(good, { installationId: TEST_INSTALLATION_B })).toBe("audience_mismatch");
      expect(await reasonOf(await forge({ aud: [installationAudience(TEST_INSTALLATION_A)] }))).toBe(
        "audience_mismatch",
      );
    });
  });

  describe("run record lookup", () => {
    const spy = (records: GateAssertionRunRecord[]) => {
      const calls: string[] = [];
      const resolveRun = (runId: string) => {
        calls.push(runId);
        return runTable(records)(runId);
      };
      return { calls, resolveRun };
    };

    test("resolveRun is called once, with the verified run id, after every stateless check", async () => {
      const table = spy([storedRun()]);
      expect(await reasonOf(good, { resolveRun: table.resolveRun })).toBe("ok");
      expect(table.calls).toEqual([TEST_RUN_ID]);
      // An async lookup works the same.
      expect(await reasonOf(good, { resolveRun: async (runId) => runTable([storedRun()])(runId) })).toBe("ok");
    });

    test("an unverified or stale assertion never reaches storage", async () => {
      const table = spy([storedRun()]);
      const attackerSub = runSubject(OTHER_RUN_ID);
      // Forged by a key that is not the Gate's: `sub` is attacker-controlled.
      const forgedByAttacker = await signCompact(
        GATE_HEADER,
        gateAssertionClaims(grant, { sub: attackerSub }),
        grantIssuer.privateKey,
      );
      expect(await reasonOf(forgedByAttacker, { resolveRun: table.resolveRun })).toBe("signature_invalid");
      // Signed by the Gate but for another installation, another request, expired, or pre-start.
      expect(
        await reasonOf(await forge({ aud: installationAudience(TEST_INSTALLATION_B) }), {
          resolveRun: table.resolveRun,
        }),
      ).toBe("audience_mismatch");
      expect(await reasonOf(await forge({ cmd: "tasks.done" }), { resolveRun: table.resolveRun })).toBe("cmd_mismatch");
      expect(await reasonOf(good, { resolveRun: table.resolveRun, now: new Date((T + 90) * 1000) })).toBe("expired");
      expect(await reasonOf(good, { resolveRun: table.resolveRun, listenerStartedAt: T + 1 })).toBe(
        "issued_before_start",
      );
      // A replay is refused by the cache before the lookup.
      const replayCache = new GateAssertionReplayCache();
      expect(await reasonOf(good, { replayCache })).toBe("ok");
      expect(await reasonOf(good, { replayCache, resolveRun: table.resolveRun })).toBe("jti_replayed");
      expect(table.calls).toEqual([]);
      // Garbage `sub` shapes are refused before the lookup too.
      expect(await reasonOf(await forge({ sub: "sandbox-run:../etc" }), { resolveRun: table.resolveRun })).toBe(
        "subject_mismatch",
      );
      expect(await reasonOf(await forge({ sub: undefined }), { resolveRun: table.resolveRun })).toBe(
        "subject_mismatch",
      );
      expect(table.calls).toEqual([]);
    });

    test("unknown run, another run's record, and another grant's hash", async () => {
      expect(await reasonOf(good, { resolveRun: runTable([]) })).toBe("run_unknown");
      expect(await reasonOf(await forge({ sub: runSubject(OTHER_RUN_ID) }))).toBe("run_unknown");
      // A lookup that answers with a different run id is refused.
      expect(await reasonOf(good, { resolveRun: () => ({ ...storedRun(), runId: OTHER_RUN_ID }) })).toBe(
        "subject_mismatch",
      );
      const otherGrant = await signCompact(GRANT_HEADER, grantClaims({ task: "task-2" }), grantIssuer.privateKey);
      expect(
        await reasonOf(good, {
          resolveRun: runTable([{ runId: TEST_RUN_ID, grantSha256: sha256Base64url(otherGrant) }]),
        }),
      ).toBe("grant_hash_mismatch");
      expect(await reasonOf(await forge({ grantSha256: sha256Base64url(otherGrant) }))).toBe("grant_hash_mismatch");
      expect(await reasonOf(await forge({ grantSha256: undefined }))).toBe("grant_hash_mismatch");
      // A rejected lookup never remembers the jti.
      const replayCache = new GateAssertionReplayCache();
      expect(await reasonOf(good, { replayCache, resolveRun: runTable([]) })).toBe("run_unknown");
      expect(replayCache.size).toBe(0);
      expect(await reasonOf(good, { replayCache })).toBe("ok");
    });
  });

  describe("replay", () => {
    test("a jti is single use until exp + 60 s, then forgotten", async () => {
      const replayCache = new GateAssertionReplayCache();
      expect(await reasonOf(good, { replayCache })).toBe("ok");
      expect(await reasonOf(good, { replayCache })).toBe("jti_replayed");
      expect(await reasonOf(good, { replayCache, now: new Date((T + 89) * 1000) })).toBe("jti_replayed");
      expect(replayCache.size).toBe(1);
      // Past exp + 60 s the entry is pruned; the assertion itself is then expired anyway.
      expect(await reasonOf(good, { replayCache, now: new Date((T + 91) * 1000) })).toBe("expired");
      expect(replayCache.has(TEST_REQUEST_ID, T + 91)).toBe(false);
      expect(replayCache.size).toBe(0);
      // A rejected assertion is never remembered.
      expect(await reasonOf(await forge({ cmd: "tasks.done" }), { replayCache })).toBe("cmd_mismatch");
      expect(replayCache.size).toBe(0);
    });

    test("restart: an assertion served at T, listener restarted at T+59, replayed at T+119 is refused", async () => {
      // The reviewer's scenario. With a 60 s skew on `iat ≥ listenerStartedAt`
      // the fresh cache after the restart would accept it (iat T ≥ T+59−60),
      // inside the exp + 60 s window. Without skew it is `issued_before_start`.
      const served = await forge({ iat: T, exp: T + 60 });
      const beforeRestart = new GateAssertionReplayCache();
      expect(await reasonOf(served, { replayCache: beforeRestart, listenerStartedAt: T - 100 })).toBe("ok");
      const afterRestart = new GateAssertionReplayCache();
      expect(
        await reasonOf(served, {
          replayCache: afterRestart,
          listenerStartedAt: T + 59,
          now: new Date((T + 119) * 1000),
        }),
      ).toBe("issued_before_start");
      expect(afterRestart.size).toBe(0);
      // The boundary: issued exactly at the start is fine, one second before is not.
      expect(await reasonOf(served, { listenerStartedAt: T })).toBe("ok");
      expect(await reasonOf(served, { listenerStartedAt: T + 1 })).toBe("issued_before_start");
    });

    test("two caches in one process accept the same jti once each (closed by 04b's persisted queue)", async () => {
      // Documents why the listener owns exactly one `GateAssertionReplayCache`
      // per process: replay protection is only as strong as cache sharing.
      // 04b backs the cache with the persisted served-jti queue so that
      // neither a second cache nor a restart inside `exp + 60 s` reopens it.
      const first = new GateAssertionReplayCache();
      const second = new GateAssertionReplayCache();
      expect(await reasonOf(good, { replayCache: first })).toBe("ok");
      expect(await reasonOf(good, { replayCache: second })).toBe("ok");
      expect(await reasonOf(good, { replayCache: first })).toBe("jti_replayed");
      expect(await reasonOf(good, { replayCache: second })).toBe("jti_replayed");
    });
  });

  describe("freshness", () => {
    const at = (seconds: number) => ({ now: new Date((T + seconds) * 1000) });

    test("exp ≤ iat + 60 with ±60 s skew on exp", async () => {
      expect(await reasonOf(await forge({ exp: T + 60 }))).toBe("ok");
      expect(await reasonOf(await forge({ exp: T + 61 }))).toBe("lifetime_exceeded");
      expect(await reasonOf(good, at(89))).toBe("ok");
      expect(await reasonOf(good, at(90))).toBe("expired");
      expect(await reasonOf(await forge({ iat: T + 60, exp: T + 90 }))).toBe("ok");
      expect(await reasonOf(await forge({ iat: T + 61, exp: T + 91 }))).toBe("timestamps_invalid");
      expect(await reasonOf(await forge({ exp: T }))).toBe("timestamps_invalid");
      expect(await reasonOf(await forge({ iat: undefined }))).toBe("timestamps_invalid");
    });

    test("issued before the listener started is refused, with no skew", async () => {
      expect(await reasonOf(good, { listenerStartedAt: T })).toBe("ok");
      expect(await reasonOf(good, { listenerStartedAt: T + 1 })).toBe("issued_before_start");
      expect(await reasonOf(good, { listenerStartedAt: T + 60 })).toBe("issued_before_start");
    });
  });

  describe("header and key family", () => {
    test("typ, alg, crit and kid family", async () => {
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, typ: "ravi-sandbox-grant+jwt" }))).toBe("typ_mismatch");
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, kid: "sandbox-grant-1" }))).toBe("kid_invalid");
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, kid: "sandbox-gate-zzz" }))).toBe("key_unknown");
      expect(await reasonOf(await forge({}, { ...GATE_HEADER, crit: ["b64"], b64: true }))).toBe("crit_not_allowed");
      expect(await reasonOf(`${good.split(".")[0]}.${good.split(".")[1]}.`)).toBe("token_malformed");
      expect(await reasonOf(undefined)).toBe("token_malformed");
    });

    test("a grant key signing a gate kid, or the gate JWKS swapped for the grant JWKS, is refused", async () => {
      const crossSigned = await signCompact(GATE_HEADER, gateAssertionClaims(grant), grantIssuer.privateKey);
      expect(await reasonOf(crossSigned)).toBe("signature_invalid");
      expect(await reasonOf(good, { jwks: grantIssuer.keySet })).toBe("key_unknown");
      const outage = async () => {
        throw new TypeError("fetch failed");
      };
      expect(await reasonOf(good, { jwks: outage })).toBe("key_set_unavailable");
    });
  });
});
