// JWKS cache rules: 300 s refresh, 3600 s stale-if-error, one unknown-kid
// refetch per 30 s, 5 s timeout, 64 KiB cap, no redirects, 0600 persistence.

import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errors as joseErrors } from "jose";
import {
  createSigner,
  failingResponder,
  fakeJwksOrigin,
  GRANT_HEADER,
  grantClaims,
  jwksResponse,
  signCompact,
  TEST_CONSOLE_ISSUER,
  TEST_INSTALLATION_A,
  TEST_NOW,
  type TestSigner,
} from "../test/sandbox-grant-tokens.js";
import { verifySandboxGrant } from "./grant.js";
import { JWKS_MAX_BYTES, JwksCache, JwksUnavailableError } from "./jwks-cache.js";

const URL = "https://console.ravi.bot/api/public/sandbox/jwks";
const HEADER = { alg: "ES256", kid: "sandbox-grant-1" };

describe("JwksCache", () => {
  let issuer: TestSigner;
  let rotated: TestSigner;
  let token: string;
  let clock: number;
  const now = () => clock;
  const tick = (ms: number) => {
    clock += ms;
  };
  const resolve = (cache: JwksCache, kid = "sandbox-grant-1") =>
    cache.resolveKey({ ...HEADER, kid }, { protected: "", payload: "", signature: "" });

  beforeAll(async () => {
    issuer = await createSigner("ES256", "sandbox-grant-1");
    rotated = await createSigner("ES256", "sandbox-grant-2");
    token = await signCompact(GRANT_HEADER, grantClaims(), issuer.privateKey);
  });

  const serving = (signer: TestSigner) => () => jwksResponse(signer.jwks);

  test("cold start with the origin down fails closed as unavailable", async () => {
    clock = 1_000_000;
    const origin = fakeJwksOrigin(failingResponder);
    const cache = new JwksCache({ url: URL, fetch: origin.fetch, now });
    await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
    const result = await verifySandboxGrant(token, {
      jwks: cache,
      consoleIssuer: TEST_CONSOLE_ISSUER,
      installationId: TEST_INSTALLATION_A,
      now: TEST_NOW,
    });
    expect(result).toEqual({ ok: false, reason: "key_set_unavailable" });
    expect(cache.snapshot()).toEqual({ fetchedAt: null, hasKeys: false });
  });

  test("the request carries redirect: error, a timeout signal and no credentials", async () => {
    clock = 1_000_000;
    const origin = fakeJwksOrigin(serving(issuer));
    await resolve(new JwksCache({ url: URL, fetch: origin.fetch, now }));
    expect(origin.calls).toHaveLength(1);
    expect(origin.calls[0]!.url).toBe(URL);
    expect(origin.calls[0]!.init).toMatchObject({ method: "GET", redirect: "error" });
    expect(origin.calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(() => new JwksCache({ url: "http://console.ravi.bot/jwks", fetch: origin.fetch })).toThrow(/https/);
  });

  test("refreshes after 300 s, serves stale for 3600 s while the origin fails, then fails closed", async () => {
    clock = 1_000_000;
    const origin = fakeJwksOrigin(serving(issuer));
    const cache = new JwksCache({ url: URL, fetch: origin.fetch, now });
    await resolve(cache);
    tick(299_000);
    await resolve(cache);
    expect(origin.calls).toHaveLength(1);
    origin.respond(failingResponder);
    tick(2_000); // 301 s: refresh attempted and fails; stale set still served
    await expect(resolve(cache)).resolves.toBeDefined();
    expect(origin.calls).toHaveLength(2);
    tick(10_000); // within the 30 s cooldown: no new attempt
    await resolve(cache);
    expect(origin.calls).toHaveLength(2);
    tick(30_000);
    await resolve(cache);
    expect(origin.calls).toHaveLength(3);
    clock = 1_000_000 + 3_600_000; // exactly 3600 s after the fetch: still usable
    await expect(resolve(cache)).resolves.toBeDefined();
    tick(1_000);
    await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
    // Verification through the cache maps the outage to key_set_unavailable.
    expect(
      await verifySandboxGrant(token, {
        jwks: cache,
        consoleIssuer: TEST_CONSOLE_ISSUER,
        installationId: TEST_INSTALLATION_A,
        now: TEST_NOW,
      }),
    ).toEqual({
      ok: false,
      reason: "key_set_unavailable",
    });
    origin.respond(serving(issuer));
    await expect(resolve(cache)).resolves.toBeDefined();
  });

  test("an unknown kid refetches at most once per 30 s", async () => {
    clock = 1_000_000;
    const origin = fakeJwksOrigin(serving(issuer));
    const cache = new JwksCache({ url: URL, fetch: origin.fetch, now });
    await resolve(cache);
    await expect(resolve(cache, "sandbox-grant-2")).rejects.toBeInstanceOf(joseErrors.JWKSNoMatchingKey);
    expect(origin.calls).toHaveLength(2);
    tick(29_000);
    await expect(resolve(cache, "sandbox-grant-2")).rejects.toBeInstanceOf(joseErrors.JWKSNoMatchingKey);
    expect(origin.calls).toHaveLength(2);
    // The key is rotated in; after the cooldown the refetch picks it up.
    origin.respond(() => jwksResponse({ keys: [issuer.publicJwk, rotated.publicJwk] }));
    tick(1_000);
    await expect(resolve(cache, "sandbox-grant-2")).resolves.toBeDefined();
    expect(origin.calls).toHaveLength(3);
    // A failed unknown-kid refetch is an outage, not a verdict.
    origin.respond(failingResponder);
    tick(30_000);
    await expect(resolve(cache, "sandbox-grant-3")).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  test("oversized bodies, redirects, non-2xx and malformed documents are refused", async () => {
    clock = 1_000_000;
    const big = JSON.stringify({ keys: [{ ...issuer.publicJwk, pad: "x".repeat(JWKS_MAX_BYTES) }] });
    const cases = [
      () => jwksResponse(big),
      () => jwksResponse(issuer.jwks, { headers: { "content-length": String(JWKS_MAX_BYTES + 1) } }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/jwks" } }),
      () => jwksResponse(issuer.jwks, { status: 503 }),
      () => jwksResponse("not json"),
      () => jwksResponse({ keys: "nope" }),
      () => jwksResponse({ keys: [{ ...issuer.publicJwk, d: "AAAA" }] }),
    ];
    for (const responder of cases) {
      const cache = new JwksCache({ url: URL, fetch: fakeJwksOrigin(responder).fetch, now });
      await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
    }
    // A fetch that honours the abort signal times out at 5 s.
    const hanging = fakeJwksOrigin(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    const cache = new JwksCache({ url: URL, fetch: hanging.fetch, now, timeoutMs: 20 });
    await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
  });

  test("an empty key set, or an entry without kid or kty, is an invalid fetch", async () => {
    clock = 1_000_000;
    for (const document of [
      { keys: [] },
      { keys: [{ ...issuer.publicJwk, kid: undefined }] },
      { keys: [{ ...issuer.publicJwk, kid: "" }] },
      { keys: [{ ...issuer.publicJwk, kty: undefined }] },
      { keys: [issuer.publicJwk, {}] },
    ]) {
      const cache = new JwksCache({ url: URL, fetch: fakeJwksOrigin(() => jwksResponse(document)).fetch, now });
      await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
      expect(cache.snapshot()).toEqual({ fetchedAt: null, hasKeys: false });
    }
  });

  test("a good set followed by {keys: []} keeps serving the good set inside the stale window and never persists the empty set", async () => {
    clock = 1_000_000;
    const persistPath = join(mkdtempSync(join(tmpdir(), "ravi-jwks-")), "grant-jwks.json");
    const origin = fakeJwksOrigin(serving(issuer));
    const cache = new JwksCache({ url: URL, fetch: origin.fetch, now, persistPath });
    await resolve(cache);
    origin.respond(() => jwksResponse({ keys: [] }));
    tick(301_000); // refresh due: the empty document is a failed refresh
    await expect(resolve(cache)).resolves.toBeDefined();
    expect(origin.calls).toHaveLength(2);
    expect(cache.snapshot()).toEqual({ fetchedAt: 1_000_000, hasKeys: true });
    expect(
      await verifySandboxGrant(token, {
        jwks: cache,
        consoleIssuer: TEST_CONSOLE_ISSUER,
        installationId: TEST_INSTALLATION_A,
        now: TEST_NOW,
      }),
    ).toMatchObject({ ok: true });
    // Counted as a failed refresh: one retry per 30 s, and the stale window still ends at 3600 s.
    tick(10_000);
    await resolve(cache);
    expect(origin.calls).toHaveLength(2);
    tick(20_000);
    await resolve(cache);
    expect(origin.calls).toHaveLength(3);
    clock = 1_000_000 + 3_601_000;
    await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
    // The file still holds the good set from the first fetch.
    const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as { fetchedAt: number; keys: unknown[] };
    expect(persisted).toEqual({ fetchedAt: 1_000_000, keys: issuer.jwks.keys });
  });

  describe("persisted cache", () => {
    const dir = () => mkdtempSync(join(tmpdir(), "ravi-jwks-"));

    test("is written 0600 with fetchedAt, and a restart during an outage verifies inside the stale window", async () => {
      clock = 1_000_000;
      const persistPath = join(dir(), "grant-jwks.json");
      const origin = fakeJwksOrigin(serving(issuer));
      await resolve(new JwksCache({ url: URL, fetch: origin.fetch, now, persistPath }));
      expect(statSync(persistPath).mode & 0o777).toBe(0o600);
      const persisted = JSON.parse(readFileSync(persistPath, "utf8")) as { fetchedAt: number; keys: unknown[] };
      expect(persisted.fetchedAt).toBe(1_000_000);
      expect(persisted.keys).toHaveLength(1);

      tick(1_800_000);
      const down = fakeJwksOrigin(failingResponder);
      const restarted = new JwksCache({ url: URL, fetch: down.fetch, now, persistPath });
      expect(restarted.snapshot()).toEqual({ fetchedAt: 1_000_000, hasKeys: true });
      await expect(resolve(restarted)).resolves.toBeDefined();
      expect(down.calls).toHaveLength(1);
      expect(
        await verifySandboxGrant(token, {
          jwks: restarted,
          consoleIssuer: TEST_CONSOLE_ISSUER,
          installationId: TEST_INSTALLATION_A,
          now: TEST_NOW,
        }),
      ).toMatchObject({ ok: true });
    });

    test("honours fetchedAt: a persisted set older than 3600 s is a cold start", async () => {
      clock = 10_000_000;
      const persistPath = join(dir(), "grant-jwks.json");
      writeFileSync(persistPath, JSON.stringify({ fetchedAt: clock - 3_601_000, keys: issuer.jwks.keys }), {
        mode: 0o600,
      });
      const cache = new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath });
      await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
      // A fetchedAt in the future, or missing, is ignored too.
      writeFileSync(persistPath, JSON.stringify({ fetchedAt: clock + 1, keys: issuer.jwks.keys }), { mode: 0o600 });
      await expect(
        resolve(new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath })),
      ).rejects.toBeInstanceOf(JwksUnavailableError);
      writeFileSync(persistPath, JSON.stringify({ keys: issuer.jwks.keys }), { mode: 0o600 });
      await expect(
        resolve(new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath })),
      ).rejects.toBeInstanceOf(JwksUnavailableError);
    });

    test("ignores a cache file that is not 0600 or carries private material", async () => {
      clock = 10_000_000;
      const persistPath = join(dir(), "grant-jwks.json");
      writeFileSync(persistPath, JSON.stringify({ fetchedAt: clock - 1000, keys: issuer.jwks.keys }), { mode: 0o600 });
      chmodSync(persistPath, 0o644);
      await expect(
        resolve(new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath })),
      ).rejects.toBeInstanceOf(JwksUnavailableError);
      chmodSync(persistPath, 0o600);
      await expect(
        resolve(new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath })),
      ).resolves.toBeDefined();
      writeFileSync(
        persistPath,
        JSON.stringify({ fetchedAt: clock - 1000, keys: [{ ...issuer.publicJwk, d: "AAAA" }] }),
        { mode: 0o600 },
      );
      await expect(
        resolve(new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath })),
      ).rejects.toBeInstanceOf(JwksUnavailableError);
    });

    test("ignores a symlink to a 0600 file: the path is opened O_NOFOLLOW and checked through fstat", async () => {
      clock = 10_000_000;
      const base = dir();
      const target = join(base, "elsewhere.json");
      const persistPath = join(base, "grant-jwks.json");
      writeFileSync(target, JSON.stringify({ fetchedAt: clock - 1000, keys: issuer.jwks.keys }), { mode: 0o600 });
      symlinkSync(target, persistPath);
      const cache = new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath });
      expect(cache.snapshot()).toEqual({ fetchedAt: null, hasKeys: false });
      await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
      // A write through the symlinked path is refused too: the target stays untouched and no temp file is left.
      const origin = fakeJwksOrigin(serving(issuer));
      await resolve(new JwksCache({ url: URL, fetch: origin.fetch, now, persistPath }));
      expect(JSON.parse(readFileSync(target, "utf8")).fetchedAt).toBe(clock - 1000);
      expect(readdirSync(base).sort()).toEqual(["elsewhere.json", "grant-jwks.json"]);
    });

    test("ignores an oversized file by its size, before reading it", async () => {
      clock = 10_000_000;
      const persistPath = join(dir(), "grant-jwks.json");
      // Valid JSON and a valid key set, padded past 64 KiB: only the size check can refuse it.
      const padded = { fetchedAt: clock - 1000, keys: issuer.jwks.keys, pad: "x".repeat(JWKS_MAX_BYTES) };
      writeFileSync(persistPath, JSON.stringify(padded), { mode: 0o600 });
      expect(statSync(persistPath).size).toBeGreaterThan(JWKS_MAX_BYTES);
      const cache = new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath });
      expect(cache.snapshot()).toEqual({ fetchedAt: null, hasKeys: false });
      await expect(resolve(cache)).rejects.toBeInstanceOf(JwksUnavailableError);
      // A larger limit admits the same file, so it was the size that refused it.
      const roomy = new JwksCache({
        url: URL,
        fetch: fakeJwksOrigin(failingResponder).fetch,
        now,
        persistPath,
        maxBytes: JWKS_MAX_BYTES * 2,
      });
      expect(roomy.snapshot()).toEqual({ fetchedAt: clock - 1000, hasKeys: true });
    });

    test("a persisted document with no keys, or a key without kid, is a cold start", async () => {
      clock = 10_000_000;
      const persistPath = join(dir(), "grant-jwks.json");
      writeFileSync(persistPath, JSON.stringify({ fetchedAt: clock - 1000, keys: [] }), { mode: 0o600 });
      await expect(
        resolve(new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath })),
      ).rejects.toBeInstanceOf(JwksUnavailableError);
      writeFileSync(
        persistPath,
        JSON.stringify({ fetchedAt: clock - 1000, keys: [{ ...issuer.publicJwk, kid: undefined }] }),
        { mode: 0o600 },
      );
      await expect(
        resolve(new JwksCache({ url: URL, fetch: fakeJwksOrigin(failingResponder).fetch, now, persistPath })),
      ).rejects.toBeInstanceOf(JwksUnavailableError);
    });
  });
});
