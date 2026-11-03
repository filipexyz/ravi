import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { consoleBrowserOrigin, consoleRedirectUrl, isConsoleMutationOrigin } from "./console-origin";
import { getOidcOrigin } from "./oidc-config";
import { POST as selectOrganization } from "@/app/api/console/organizations/select/route";
import { POST as rememberOrganization } from "@/app/api/console/organizations/remember/route";
import { POST as approveDevice } from "@/app/api/console/cli/auth/approve/route";

const origin = "https://console.nba-console.localhost";
const internal = "https://0.0.0.0:3000/projects";
const originalMode = process.env.RAVI_AUTH_MODE;
const originalOrigin = process.env.NEXT_PUBLIC_CONSOLE_URL;

afterEach(() => {
  if (originalMode === undefined) delete process.env.RAVI_AUTH_MODE;
  else process.env.RAVI_AUTH_MODE = originalMode;
  if (originalOrigin === undefined) delete process.env.NEXT_PUBLIC_CONSOLE_URL;
  else process.env.NEXT_PUBLIC_CONSOLE_URL = originalOrigin;
});

function oidc() {
  process.env.RAVI_AUTH_MODE = "oidc";
  process.env.NEXT_PUBLIC_CONSOLE_URL = origin;
}

function request(requestOrigin?: string) {
  const headers = new Headers({
    host: "attacker.invalid",
    "x-forwarded-host": "attacker.invalid",
    "x-forwarded-proto": "http",
    forwarded: "proto=http;host=attacker.invalid",
  });
  if (requestOrigin !== undefined) headers.set("origin", requestOrigin);
  return new NextRequest(internal, { method: "POST", headers });
}

describe("canonical Console origin behind the proxy", () => {
  test("OIDC uses installation config, never transport or forwarded headers", () => {
    oidc();
    expect(consoleBrowserOrigin(request(origin).url)).toBe(origin);
    expect(consoleRedirectUrl("/console-staging", request(origin).url).href).toBe(`${origin}/console-staging`);
    expect(consoleRedirectUrl("/login?returnTo=%2Fprojects", internal).href).toBe(`${origin}/login?returnTo=%2Fprojects`);
  });

  test("only local redirect paths are accepted", () => {
    oidc();
    for (const path of ["https://attacker.invalid", "//attacker.invalid", "/\\attacker.invalid", "/ok\n//attacker.invalid", "not-a-path"]) {
      expect(() => consoleRedirectUrl(path, internal)).toThrow();
    }
  });

  test("only the exact configured Origin authorizes OIDC browser mutations", () => {
    oidc();
    expect(isConsoleMutationOrigin(request(origin))).toBe(true);
    for (const rejected of [undefined, "null", "https://0.0.0.0:3000", "https://attacker.invalid", "https://page-a.nba-console.localhost", `${origin}/path`, `${origin}/`]) {
      expect(isConsoleMutationOrigin(request(rejected))).toBe(false);
    }
  });

  test("missing or invalid configured origin fails closed without transport fallback", () => {
    oidc();
    for (const invalid of ["", "http://console.nba-console.localhost", `${origin}/path`, "https://user@console.nba-console.localhost", `${origin}?x=1`]) {
      process.env.NEXT_PUBLIC_CONSOLE_URL = invalid;
      expect(() => consoleBrowserOrigin(internal)).toThrow();
    }
  });

  test("canonical origin is available for config errors without auth secrets", () => {
    expect(getOidcOrigin({ NEXT_PUBLIC_CONSOLE_URL: origin })).toBe(origin);
  });

  test("hosted mode preserves its existing origin and absent-Origin handling", () => {
    process.env.RAVI_AUTH_MODE = "workos";
    process.env.NEXT_PUBLIC_CONSOLE_URL = origin;
    expect(consoleBrowserOrigin(internal)).toBe("https://0.0.0.0:3000");
    expect(isConsoleMutationOrigin(request())).toBe(true);
    expect(isConsoleMutationOrigin(request("https://0.0.0.0:3000"))).toBe(true);
    expect(isConsoleMutationOrigin(request("https://attacker.invalid"))).toBe(false);
  });

  test("organization and CLI approval endpoints reject spoofing before auth or mutation", async () => {
    oidc();
    for (const handler of [selectOrganization, rememberOrganization, approveDevice]) {
      for (const rejected of [undefined, "https://0.0.0.0:3000", "https://attacker.invalid"]) {
        const response = await handler(request(rejected));
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "forbidden" });
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(response.headers.has("location")).toBe(false);
      }
    }
  });
});
