import { describe, expect, it } from "bun:test";
import { cloudErrorToContractError } from "../cli/cloud-error-contract.js";
import { CloudAuthError, classifyConsoleNetworkError, cloudAuthErrorFromUnknown } from "./errors.js";

describe("cloudAuthErrorFromUnknown", () => {
  it("preserves an already classified cloud error", () => {
    const classified = new CloudAuthError("RATE_LIMITED", "Provider rate limit reached.", { status: 429 });

    expect(cloudAuthErrorFromUnknown(classified)).toBe(classified);
  });

  it("keeps an unknown cause for diagnostics without exposing its message", () => {
    const cause = new Error("https://provider.invalid?token=private-provider-secret");
    const normalized = cloudAuthErrorFromUnknown(cause);

    expect(normalized).toMatchObject({
      code: "SERVER_UNAVAILABLE",
      message: "Cloud service request failed.",
      cause,
    });
    expect(JSON.stringify(normalized.toJSON())).not.toContain("private-provider-secret");
  });
});

describe("classifyConsoleNetworkError", () => {
  it("keeps host Console outages as SERVER_UNAVAILABLE", () => {
    const error = Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
    expect(classifyConsoleNetworkError(error, { plane: "host" })).toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
  });

  it("maps sandbox network failures to HOST_UNREACHABLE without mentioning pi", () => {
    const error = Object.assign(new Error("fetch failed"), { code: "ECONNREFUSED" });
    const classified = classifyConsoleNetworkError(error, { plane: "provider-sandbox" });

    expect(classified).toMatchObject({
      code: "HOST_UNREACHABLE",
      message: "Console is unreachable from this provider sandbox. The host CLI can reach Console.",
    });
    const contract = cloudErrorToContractError("pages published", classified);
    expect(contract).toMatchObject({
      code: "HOST_UNREACHABLE",
      details: { retryable: false },
    });
    expect(contract.details.suggestedAction).toContain("host");
    expect(JSON.stringify(contract.envelope())).not.toContain("pi");
  });
});

describe("cloudErrorToContractError", () => {
  it.each([
    ["AUTH_REQUIRED", "Console authentication is required.", false],
    ["AUTH_PENDING", "Console authentication is still pending.", true],
    ["AUTH_EXPIRED", "Console authentication expired.", false],
    ["INSTALLATION_REVOKED", "Console installation access was revoked.", false],
    ["ORG_ACCESS_DENIED", "Console organization access was denied.", false],
    ["PROJECT_ACCESS_DENIED", "Console project access was denied.", false],
    ["PUBLISH_NOT_ALLOWED", "Console publishing is not allowed.", false],
    ["PAYLOAD_INVALID", "Console request input was invalid.", false],
    ["RATE_LIMITED", "Console request was rate limited.", true],
    ["SERVER_UNAVAILABLE", "Console service is unavailable.", true],
    ["HOST_UNREACHABLE", "Console is unreachable from this provider sandbox. The host CLI can reach Console.", false],
    ["CREDENTIALS_INVALID", "Console credentials are invalid.", false],
    ["CLOUD_PUBLISH_NOT_IMPLEMENTED", "Console publishing is unavailable for this command.", false],
  ] as const)("maps %s to a stable public message", (code, publicMessage, retryable) => {
    const source = new CloudAuthError(code, `PRIVATE_PROVIDER_BODY_8K2R:${code}`, { status: 429 });
    const contract = cloudErrorToContractError("cloud fixture fail", source);

    expect(contract).toMatchObject({
      code,
      message: publicMessage,
      exitCode: code === "PAYLOAD_INVALID" ? 2 : 1,
      details: {
        retryable,
        status: 429,
      },
    });
    expect(contract.details.suggestedAction).toBeString();
    expect(JSON.stringify(contract.envelope())).not.toContain("PRIVATE_PROVIDER_BODY_8K2R");
  });

  it("surfaces the sanitized DNS instruction for Pages domain setup", () => {
    const source = new CloudAuthError(
      "DOMAIN_SETUP_REQUIRED",
      "Add TXT _ravi-verify.example.com = ravi-domain-verification=test-token\u001b[31m",
      { status: 400 },
    );
    const contract = cloudErrorToContractError("pages domains", source);

    expect(contract).toMatchObject({
      code: "DOMAIN_SETUP_REQUIRED",
      exitCode: 1,
      message: "Add TXT _ravi-verify.example.com = ravi-domain-verification=test-token",
      details: {
        retryable: false,
        status: 400,
        suggestedAction: "complete the displayed DNS action, wait for propagation, then rerun the same command",
      },
    });
  });
});
