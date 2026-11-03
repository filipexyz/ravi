import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { createLocalJWKSet, jwtVerify } from "jose";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  resetViewerAssertionKeyCache,
  signViewerAssertion,
  VIEWER_ASSERTION_TTL_SECONDS,
  viewerAssertionJwks,
} from "./jwt";

describe("Pages viewer assertion JWT", () => {
  test("signs ES256 claims for 60 seconds and publishes only the public JWK", async () => {
    const { env } = es256Env("pages-viewer-assertion-1");
    const now = new Date("2026-09-29T00:00:00.000Z");
    const signed = await signViewerAssertion({
      audience: "https://api.customer.example",
      env,
      now,
      projectId: "proj_1",
      raviOrgId: "org_site",
      raviUserId: "user_1",
      siteId: "site_1",
    });

    const jwks = await viewerAssertionJwks(env);
    expect(jwks.keys).toEqual([expect.objectContaining({ alg: "ES256", kid: "pages-viewer-assertion-1", use: "sig", crv: "P-256" })]);
    expect(jwks.keys[0]).not.toHaveProperty("d");
    expect(JSON.stringify(jwks)).not.toContain("BEGIN PRIVATE KEY");

    const verified = await jwtVerify(signed.token, createLocalJWKSet(jwks), {
      algorithms: ["ES256"],
      audience: "https://api.customer.example",
      currentDate: now,
      issuer: "https://console.ravi.bot",
    });
    expect(verified.protectedHeader.alg).toBe("ES256");
    expect(verified.payload).toMatchObject({
      actor: "human_viewer",
      aud: "https://api.customer.example",
      iss: "https://console.ravi.bot",
      project: "proj_1",
      raviOrgId: "org_site",
      raviUserId: "user_1",
      site: "site_1",
      sub: "user_1",
    });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(VIEWER_ASSERTION_TTL_SECONDS);
    expect(verified.payload).not.toHaveProperty("consoleUserId");
    expect(verified.payload).not.toHaveProperty("consoleOrgId");
    expect(signed.expiresAt - Math.floor(now.getTime() / 1000)).toBe(60);
  });

  test("does not sign with the CLI HMAC secret or the Pages session secret", async () => {
    resetViewerAssertionKeyCache();
    await expect(
      signViewerAssertion({
        audience: "https://api.customer.example",
        env: {
          RAVI_CLI_ACCESS_TOKEN_SECRET: "cli-secret-cli-secret-cli-secret-12",
          RAVI_PAGES_AUTH_SESSION_SECRET: "pages-secret-pages-secret-pages-12",
        } as unknown as NodeJS.ProcessEnv,
        projectId: "proj_1",
        raviOrgId: "org_site",
        raviUserId: "user_1",
        siteId: "site_1",
      }),
    ).rejects.toMatchObject({ payload: { error: "viewer_assertion_unavailable" } });
  });

  test("rejects a non-ES256 key family", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    await expect(
      viewerAssertionJwks({
        RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON: JSON.stringify([
          { alg: "RS256", kid: "pages-viewer-assertion-rsa", pkcs8Pem: pem, status: "active" },
        ]),
      } as unknown as NodeJS.ProcessEnv),
    ).rejects.toBeInstanceOf(ConsoleApiError);
  });
});

function es256Env(kid: string) {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return {
    env: {
      RAVI_PAGES_VIEWER_ASSERTION_ISSUER: "https://console.ravi.bot",
      RAVI_PAGES_VIEWER_ASSERTION_KEYS_JSON: JSON.stringify([
        { alg: "ES256", kid, pkcs8Pem: pem, status: "active" },
      ]),
    } as unknown as NodeJS.ProcessEnv,
  };
}
