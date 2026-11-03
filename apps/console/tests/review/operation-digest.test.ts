import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { operationDigest, matchesOperationDigest } from "../../src/server/console/fleet/operation-digest";
import { assertSshPort, sshPortPolicy } from "../../src/server/console/fleet/ssh-policy";
import { getOidcBaseConfig } from "../../src/lib/auth/oidc-config";
import { assertFleetActor } from "../../src/server/console/fleet/contract";

test("HKDF domain separation and read-only legacy receipt transition", () => {
  const secret = "synthetic-secret-not-used-for-authentication", payload = '{"operation":"fixture"}';
  const old = createHmac("sha256", secret).update(payload).digest("hex");
  const current = operationDigest(secret, "fleet", payload);
  expect(current).toMatch(/^v2:[a-f0-9]{64}$/);
  expect(current.slice(3)).not.toBe(old);
  expect(current).not.toBe(operationDigest(secret, "fleet-sso", payload));
  expect(matchesOperationDigest(old, secret, "fleet", payload)).toBe(true);
  expect(matchesOperationDigest(current, secret, "fleet", payload)).toBe(true);
  for (const stored of [old, current]) expect(matchesOperationDigest(stored, secret, "fleet", payload + " ")).toBe(false);
  expect(matchesOperationDigest(current, secret, "fleet-sso", payload)).toBe(false);
  expect(matchesOperationDigest("v3:" + old, secret, "fleet", payload)).toBe(false);
});
test("single trusted org source rejects malformed config and divergent actor", () => {
  const env = { NEXT_PUBLIC_CONSOLE_URL: "https://console.example.invalid", RAVI_AUTH_SECRET: "synthetic-long-enough-auth-secret", RAVI_SINGLE_TENANT_ORGANIZATION_ID: crypto.randomUUID() };
  const config = getOidcBaseConfig(env);
  expect(config.organizationId).toBe(env.RAVI_SINGLE_TENANT_ORGANIZATION_ID);
  expect(() => getOidcBaseConfig({ ...env, RAVI_SINGLE_TENANT_ORGANIZATION_ID: "wrong" })).toThrow();
  expect(() => assertFleetActor({ mode: "oidc", role: "owner", userId: crypto.randomUUID(), organizationId: crypto.randomUUID() }, config.organizationId)).toThrow("forbidden");
});
test("SSH ports default22, explicit bounded list only, no default broad range", () => {
  expect(sshPortPolicy({})).toEqual([22]);
  expect(() => assertSshPort(2222)).toThrow("ssh_port_not_allowed");
  expect(() => assertSshPort(2222, sshPortPolicy({ RAVI_FLEET_SSH_ALLOWED_PORTS: "22,2222" }))).not.toThrow();
  for (const value of ["", "0", "65536", "22,22", "22-65535", "22, 23", "*", "NaN"]) {
    expect(() => sshPortPolicy({ RAVI_FLEET_SSH_ALLOWED_PORTS: value })).toThrow("ssh_port_policy_invalid");
  }
});
