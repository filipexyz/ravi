import { describe, expect, test } from "bun:test";

import { AdapterProviderError } from "./adapters/adapter";
import { isInvalidGrant, missingRequiredProviderScopes } from "./proxy";

describe("connector proxy scope checks", () => {
  test("accepts exact granted scopes", () => {
    expect(
      missingRequiredProviderScopes(
        ["https://www.googleapis.com/auth/gmail.send"],
        ["https://www.googleapis.com/auth/gmail.send"],
      ),
    ).toEqual([]);
  });

  test("accepts known Google broader scopes for read capabilities", () => {
    expect(
      missingRequiredProviderScopes(
        ["https://www.googleapis.com/auth/gmail.readonly"],
        ["https://www.googleapis.com/auth/gmail.modify"],
      ),
    ).toEqual([]);
    expect(
      missingRequiredProviderScopes(
        ["https://www.googleapis.com/auth/calendar.readonly"],
        ["https://www.googleapis.com/auth/calendar"],
      ),
    ).toEqual([]);
  });

  test("does not treat Gmail modify as send permission", () => {
    expect(
      missingRequiredProviderScopes(
        ["https://www.googleapis.com/auth/gmail.send"],
        ["https://www.googleapis.com/auth/gmail.modify"],
      ),
    ).toEqual(["https://www.googleapis.com/auth/gmail.send"]);
  });
});

describe("connector proxy refresh failures", () => {
  test("recognizes Google invalid_grant only", () => {
    expect(isInvalidGrant(new AdapterProviderError(400, "invalid_grant", "x"))).toBe(true);
    expect(isInvalidGrant(new AdapterProviderError(400, "invalid_request", "x"))).toBe(false);
    expect(isInvalidGrant(new AdapterProviderError(503, null, "x"))).toBe(false);
    expect(isInvalidGrant(new Error("invalid_grant"))).toBe(false);
  });
});
