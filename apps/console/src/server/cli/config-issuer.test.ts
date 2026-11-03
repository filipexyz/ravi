import { describe, expect, test } from "bun:test";
import { jwtVerify, SignJWT } from "jose";

describe("WorkOS issuer compatibility", () => {
  test("documents why CLI exchange must not require an aud claim", async () => {
    const secret = new TextEncoder().encode("test-secret");
    const token = await new SignJWT({ org_id: "org_123", role: "developer" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://api.workos.com")
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);

    await expect(
      jwtVerify(token, secret, {
        issuer: ["https://api.workos.com", "https://api.workos.com/"],
      }),
    ).resolves.toBeDefined();
  });

  test("accepts WorkOS User Management access token issuer variants", async () => {
    const secret = new TextEncoder().encode("test-secret");
    const token = await new SignJWT({ email: "dev@ravi.bot" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://api.workos.com/user_management/client_123")
      .setSubject("user_123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);

    await expect(
      jwtVerify(token, secret, {
        issuer: [
          "https://api.workos.com/user_management/client_123",
          "https://api.workos.com/user_management/client_123/",
        ],
      }),
    ).resolves.toBeDefined();
  });
});
