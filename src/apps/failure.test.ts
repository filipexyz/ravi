import { describe, expect, test } from "bun:test";
import { parseRaviAppFailure, RaviAppFailureError, RAVI_APP_FAILURE_VERSION, toRaviAppFailure } from "./failure.js";

describe("Ravi App failure contract", () => {
  test("publishes a stable versioned envelope and sanitizes unknown errors", () => {
    expect(
      toRaviAppFailure(
        new RaviAppFailureError({
          code: "APP_INPUT_INVALID",
          category: "validation",
          message: "Input is invalid.",
          retryable: false,
          details: { source: "app" },
        }),
        { code: "APP_FAILED", message: "App failed.", source: "router" },
      ),
    ).toEqual({
      version: RAVI_APP_FAILURE_VERSION,
      code: "APP_INPUT_INVALID",
      category: "validation",
      message: "Input is invalid.",
      retryable: false,
      exitCode: 2,
      details: { source: "app" },
    });

    expect(
      toRaviAppFailure(new Error("token=secret upstream-sensitive"), {
        code: "APP_FAILED",
        message: "App failed.",
        source: "router",
      }),
    ).toEqual({
      version: RAVI_APP_FAILURE_VERSION,
      code: "APP_FAILED",
      category: "execution",
      message: "App failed.",
      retryable: false,
      exitCode: 1,
      details: { source: "router" },
    });
  });

  test("allowlists child failure details", () => {
    expect(
      parseRaviAppFailure({
        version: RAVI_APP_FAILURE_VERSION,
        code: "TINY_HTTP_RATE_LIMITED",
        category: "rate_limit",
        message: "Rate limited.",
        retryable: true,
        exitCode: 5,
        details: { source: "tiny", httpStatus: 429, retryAfterSeconds: 10, secret: "must-not-pass" },
      }),
    ).toEqual({
      version: RAVI_APP_FAILURE_VERSION,
      code: "TINY_HTTP_RATE_LIMITED",
      category: "rate_limit",
      message: "Rate limited.",
      retryable: true,
      exitCode: 5,
      details: { source: "tiny", httpStatus: 429, retryAfterSeconds: 10 },
    });
  });
});
