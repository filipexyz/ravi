import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { boundedJson, EXECUTOR_BODY_LIMIT, hash, pageOperationSchema, signDelegation, stableJson, verifyDelegation, verifyExecutorProof } from "./protocol";
import { SAFE_REPLAY_WINDOW_MS, validateOperationReplay } from "./replay-policy";

const consoleOrigin = "https://console.test";
const executorOrigin = "https://executor.test";
const keypair = () => generateKeyPairSync("ec", { namedCurve: "P-256", privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const consoleKey = keypair(); const executorKey = keypair();
const settings = { NEXT_PUBLIC_CONSOLE_URL: consoleOrigin, RAVI_EXECUTOR_URL: executorOrigin,
  RAVI_EXECUTOR_PRIVATE_KEY_PEM: consoleKey.privateKey, RAVI_EXECUTOR_PUBLIC_KEY_PEM: executorKey.publicKey };
const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
beforeAll(() => Object.assign(process.env, settings));
afterAll(() => { for (const key of Object.keys(settings)) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
const operation = { host: "site.pages.test", id: "ravi.bases.views.rows.create", input: { viewId: randomUUID(), values: { title: "synthetic" }, idempotencyKey: "replay-test-1" }, origin: "https://site.pages.test", pagesSession: "synthetic-page-session", requestId: "test-request" };
const scope = { actorId: randomUUID(), organizationId: randomUUID(), projectId: randomUUID(), siteId: randomUUID(), releaseId: randomUUID() };

describe("delegation cryptographic boundary", () => {
  test("accepts its own exact operation; stable object ordering", async () => {
    const token = await signDelegation(operation, scope);
    expect(await verifyDelegation(token, operation)).toEqual(scope);
    expect(stableJson({ b: 1, a: { z: 2, y: 3 } })).toBe(stableJson({ a: { y: 3, z: 2 }, b: 1 }));
  });
  for (const [field, value] of Object.entries({ host: "evil.pages.test", id: "ravi.admin.write", origin: "https://evil.pages.test", pagesSession: "other-session", input: { confirmed: true }, requestId: "changed" })) {
    test(`rejects changed ${field}`, async () => {
      const token = await signDelegation(operation, scope);
      await expect(verifyDelegation(token, { ...operation, [field]: value })).rejects.toThrow();
    });
  }
  test("rejects forged unsigned delegation and client authority extras", async () => {
    await expect(verifyDelegation("e30.e30.fake", operation)).rejects.toThrow();
    expect(pageOperationSchema.safeParse({ ...operation, executorCallback: true }).success).toBe(false);
  });
  test("independent executor callback verifies issuer, audience, kind, lifetime and signature", async () => {
    const now = Math.floor(Date.now() / 1000);
    const make = (overrides: Record<string, unknown> = {}, wrongKey = false) => new SignJWT({ kind: "operation-callback", delegationHash: hash("delegation"), iss: executorOrigin, aud: consoleOrigin, iat: now, exp: now + 60, jti: randomUUID(), ...overrides })
      .setProtectedHeader({ alg: "ES256", typ: "executor-callback+jwt" }).sign(imported(wrongKey));
    const keys = await Promise.all([importPKCS8(executorKey.privateKey, "ES256"), importPKCS8(consoleKey.privateKey, "ES256")]);
    function imported(wrongKey: boolean) { return keys[wrongKey ? 1 : 0]!; }
    expect((await verifyExecutorProof(await make(), "operation-callback")).kind).toBe("operation-callback");
    for (const override of [{ iss: consoleOrigin }, { aud: executorOrigin }, { kind: "identity-resolve" }, { iat: now - 120, exp: now - 60 }, { iat: now + 30, exp: now + 90 }, { exp: now + 600 }]) {
      await expect(verifyExecutorProof(await make(override), "operation-callback")).rejects.toThrow();
    }
    await expect(verifyExecutorProof(await make({}, true), "operation-callback")).rejects.toThrow();
  });
  test("bounds malformed and oversized bodies", async () => {
    await expect(boundedJson(new Request("https://console.test", { method: "POST", body: "invalid" }))).rejects.toThrow();
    await expect(boundedJson(new Request("https://console.test", { method: "POST", body: "x".repeat(EXECUTOR_BODY_LIMIT + 1) }))).rejects.toThrow();
  });
});

describe("durable replay policy (pure; DB restart covered in staging)", () => {
  const now = Date.now(); const record = { id: "record", requestHash: "request", sessionHash: "session", createdAt: new Date(now) };
  test("same key/input/session remains retryable before the backing expiration", () => {
    expect(() => validateOperationReplay(record, "request", "session", now + 60_000)).not.toThrow();
  });
  test("changed input or fresh session conflicts", () => {
    expect(() => validateOperationReplay(record, "different", "session", now)).toThrow();
    expect(() => validateOperationReplay(record, "request", "fresh-session", now)).toThrow();
  });
  test("tombstone refuses replay before underlying 24-hour guarantee expires", () => {
    expect(() => validateOperationReplay(record, "request", "session", now + SAFE_REPLAY_WINDOW_MS)).toThrow();
  });
});
