import { describe, expect, it } from "bun:test";
import { formatUserFacingTurnFailure, publicRuntimeFailureDetail } from "./public-failure.js";

describe("public runtime failures", () => {
  it("hides filesystem errors and local paths", () => {
    const raw = "ENOENT: no such file or directory, scandir '/Users/luis/.cache/ravi/plugins/ravi-system/skills/slack'";
    const formatted = formatUserFacingTurnFailure(raw);

    expect(formatted).toBe(
      "Error: The agent could not complete this request because of an internal runtime error. Please try again.",
    );
    expect(formatted).not.toContain("ENOENT");
    expect(formatted).not.toContain("scandir");
    expect(formatted).not.toContain("/Users/luis");
  });

  it.each([
    "TypeError: handler is not a function",
    "ReferenceError: runtimeState is not defined",
    "Could not read file:///private/tmp/ravi/config.json",
    "Failed while loading path=/workspace/ravi/runtime/config.json",
    "Failed while loading `/tmp`",
    "Failed while loading /nix/store/abc123-ravi/runtime.json",
    "Failed while loading ~/ravi/main/AGENTS.md",
    "EACCES: permission denied, open 'C:\\Users\\Luis\\secret.txt'",
    "Failed while loading C:/custom/ravi/config.json",
    "Failed while loading \\\\fileserver\\private\\config.json",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package ravi-system",
    "Internal plugin ravi-system is missing its manifest",
    "Cannot read properties of undefined (reading 'path')",
    "runtimeState is not defined",
    "Maximum call stack size exceeded",
    "Cannot find module ravi-system",
    "request failed with token=secret-token-value",
    "request failed with xoxb-1234567890-abcdefghij",
    "request failed with xapp-1234567890-abcdefghij",
    "request failed with github_pat_1234567890abcdefghij",
    "request failed with AIzaSyA1234567890abcdefghijklmno",
    "request failed with eyJabcdefghij.eyJabcdefghij.signature123",
    "database failed at postgresql://admin:secret@db.internal/ravi",
    "request failed at https://admin:secret@example.com/private",
    "AWS_SECRET_ACCESS_KEY=secret-value",
    "AWS_SESSION_TOKEN=session-token-value",
    "request failed at https://example.com/callback?auth=secret-value",
    'Config invalid: {"password":"hunter2","host":"db"}',
    'Config invalid: {"token":"secret-token-value"}',
    'Config invalid: {"apiKey":"secret-api-key-value"}',
    "Request failed with Authorization: Basic dXNlcjpzdXBlcnNlY3JldA==",
  ])("hides technical or sensitive detail: %s", (raw) => {
    expect(publicRuntimeFailureDetail(raw)).toBe(
      "The agent could not complete this request because of an internal runtime error. Please try again.",
    );
  });

  it("preserves actionable provider errors", () => {
    expect(formatUserFacingTurnFailure("Runtime provider requires full access for this agent.")).toBe(
      "Error: Runtime provider requires full access for this agent.",
    );
    expect(formatUserFacingTurnFailure("Usage limit reached. Try again after 14:30.")).toBe(
      "Error: Usage limit reached. Try again after 14:30.",
    );
    expect(formatUserFacingTurnFailure("See https://status.openai.com for updates.")).toBe(
      "Error: See https://status.openai.com for updates.",
    );
    expect(formatUserFacingTurnFailure("Provider says see /docs/auth for remediation.")).toBe(
      "Error: Provider says see /docs/auth for remediation.",
    );
    expect(formatUserFacingTurnFailure("Provider says path=/docs/auth for remediation.")).toBe(
      "Error: Provider says path=/docs/auth for remediation.",
    );
    expect(formatUserFacingTurnFailure("Account cannot call /v1/responses; verify access.")).toBe(
      "Error: Account cannot call /v1/responses; verify access.",
    );
    expect(formatUserFacingTurnFailure("RateLimitError: Usage limit reached. Try again later.")).toBe(
      "Error: RateLimitError: Usage limit reached. Try again later.",
    );
    expect(formatUserFacingTurnFailure("AuthenticationError: Sign in again to continue.")).toBe(
      "Error: AuthenticationError: Sign in again to continue.",
    );
    expect(formatUserFacingTurnFailure("PermissionError: This model requires organization verification.")).toBe(
      "Error: PermissionError: This model requires organization verification.",
    );
    expect(formatUserFacingTurnFailure("Organization acme is not defined for this account.")).toBe(
      "Error: Organization acme is not defined for this account.",
    );
  });

  it("uses the Error subtype and hides non-string failures", () => {
    expect(publicRuntimeFailureDetail(new TypeError("handler failed"))).toBe(
      "The agent could not complete this request because of an internal runtime error. Please try again.",
    );
    expect(publicRuntimeFailureDetail({ message: "secret internal detail" })).toBe(
      "The agent could not complete this request because of an internal runtime error. Please try again.",
    );
  });

  it("avoids a duplicate Error prefix and bounds long details", () => {
    expect(formatUserFacingTurnFailure("Error: Error: retry later")).toBe("Error: retry later");

    const formatted = formatUserFacingTurnFailure("x".repeat(500));
    expect(formatted.startsWith("Error: ")).toBe(true);
    expect(formatted).toContain("... [truncated]");
    expect(formatted.length).toBeLessThanOrEqual(327);
  });
});
