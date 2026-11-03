import { afterEach, describe, expect, test } from "bun:test";

import { getCliAuthPublicConfig, getCliWorkosValidationConfig } from "./config";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("CLI auth config", () => {
  test("uses Console-owned device authorization when requested by a capable CLI", () => {
    process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = "test-cli-access-token-secret-32-bytes-minimum";
    delete process.env.WORKOS_CLI_AUTH_MODE;
    delete process.env.WORKOS_CLIENT_ID;
    delete process.env.WORKOS_CLI_AUTH_CLIENT_ID;
    delete process.env.WORKOS_CLI_AUTH_ISSUER;
    delete process.env.WORKOS_CLI_AUTH_JWKS_URL;

    const publicConfig = getCliAuthPublicConfig("https://console.ravi.bot/api/cli/auth/config", {
      flow: "console_device",
    });
    const validationConfig = getCliWorkosValidationConfig();

    expect(publicConfig).toMatchObject({
      configured: true,
      clientId: "ravi-cli",
      issuer: "https://console.ravi.bot",
      mode: "console_device",
      provider: "ravi-console",
      endpoints: {
        deviceAuthorization: "https://console.ravi.bot/api/cli/auth/device",
        token: null,
      },
    });
    expect(validationConfig).toBeNull();
  });

  test("keeps WorkOS AuthKit device auth as the legacy default for older CLIs", () => {
    delete process.env.WORKOS_CLI_AUTH_MODE;
    process.env.WORKOS_CLIENT_ID = "client_authkit";
    process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = "test-cli-access-token-secret-32-bytes-minimum";
    delete process.env.WORKOS_CLI_AUTH_CLIENT_ID;
    delete process.env.WORKOS_CLI_AUTH_ISSUER;
    delete process.env.WORKOS_CLI_AUTH_JWKS_URL;

    const publicConfig = getCliAuthPublicConfig("https://console.ravi.bot/api/cli/auth/config");
    const validationConfig = getCliWorkosValidationConfig();

    expect(publicConfig).toMatchObject({
      configured: true,
      clientId: "client_authkit",
      issuer: "https://api.workos.com",
    });
    expect(validationConfig).toMatchObject({
      clientId: "client_authkit",
      issuer: [
        "https://api.workos.com",
        "https://api.workos.com/user_management/client_authkit",
      ],
      jwksUrl: "https://api.workos.com/sso/jwks/client_authkit",
    });
  });

  test("allows a custom AuthKit issuer while keeping WorkOS JWKS by default", () => {
    process.env.WORKOS_CLI_AUTH_MODE = "authkit_device";
    process.env.WORKOS_CLIENT_ID = "client_authkit";
    process.env.WORKOS_CLI_AUTH_ISSUER = "https://inspired-tea-83.authkit.app";
    process.env.RAVI_CLI_ACCESS_TOKEN_SECRET = "test-cli-access-token-secret-32-bytes-minimum";
    delete process.env.WORKOS_CLI_AUTH_JWKS_URL;

    expect(getCliWorkosValidationConfig()).toMatchObject({
      clientId: "client_authkit",
      issuer: [
        "https://inspired-tea-83.authkit.app",
        "https://api.workos.com",
        "https://api.workos.com/user_management/client_authkit",
      ],
      jwksUrl: "https://api.workos.com/sso/jwks/client_authkit",
    });
  });
});
