import { describe, expect, it } from "bun:test";
import { cloudErrorToContractError } from "../cli/cloud-error-contract.js";
import {
  CloudAuthError,
  classifyConsoleNetworkError,
  cloudAuthErrorFromUnknown,
  isConnectorPolicyCode,
  isRetryableCloudAuthError,
  normalizeCloudAuthErrorCode,
  type CloudAuthErrorCode,
} from "./errors.js";

describe("CloudAuthError retry hints", () => {
  it("keeps Retry-After off the public error JSON", () => {
    const error = new CloudAuthError("RATE_LIMITED", "limited", { status: 429, retryAfterMs: 15_000 });

    expect(error.retryAfterMs).toBe(15_000);
    expect(error.toJSON()).toEqual({
      code: "RATE_LIMITED",
      message: "limited",
      status: 429,
    });
  });
});

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

describe("normalizeCloudAuthErrorCode", () => {
  it("maps Console /api/cli/link codes onto existing CLI codes", () => {
    expect(normalizeCloudAuthErrorCode("CONFLICT", "PAYLOAD_INVALID")).toBe("ACTOR_BINDING_CONFLICT");
    expect(normalizeCloudAuthErrorCode("NOT_MEMBER", "PAYLOAD_INVALID")).toBe("ORG_ACCESS_DENIED");
    expect(normalizeCloudAuthErrorCode("INSTALLATION_ORG_MISMATCH", "PAYLOAD_INVALID")).toBe("ORG_ACCESS_DENIED");
    expect(normalizeCloudAuthErrorCode("CONTACT_REQUIRED", "PAYLOAD_INVALID")).toBe("CONTACT_REQUIRED");
    expect(normalizeCloudAuthErrorCode("AUTH_REQUIRED", "PAYLOAD_INVALID")).toBe("AUTH_REQUIRED");
  });

  it("maps Link connector codes onto the connector CLI codes", () => {
    expect(normalizeCloudAuthErrorCode("connector_group_blocked", "PAYLOAD_INVALID")).toBe("CONNECTOR_GROUP_BLOCKED");
    expect(normalizeCloudAuthErrorCode("connector_speaker_not_owner", "PAYLOAD_INVALID")).toBe(
      "CONNECTOR_SPEAKER_NOT_OWNER",
    );
    expect(normalizeCloudAuthErrorCode("connector_approval_required", "PAYLOAD_INVALID")).toBe(
      "CONNECTOR_APPROVAL_REQUIRED",
    );
    expect(normalizeCloudAuthErrorCode("connector_reauth_required", "PAYLOAD_INVALID")).toBe(
      "CONNECTOR_REAUTH_REQUIRED",
    );
    expect(normalizeCloudAuthErrorCode("connector_forbidden", "PROJECT_ACCESS_DENIED")).toBe("CONNECTOR_FORBIDDEN");
  });
});

