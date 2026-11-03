import { afterEach, expect, test } from "bun:test";
import { hostedPagesDomain } from "./hosted-domain";

const original = process.env.RAVI_PAGES_HOSTED_DOMAIN;
afterEach(() => {
  if (original === undefined) delete process.env.RAVI_PAGES_HOSTED_DOMAIN;
  else process.env.RAVI_PAGES_HOSTED_DOMAIN = original;
});

test("defaults to hosted product domain; installation domain is normalized", () => {
  delete process.env.RAVI_PAGES_HOSTED_DOMAIN;
  expect(hostedPagesDomain()).toBe("ravi.page");
  process.env.RAVI_PAGES_HOSTED_DOMAIN = "PAGES.nba-console.localhost";
  expect(hostedPagesDomain()).toBe("pages.nba-console.localhost");
});

test("domain configuration rejects URL, wildcard, port and delimiter injection", () => {
  for (const value of ["", "https://pages.local", "*.pages.local", "pages.local:8443", "pages.local/path", "pages.local\nother", "pages..local"]) {
    process.env.RAVI_PAGES_HOSTED_DOMAIN = value;
    expect(hostedPagesDomain).toThrow();
  }
});
