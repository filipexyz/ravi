import { describe, expect, test } from "bun:test";

import { cliApiError, cliErrorPayload } from "./errors";

describe("CLI API errors", () => {
  test("returns a stable safe error shape", () => {
    const error = cliApiError(403, "INSTALLATION_REVOKED");
    expect(cliErrorPayload(error, "req_123")).toEqual({
      error: {
        code: "INSTALLATION_REVOKED",
        message: "This local Ravi installation has been revoked.",
        requestId: "req_123",
      },
    });
  });

  test("returns ravi-link uniqueness and authz codes", () => {
    expect(cliErrorPayload(cliApiError(409, "CONFLICT"), "req_conflict")).toEqual({
      error: {
        code: "CONFLICT",
        message: "This local contact is already linked to another Console user on this installation.",
        requestId: "req_conflict",
      },
    });
    expect(cliErrorPayload(cliApiError(400, "CONTACT_REQUIRED"), "req_contact").error.code).toBe(
      "CONTACT_REQUIRED",
    );
    expect(cliErrorPayload(cliApiError(403, "NOT_MEMBER"), "req_member").error.code).toBe("NOT_MEMBER");
    expect(
      cliErrorPayload(cliApiError(409, "INSTALLATION_ORG_MISMATCH"), "req_mismatch").error.code,
    ).toBe("INSTALLATION_ORG_MISMATCH");
  });

  test("returns ravi-link approval codes with safe messages", () => {
    const codes = [
      [404, "LOCAL_INSTALLATION_MISSING"],
      [403, "INSTALLATION_MISMATCH"],
      [410, "LINK_APPROVAL_REQUIRED"],
      [404, "LINK_REQUEST_INVALID"],
      [410, "LINK_REQUEST_EXPIRED"],
      [409, "LINK_REQUEST_USED"],
      [403, "LINK_USER_MISMATCH"],
    ] as const;
    for (const [status, code] of codes) {
      const payload = cliErrorPayload(cliApiError(status, code), "req_link_codes");
      expect(payload.error.code).toBe(code);
      expect(payload.error.message.length).toBeGreaterThan(0);
      expect(payload.error.message).not.toMatch(/token|@|contact:/i);
    }
  });
});