describe("connector error exit codes", () => {
  const POLICY: CloudAuthErrorCode[] = [
    "CONNECTOR_GROUP_BLOCKED",
    "CONNECTOR_SPEAKER_NOT_OWNER",
    "CONNECTOR_DISABLED_BY_ORG",
    "CONNECTOR_TOOL_BLOCKED",
    "CONNECTOR_APPROVAL_REQUIRED",
    "CONNECTOR_APPROVAL_PENDING",
    "CONNECTOR_APPROVAL_DENIED",
    "CONNECTOR_CONSENT_REQUIRED",
    "CONNECTOR_NOT_LINKED",
  ];
  const ERRORS: CloudAuthErrorCode[] = [
    "CONNECTOR_APPROVAL_INVALID",
    "CONNECTOR_CONNECTION_REQUIRED",
    "CONNECTOR_REAUTH_REQUIRED",
    "CONNECTOR_FORBIDDEN",
  ];

  it.each(POLICY)("%s is a policy block (exit 3)", (code) => {
    expect(isConnectorPolicyCode(code)).toBe(true);
    expect(new CloudAuthError(code, "x").exitCode).toBe(3);
    expect(cloudErrorToContractError("gmail list", new CloudAuthError(code, "x")).exitCode).toBe(3);
  });

  it.each(ERRORS)("%s is an ordinary failure (exit 1)", (code) => {
    expect(isConnectorPolicyCode(code)).toBe(false);
    expect(new CloudAuthError(code, "x").exitCode).toBe(1);
    expect(cloudErrorToContractError("gmail list", new CloudAuthError(code, "x")).exitCode).toBe(1);
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

  it("lets an explicit retryable flag override the code default", () => {
    const misconfigured = new CloudAuthError("SERVER_UNAVAILABLE", "Console CLI auth is not configured.", {
      retryable: false,
    });

    expect(isRetryableCloudAuthError(misconfigured)).toBe(false);
    expect(isRetryableCloudAuthError(new CloudAuthError("SERVER_UNAVAILABLE", "down"))).toBe(true);
    expect(cloudErrorToContractError("login", misconfigured)).toMatchObject({
      code: "SERVER_UNAVAILABLE",
      details: { retryable: false },
    });
    expect(misconfigured.toJSON()).toEqual({
      code: "SERVER_UNAVAILABLE",
      message: "Console CLI auth is not configured.",
    });
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
    [
      "CONTACT_REQUIRED",
      "ravi link needs the current chat message to come from a known person (a resolved contact).",
      false,
    ],
    ["ACTOR_BINDING_CONFLICT", "This contact is already linked to a different Console user.", false],
    ["LOCAL_INSTALLATION_MISSING", "Console does not know this local Ravi installation.", false],
    ["INSTALLATION_MISMATCH", "The request named a different installation than the current Console session.", false],
    [
      "LINK_APPROVAL_REQUIRED",
      "Linking requires the person's approval in the browser; the direct link call is closed.",
      false,
    ],
    ["LINK_REQUESTS_UNAVAILABLE", "This Console does not support link approval requests yet.", false],
    ["LINK_DM_UNSUPPORTED", "Ravi cannot send a private message to this person on this channel.", false],
    ["LINK_DM_FAILED", "Ravi could not send the private message to the person who asked.", false],
    ["CONNECTOR_GROUP_BLOCKED", "Personal connections are not used in group chats.", false],
    ["CONNECTOR_SPEAKER_NOT_OWNER", "This connection only serves its owner's own requests.", false],
    ["CONNECTOR_DISABLED_BY_ORG", "The organization turned this connector off.", false],
    ["CONNECTOR_TOOL_BLOCKED", "The account owner or the organization blocked this tool.", false],
    ["CONNECTOR_APPROVAL_REQUIRED", "The account owner must approve this action first.", false],
    ["CONNECTOR_APPROVAL_PENDING", "The approval for this action is still waiting for the account owner.", false],
    ["CONNECTOR_APPROVAL_DENIED", "The account owner denied this action.", false],
    ["CONNECTOR_APPROVAL_INVALID", "The approval does not match this action.", false],
    ["CONNECTOR_CONSENT_REQUIRED", "The person asking must allow this agent to use their account first.", false],
    ["CONNECTOR_NOT_LINKED", "The person asking is not linked to a Console user.", false],
    ["CONNECTOR_CONNECTION_REQUIRED", "The person asking has no connected account for this service.", false],
    ["CONNECTOR_REAUTH_REQUIRED", "The connection expired and must be reconnected.", false],
    ["CONNECTOR_FORBIDDEN", "Only the owner of this connection can do that.", false],
  ] as const)("maps %s to a stable public message", (code, publicMessage, retryable) => {
    const source = new CloudAuthError(code, `PRIVATE_PROVIDER_BODY_8K2R:${code}`, { status: 429 });
    const contract = cloudErrorToContractError("cloud fixture fail", source);

    expect(contract).toMatchObject({
      code,
      message: publicMessage,
      exitCode: code === "PAYLOAD_INVALID" ? 2 : isConnectorPolicyCode(code) ? 3 : 1,
      details: {
        retryable,
        status: 429,
      },
    });
    expect(contract.details.suggestedAction).toBeString();
    expect(JSON.stringify(contract.envelope())).not.toContain("PRIVATE_PROVIDER_BODY_8K2R");
  });

  it("keeps the chat line of a locally classified connector block, not the remote catalog copy", () => {
    const source = new CloudAuthError(
      "CONNECTOR_SPEAKER_NOT_OWNER",
      "This turn is someone else's. Say: \"I can't use Luis's Gmail for your request.\"",
      {
        exitCode: 3,
        details: {
          source: "connector-turn",
          chatLine: "I can't use Luis's Gmail for your request.",
          chatLinePt: "Não posso usar o Gmail de Luis para o seu pedido.",
          replyTo: "speaker",
          ignored: "not copied",
        },
      },
    );
    const contract = cloudErrorToContractError("gmail list", source);

    expect(contract.exitCode).toBe(3);
    expect(contract.message).toContain("I can't use Luis's Gmail for your request.");
    expect(contract.details).toMatchObject({
      chatLine: "I can't use Luis's Gmail for your request.",
      chatLinePt: "Não posso usar o Gmail de Luis para o seu pedido.",
      replyTo: "speaker",
    });
    expect(contract.details.ignored).toBeUndefined();
  });

  it("uses the catalog copy for a remote connector block even when it carries details", () => {
    const source = new CloudAuthError(
      "CONNECTOR_GROUP_BLOCKED",
      "Ravi Link request failed (403): connector_group_blocked",
      {
        status: 403,
        details: { chatLine: "remote text" },
      },
    );
    const contract = cloudErrorToContractError("gmail list", source);

    expect(contract.message).toBe("Personal connections are not used in group chats.");
    expect(contract.details.chatLine).toBeUndefined();
  });

  it("preserves sanitized local PAYLOAD_INVALID reasons as the public message and issues", () => {
    const source = new CloudAuthError("PAYLOAD_INVALID", "--html file was not found: ./index.html");
    const contract = cloudErrorToContractError("pages ship", source);

    expect(contract).toMatchObject({
      code: "PAYLOAD_INVALID",
      message: "--html file was not found: ./index.html",
      exitCode: 2,
      details: {
        issues: [{ path: ["html"], code: "invalid", message: "--html file was not found: ./index.html" }],
      },
    });
    expect(JSON.stringify(contract.envelope())).toContain("--html file was not found: ./index.html");
  });

  it("redacts absolute paths inside local PAYLOAD_INVALID reasons", () => {
    const source = new CloudAuthError("PAYLOAD_INVALID", "--html file was not found: /home/user/secret/index.html");
    const contract = cloudErrorToContractError("pages ship", source);

    expect(contract.message).toBe("--html file was not found: [REDACTED:path]");
    expect(JSON.stringify(contract.envelope())).not.toContain("/home/user/secret");
  });

  it("projects Console validation issues into the public contract", () => {
    const source = new CloudAuthError("PAYLOAD_INVALID", "PRIVATE_PROVIDER_BODY_8K2R:PAYLOAD_INVALID", {
      status: 422,
      issues: [{ path: ["name"], code: "too_small", message: "Required" }],
    });
    const contract = cloudErrorToContractError("credentials create", source);

    expect(contract).toMatchObject({
      code: "PAYLOAD_INVALID",
      message: "Console request input was invalid.",
      exitCode: 2,
      details: {
        retryable: false,
        status: 422,
        issues: [{ path: ["name"], code: "too_small", message: "Required" }],
      },
    });
    expect(JSON.stringify(contract.envelope())).toContain("Required");
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
