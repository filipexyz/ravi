import { describe, expect, it } from "bun:test";
import { isCodexCapacityError, normalizeCodexProviderError } from "./codex-provider-error.js";

describe("Codex provider error envelopes", () => {
  it.each([429, 503, 529])("preserves nested upstream status %s and retry metadata", (status) => {
    const result = normalizeCodexProviderError({
      code: -32000,
      message: "upstream rejected request",
      data: {
        error: {
          message: "busy",
          codexErrorInfo: { httpConnectionFailed: { httpStatusCode: status } },
          headers: { "Retry-After": "7", Authorization: "must-not-escape" },
        },
      },
    });
    expect(result.status).toBe(status);
    expect(result.headers).toEqual({ "retry-after": "7" });
    expect(isCodexCapacityError(result)).toBe(true);
  });

  it.each(["serverOverloaded", "rateLimitExceeded", "flexUnavailable"])("recognizes typed %s", (codexErrorInfo) => {
    expect(isCodexCapacityError(normalizeCodexProviderError({ message: "rejected", codexErrorInfo }))).toBe(true);
  });

  it.each(["usageLimitExceeded", "badRequest", "unauthorized", "policyCapacityUnavailable"])(
    "does not retry %s as capacity",
    (codexErrorInfo) => {
      expect(isCodexCapacityError(normalizeCodexProviderError({ message: "rejected", codexErrorInfo }))).toBe(false);
    },
  );

  it("accepts only the exact legacy capacity error signature", () => {
    const message = "Selected model is at capacity. Please try a different model.";
    expect(normalizeCodexProviderError({ message })).toMatchObject({ code: "model_capacity_exceeded" });
    expect(isCodexCapacityError(normalizeCodexProviderError({ message: `Tool output contains: ${message}` }))).toBe(
      false,
    );
    expect(isCodexCapacityError(normalizeCodexProviderError({ message, status: 400 }))).toBe(false);
    expect(isCodexCapacityError(normalizeCodexProviderError({ message, codexErrorInfo: "unauthorized" }))).toBe(false);
  });
});
