import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { isTrustedConsolePost } from "./ravi-link-web";

const APPROVE_URL = "https://console.example/api/console/link/approve";

function post(headers: Record<string, string>) {
  return new NextRequest(APPROVE_URL, { method: "POST", headers });
}

describe("isTrustedConsolePost", () => {
  test("accepts a same-origin form post whose Origin is null under a strict referrer policy", () => {
    expect(isTrustedConsolePost(post({ "sec-fetch-site": "same-origin", origin: "null" }))).toBeTrue();
    expect(isTrustedConsolePost(post({ "sec-fetch-site": "same-origin" }))).toBeTrue();
  });

  test("refuses cross-site and same-site posts whatever Origin says", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      expect(isTrustedConsolePost(post({ "sec-fetch-site": site, origin: "https://console.example" }))).toBeFalse();
    }
  });

  test("falls back to the Origin header when the browser sends no Sec-Fetch-Site", () => {
    expect(isTrustedConsolePost(post({ origin: "https://console.example" }))).toBeTrue();
    expect(isTrustedConsolePost(post({ origin: "https://evil.example" }))).toBeFalse();
    expect(isTrustedConsolePost(post({ origin: "null" }))).toBeFalse();
    expect(isTrustedConsolePost(post({}))).toBeFalse();
  });
});
