import { describe, expect, test } from "bun:test";

import {
  applyOrgSlugSuffix,
  parseInboundMailAddress,
  parseSubaddress,
  publicMailAddressError,
  validateMailboxAddress,
  validateMailboxLocalPart,
} from "./addressing";

describe("Ravi Mail addressing policy", () => {
  test("normalizes explicit mailbox addresses", () => {
    expect(validateMailboxAddress("  Luis.Dev@RAVI.SO ")).toEqual({
      ok: true,
      address: "luis.dev@ravi.so",
      localPart: "luis.dev",
      domain: "ravi.so",
    });
  });

  test("keeps public address errors coarse while retaining internal reasons", () => {
    expect(validateMailboxAddress("admin@ravi.so")).toMatchObject({
      ok: false,
      reason: "reserved_local_part",
      publicError: "mail_address_unavailable",
    });
    expect(validateMailboxAddress("bad space@ravi.so")).toMatchObject({
      ok: false,
      reason: "invalid_local_part",
      publicError: "mail_address_unavailable",
    });
    expect(validateMailboxAddress("luis@localhost")).toMatchObject({
      ok: false,
      reason: "invalid_domain",
      publicError: "mail_address_unavailable",
    });
    expect(publicMailAddressError()).toEqual({
      error: "mail_address_unavailable",
      fieldErrors: {
        address: "This email address is unavailable.",
      },
    });
  });

  test("does not allow plus tags in mailbox creation local parts", () => {
    expect(validateMailboxLocalPart("agent+sales")).toMatchObject({
      ok: false,
      reason: "invalid_local_part",
    });
  });

  test("accepts inbound subaddressing and exposes the routable base", () => {
    expect(parseSubaddress("agent+lead-42")).toEqual({
      hasTag: true,
      baseLocalPart: "agent",
      tag: "lead-42",
    });
    expect(parseInboundMailAddress("agent+lead-42@ravi.so")).toEqual({
      ok: true,
      address: "agent+lead-42@ravi.so",
      localPart: "agent+lead-42",
      domain: "ravi.so",
    });
  });

  test("rejects invalid inbound subaddress tags before routing", () => {
    expect(parseInboundMailAddress("agent+@ravi.so")).toMatchObject({
      ok: false,
      reason: "invalid_local_part",
      publicError: "mail_address_unavailable",
    });
  });

  test("appends -<orgSlug> suffix when missing", () => {
    expect(applyOrgSlugSuffix("luis", "acme")).toBe("luis-acme");
    expect(applyOrgSlugSuffix("agent.support", "acme-co")).toBe("agent.support-acme-co");
  });

  test("does not duplicate the -<orgSlug> suffix", () => {
    expect(applyOrgSlugSuffix("luis-acme", "acme")).toBe("luis-acme");
    expect(applyOrgSlugSuffix("agent.support-acme-co", "acme-co")).toBe("agent.support-acme-co");
  });

  test("normalizes the org slug and tolerates empty slugs", () => {
    expect(applyOrgSlugSuffix("luis", " ACME ")).toBe("luis-acme");
    expect(applyOrgSlugSuffix("luis", "")).toBe("luis");
  });
});
