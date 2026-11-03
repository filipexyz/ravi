import { describe, expect, test } from "bun:test";

import { getManagedMailDomains, resolveManagedMailDomain } from "./managed-domains";

describe("Ravi Mail managed domains", () => {
  test("allows ravi.bot by default and normalizes input", () => {
    expect(resolveManagedMailDomain("RAVI.BOT.")).toBe("ravi.bot");
    expect(getManagedMailDomains(new Proxy({}, { get: () => undefined }) as NodeJS.ProcessEnv).has("ravi.bot")).toBe(true);
  });

  test("rejects unmanaged domains until domain verification exists", () => {
    expect(() => resolveManagedMailDomain("gmail.com")).toThrow();
    expect(() => resolveManagedMailDomain("ravi.so")).toThrow();
  });

  test("supports explicit managed domain allowlist from env", () => {
    const env = { RAVI_MAIL_MANAGED_DOMAINS: "mail.ravi.bot, example.test." };
    expect([...getManagedMailDomains(env)]).toEqual(["mail.ravi.bot", "example.test"]);
  });
});
