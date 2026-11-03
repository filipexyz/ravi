import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";

import { resetViewerAssertionKeyCache } from "@/server/console/pages/viewer-assertions/jwt";
import { GET } from "./route";

describe("viewer assertion JWKS route", () => {
  test("fails closed when the assertion key family is not configured", async () => {
    const previous = process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
    delete process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
    resetViewerAssertionKeyCache();
    try {
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "viewer_assertion_unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      if (previous === undefined) delete process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
      else process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON = previous;
      resetViewerAssertionKeyCache();
    }
  });

  test("publishes the ES256 public key without private material", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const previous = process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
    process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON = JSON.stringify([
      { alg: "ES256", kid: "pages-viewer-assertion-1", pkcs8Pem: pem, status: "active" },
    ]);
    resetViewerAssertionKeyCache();
    try {
      const response = await GET();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
      const body = await response.json();
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0]).toMatchObject({ alg: "ES256", kid: "pages-viewer-assertion-1", use: "sig", crv: "P-256" });
      expect(body.keys[0]).not.toHaveProperty("d");
      expect(JSON.stringify(body)).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      if (previous === undefined) delete process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON;
      else process.env.RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON = previous;
      resetViewerAssertionKeyCache();
    }
  });
});
