import { describe, expect, test } from "bun:test";

import { HmacAuthError, signHmacRequest, verifyHmacRequest, type HmacKeyMaterial } from "./hmac";

const CURRENT_KEY = "current-key-secret-32-bytes-long";
const PREVIOUS_KEY = "previous-key-secret-32-bytes-lng";

const KEYS: HmacKeyMaterial = {
  currentId: "k_current",
  currentKey: CURRENT_KEY,
  previousId: "k_previous",
  previousKey: PREVIOUS_KEY,
};

async function buildSignedRequest(input: {
  method: string;
  path: string;
  body: string;
  key: string;
  keyId: string;
  now?: Date;
}): Promise<Request> {
  const headers = await signHmacRequest({
    method: input.method,
    path: input.path,
    bodyText: input.body,
    key: input.key,
    keyId: input.keyId,
    now: input.now,
  });
  return new Request(`https://link.ravi.so${input.path}`, {
    method: input.method,
    body: input.body,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("HMAC server-to-server validator", () => {
  test("accepts a freshly signed request with the current key", async () => {
    const req = await buildSignedRequest({
      method: "POST",
      path: "/ui/connect/start",
      body: JSON.stringify({ provider: "google" }),
      key: CURRENT_KEY,
      keyId: "k_current",
    });

    await expect(
      verifyHmacRequest({
        request: req,
        bodyText: JSON.stringify({ provider: "google" }),
        keys: KEYS,
      }),
    ).resolves.toBeUndefined();
  });

  test("accepts the previous key during the overlap window", async () => {
    const req = await buildSignedRequest({
      method: "POST",
      path: "/ui/connect/start",
      body: "",
      key: PREVIOUS_KEY,
      keyId: "k_previous",
    });
    await verifyHmacRequest({ request: req, bodyText: "", keys: KEYS });
  });

  test("rejects unknown key id", async () => {
    const req = await buildSignedRequest({
      method: "POST",
      path: "/ui/connect/start",
      body: "",
      key: "rogue",
      keyId: "k_rogue",
    });
    await expect(
      verifyHmacRequest({ request: req, bodyText: "", keys: KEYS }),
    ).rejects.toMatchObject({ reason: "unknown_key_id" });
  });

  test("rejects when signature does not match body", async () => {
    const req = await buildSignedRequest({
      method: "POST",
      path: "/ui/connect/start",
      body: JSON.stringify({ provider: "google" }),
      key: CURRENT_KEY,
      keyId: "k_current",
    });
    await expect(
      verifyHmacRequest({
        request: req,
        bodyText: JSON.stringify({ provider: "slack" }),
        keys: KEYS,
      }),
    ).rejects.toMatchObject({ reason: "signature_mismatch" });
  });

  test("rejects stale timestamps beyond the 300s window", async () => {
    const stale = new Date(Date.now() - 600 * 1000);
    const req = await buildSignedRequest({
      method: "POST",
      path: "/ui/connect/start",
      body: "",
      key: CURRENT_KEY,
      keyId: "k_current",
      now: stale,
    });
    await expect(
      verifyHmacRequest({ request: req, bodyText: "", keys: KEYS }),
    ).rejects.toMatchObject({ reason: "stale_timestamp" });
  });

  test("rejects when required headers are missing", async () => {
    const req = new Request("https://link.ravi.so/ui/connect/start", {
      method: "POST",
      body: "",
    });
    await expect(
      verifyHmacRequest({ request: req, bodyText: "", keys: KEYS }),
    ).rejects.toBeInstanceOf(HmacAuthError);
  });

  test("path tampering invalidates the signature", async () => {
    const headers = await signHmacRequest({
      method: "POST",
      path: "/ui/connect/start",
      bodyText: "",
      key: CURRENT_KEY,
      keyId: "k_current",
    });
    const req = new Request("https://link.ravi.so/ui/connect/revoke/abc", {
      method: "POST",
      headers,
      body: "",
    });
    await expect(
      verifyHmacRequest({ request: req, bodyText: "", keys: KEYS }),
    ).rejects.toMatchObject({ reason: "signature_mismatch" });
  });
});
