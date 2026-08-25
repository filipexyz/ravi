import { describe, expect, it } from "bun:test";
import {
  dispatchRemote,
  getRemoteGatewayConfig,
  resolveRemoteGatewayConfig,
  remoteDispatchOutput,
  remoteGatewayErrorToContractError,
  remoteGatewayExitCode,
  type RemoteDispatchResult,
} from "./remote-gateway.js";

describe("remote gateway response bytes", () => {
  it("preserves arbitrary binary payloads without UTF-8 round-tripping", async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x42, 0x80]);
    const response = await dispatchRemote({
      groupSegments: ["artifacts"],
      command: "blob",
      body: { id: "artifact-1" },
      config: { url: "https://gateway.example", source: "env" },
      contextKey: "rctx_test",
      fetchImpl: (async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        })) as unknown as typeof fetch,
    });

    expect(response.ok).toBe(true);
    expect(response.bodyBytes).toEqual(bytes);
    expect(remoteDispatchOutput(response)).toEqual({ kind: "bytes", value: bytes });
  });

  it("adds formatting only to textual output", () => {
    expect(
      remoteDispatchOutput({
        status: 200,
        ok: true,
        body: '{"ok":true}',
        contentType: "application/json",
      }),
    ).toEqual({ kind: "text", value: '{\n  "ok": true\n}\n' });
  });
});

describe("remote gateway configuration", () => {
  it("distinguishes an unset gateway from an invalid configured URL", () => {
    expect(getRemoteGatewayConfig({})).toBeNull();
    for (const value of ["not a URL", "file:///tmp/ravi", "unix:relative.sock"]) {
      let failure: unknown;
      try {
        getRemoteGatewayConfig({ RAVI_GATEWAY_URL: value });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "REMOTE_GATEWAY_INVALID", exitCode: 2 });
    }
  });

  it("accepts an explicit unix socket URL without opening loopback HTTP", () => {
    expect(getRemoteGatewayConfig({ RAVI_GATEWAY_URL: "unix:///home/user/.ravi/cli-gateway.sock" })).toEqual({
      url: "unix:///home/user/.ravi/cli-gateway.sock",
      source: "env",
      socketPath: "/home/user/.ravi/cli-gateway.sock",
    });
  });

  it("auto-bridges isolated CLIs to a reachable host unix socket", async () => {
    const config = await resolveRemoteGatewayConfig(
      { RAVI_CONTEXT_KEY: "rctx_test" },
      "pages published",
      {
        stateDir: "/home/user/.ravi",
        probeSocket: async (socketPath) => socketPath === "/home/user/.ravi/cli-gateway.sock",
      },
    );

    expect(config).toEqual({
      url: "unix:///home/user/.ravi/cli-gateway.sock",
      source: "host-socket",
      socketPath: "/home/user/.ravi/cli-gateway.sock",
    });
  });

  it("does not auto-bridge without a context key, a reachable socket, or when disabled", async () => {
    expect(
      await resolveRemoteGatewayConfig({}, "pages published", {
        stateDir: "/home/user/.ravi",
        probeSocket: async () => true,
      }),
    ).toBeNull();
    expect(
      await resolveRemoteGatewayConfig(
        { RAVI_CONTEXT_KEY: "rctx_test", RAVI_HOST_CLI_GATEWAY: "0" },
        "pages published",
        { stateDir: "/home/user/.ravi", probeSocket: async () => true },
      ),
    ).toBeNull();
    expect(
      await resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
        stateDir: "/home/user/.ravi",
        probeSocket: async () => false,
      }),
    ).toBeNull();
    expect(
      await resolveRemoteGatewayConfig(
        { RAVI_CONTEXT_KEY: "rctx_test", RAVI_GATEWAY_URL: "https://gateway.example" },
        "pages published",
        { stateDir: "/home/user/.ravi", probeSocket: async () => true },
      ),
    ).toEqual({ url: "https://gateway.example", source: "env" });
  });
});

function result(overrides: Partial<RemoteDispatchResult>): RemoteDispatchResult {
  return {
    status: 500,
    ok: false,
    body: "",
    contentType: "application/json",
    ...overrides,
  };
}

describe("remote gateway exit taxonomy", () => {
  it.each([1, 2, 3] as const)("preserves contract exit %i", (exitCode) => {
    const outcome = exitCode === 2 ? "usage_error" : exitCode === 3 ? "blocked" : "failed";
    expect(
      remoteGatewayExitCode(
        result({
          body: JSON.stringify({
            success: false,
            op: "commands list",
            exitCode,
            outcome,
            error: { code: "DEMO_ERROR", message: "safe failure", retryable: false },
          }),
        }),
      ),
    ).toBe(exitCode);
  });

  it("keeps success at zero and malformed or legacy failures at one", () => {
    expect(remoteGatewayExitCode(result({ ok: true, status: 200 }))).toBe(0);
    expect(remoteGatewayExitCode(result({ body: "not-json" }))).toBe(1);
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ error: "legacy" }) }))).toBe(1);
    expect(remoteGatewayExitCode(result({ body: JSON.stringify({ success: false, exitCode: 3 }) }))).toBe(1);
  });

  it("normalizes legacy permission responses into the canonical contract", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "PermissionDenied", reason: "PRIVATE_MESSAGE_8K2R" }),
      }),
    );

    expect(error).toMatchObject({
      op: "commands list",
      code: "PERMISSION_DENIED",
      exitCode: 1,
      message: "Remote gateway denied the command.",
    });
    expect(error?.envelope()).toMatchObject({ success: false, error: { code: "PERMISSION_DENIED" } });
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });

  it("redacts malformed remote failures as retryable server errors", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({ status: 503, contentType: "text/plain", body: "private upstream response" }),
    );

    expect(error).toMatchObject({ op: "commands list", code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(error?.envelope())).not.toContain("private upstream response");
  });

  it("rejects partial or incoherent contract-looking responses", () => {
    const partial = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 3,
          error: { code: "WRITE_REQUIRES_EXECUTE", message: "raw private response" },
        }),
      }),
    );
    const wrongOperation = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "secrets reveal",
          exitCode: 3,
          outcome: "blocked",
          error: { code: "WRITE_REQUIRES_EXECUTE", message: "blocked", retryable: false },
        }),
      }),
    );

    expect(partial).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(partial?.envelope())).not.toContain("raw private response");
    expect(wrongOperation).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
  });

  it.each([
    [1, "failed", "WRITE_REQUIRES_EXECUTE"],
    [1, "failed", "USAGE_ERROR"],
  ] as const)("rejects exit %i/%s with policy code %s", (exitCode, outcome, code) => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode,
          outcome,
          error: { code, message: "private mismatch", retryable: false },
        }),
      }),
    );

    expect(error).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(error?.envelope())).not.toContain("private mismatch");
  });

  it.each([
    [1, "failed", "COMMAND_FAILED", "Remote command failed."],
    [1, "denied", "PERMISSION_DENIED", "Remote gateway denied the command."],
    [2, "usage_error", "USAGE_ERROR", "Remote gateway rejected the command input."],
    [3, "blocked", "WRITE_REQUIRES_EXECUTE", "Remote command was blocked by policy."],
  ] as const)("projects a complete exit %i/%s response into a safe local contract", (exitCode, outcome, code, message) => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode,
          outcome,
          providerBody: "PRIVATE_MESSAGE_8K2R",
          plan: { token: "SENTINEL_SECRET_7M4Q" },
          error: {
            code,
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: true,
            metadata: { secret: "SENTINEL_SECRET_7M4Q" },
          },
        }),
      }),
    );

    expect(error).toMatchObject({ op: "commands list", code, exitCode, message, details: { retryable: true } });
    const serialized = JSON.stringify(error?.envelope());
    expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(serialized).not.toContain("providerBody");
    expect(serialized).not.toContain("metadata");
  });

  it("rejects an invalid remote error code instead of reflecting it", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 1,
          outcome: "failed",
          error: { code: "private:SENTINEL_SECRET_7M4Q", message: "safe", retryable: false },
        }),
      }),
    );

    expect(error).toMatchObject({ code: "SERVER_UNAVAILABLE", exitCode: 1 });
    expect(JSON.stringify(error?.envelope())).not.toContain("SENTINEL_SECRET_7M4Q");
  });

  it("preserves only allowlisted and sanitized agent-first details", () => {
    const oversizedPosition = `<${"a".repeat(65)}>`;
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 3,
          outcome: "blocked",
          error: {
            code: "WRITE_REQUIRES_EXECUTE",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
            suggestedAction: "PRIVATE_MESSAGE_8K2R",
            suggestions: [
              "Alice Smith",
              "CRM-42",
              "calendar_main",
              "C:/sentinel/private",
              "sk-abcdefghijklmnop",
              { secret: "SENTINEL_SECRET_7M4Q" },
            ],
            acceptedFlags: ["--json", "PRIVATE_MESSAGE_8K2R"],
            acceptedPositionals: [
              "<opportunity>",
              "[text]",
              "<name...>",
              "SENTINEL_SECRET_7M4Q",
              "PRIVATE MESSAGE",
              oversizedPosition,
            ],
            dryRun: true,
            plan: {
              operation: "publish",
              resource: "artifact",
              resourceId: "artifact_123",
              provider: "sk-abcdefghijklmnop",
              contextId: "rctx_private_context",
              captionPresent: true,
              messageChars: 20,
              attachmentCount: 1,
              target: "commands",
              token: "SENTINEL_SECRET_7M4Q",
              message: "PRIVATE_MESSAGE_8K2R",
              filePath: "C:/sentinel/private/file-9P3X.txt",
              privateNote: "private-note",
              destination: { channelId: "channel_123", label: "PRIVATE_LABEL_8K2R" },
            },
            details: { arbitrary: "PRIVATE_DETAILS_8K2R" },
            issues: [{ providerBody: "PRIVATE_MESSAGE_8K2R" }],
          },
        }),
      }),
    );

    expect(error?.envelope().error).toMatchObject({
      suggestedAction: "Review the remote policy block before retrying the command",
      suggestions: ["CRM-42", "calendar_main"],
      acceptedFlags: ["--json"],
      acceptedPositionals: ["<opportunity>", "[text]", "<name...>"],
      dryRun: true,
      plan: {
        operation: "publish",
        resource: "artifact",
        resourceId: "artifact_123",
        captionPresent: true,
        messageChars: 20,
        attachmentCount: 1,
        destination: { channelId: "channel_123" },
      },
    });
    const serialized = JSON.stringify(error?.envelope());
    expect(serialized).not.toContain("Alice Smith");
    expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
    expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).not.toContain("rctx_private_context");
    expect(serialized).not.toContain("C:/sentinel/private");
    expect(serialized).not.toContain("issues");
    expect(serialized).not.toContain("privateNote");
    expect(serialized).not.toContain("PRIVATE_DETAILS_8K2R");
    expect(serialized).not.toContain("PRIVATE_LABEL_8K2R");
    expect(serialized).not.toContain('"target"');
    expect(serialized).not.toContain(oversizedPosition);
  });

  it("keeps representative native dry-run plans actionable after remote projection", () => {
    const cases = [
      {
        op: "agents delete",
        plan: { agentId: "main", cwdPresent: true, namePresent: false },
      },
      {
        op: "agents permissions",
        plan: {
          agentId: "main",
          beforePresent: true,
          beforeProfile: "none",
          beforeCapabilitiesCount: 0,
          afterPresent: true,
          afterProfile: "full-access",
          afterCapabilitiesCount: 3,
        },
      },
      {
        op: "artifacts publish",
        plan: {
          target: { kind: "artifact", artifactId: "art_123" },
          project: "project-main",
          site: "public-site",
          routePresent: true,
          visibility: "public",
          namePresent: true,
          slug: "landing-page",
          entrypointPresent: true,
          artifactVersion: 2,
          activate: true,
          replaceRelease: false,
        },
      },
      {
        op: "whatsapp dm send",
        plan: {
          channel: "whatsapp",
          accountId: "default",
          targetType: "contact",
          targetRef: "sha256:0123456789abcdef",
          effect: "send-message",
          messageChars: 20,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const error = remoteGatewayErrorToContractError(
        testCase.op,
        result({
          status: 409,
          body: JSON.stringify({
            success: false,
            op: testCase.op,
            exitCode: 3,
            outcome: "blocked",
            error: {
              code: "WRITE_REQUIRES_EXECUTE",
              message: "private remote message",
              retryable: false,
              dryRun: true,
              plan: testCase.plan,
            },
          }),
        }),
      );

      expect(error?.envelope().error).toMatchObject({ dryRun: true, plan: testCase.plan });
    }
  });
});
