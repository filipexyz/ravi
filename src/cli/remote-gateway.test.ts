import { describe, expect, it } from "bun:test";
import { userInfo } from "node:os";
import { join } from "node:path";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { contractErrorResponse } from "../sdk/gateway/errors.js";
import { renderContractError } from "./agent-contract.js";
import {
  connectorConnectionRequiredError,
  connectorConsentError,
  connectorNotLinkedError,
} from "../link/connectors.js";
import { cloudErrorToContractError } from "./cloud-error-contract.js";
import {
  FILE_NOT_FOUND_CODE,
  FILE_NOT_FOUND_MESSAGE,
  FILE_NOT_FOUND_SUGGESTED_ACTION,
  MEDIA_SEND_FAILED_CODE,
  MEDIA_SEND_FAILED_MESSAGE,
  MEDIA_SEND_FAILED_SUGGESTED_ACTION,
  OMNI_AUTH_FAILED_CODE,
  OMNI_AUTH_FAILED_MESSAGE,
  OMNI_AUTH_FAILED_SUGGESTED_ACTION,
} from "./media-send-auth.js";
import {
  CALLER_CWD_HEADER,
  dispatchRemote,
  gatewayRequiredError,
  getRemoteGatewayConfig,
  requiresRemoteGateway,
  resolveHostCliGatewayStateDirs,
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
      cwd: "/tmp/agent-workspace",
      fetchImpl: ((input: string, init?: { headers?: Record<string, string> }) => {
        void input;
        expect(new Headers(init?.headers).get(CALLER_CWD_HEADER)).toBe("/tmp/agent-workspace");
        return Promise.resolve(
          new Response(bytes, {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          }),
        );
      }) as unknown as typeof fetch,
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
    const config = await resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
      stateDir: "/home/user/.ravi",
      probeSocket: async (socketPath) => socketPath === "/home/user/.ravi/cli-gateway.sock",
    });

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

  it("does not throw when an isolated CLI probes a missing host socket", async () => {
    await expect(
      resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
        stateDir: "/tmp/ravi-missing-host-cli-gateway-state",
      }),
    ).resolves.toBeNull();
  });

  it("treats a throwing socket probe as unreachable instead of crashing the CLI", async () => {
    await expect(
      resolveRemoteGatewayConfig({ RAVI_CONTEXT_KEY: "rctx_test" }, "pages published", {
        stateDir: "/home/user/.ravi",
        probeSocket: async () => {
          throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" });
        },
      }),
    ).resolves.toBeNull();
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

    expect(error).toMatchObject({
      op: "commands list",
      code: "SERVER_UNAVAILABLE",
      exitCode: 1,
      details: { status: 503, retryable: true },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("private upstream response");
  });

  it("preserves a remote PAYLOAD_INVALID issue instead of the generic rejection", () => {
    const error = remoteGatewayErrorToContractError(
      "pages ship",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages ship",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "PAYLOAD_INVALID",
            message: "--html file was not found: ./index.html",
            retryable: false,
            suggestedAction: "correct the command input and retry",
            issues: [{ path: ["html"], code: "invalid", message: "--html file was not found: ./index.html" }],
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "pages ship",
      code: "PAYLOAD_INVALID",
      exitCode: 2,
      message: "html: --html file was not found: ./index.html",
    });
    expect(error?.details.suggestedAction).toBe("Correct the command input and retry");
    expect(JSON.stringify(error?.envelope())).toContain("--html file was not found: ./index.html");
  });

  it("preserves a safe PAYLOAD_INVALID message when the remote omitted issues", () => {
    const error = remoteGatewayErrorToContractError(
      "pages ship",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages ship",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "PAYLOAD_INVALID",
            message: "Missing Console project. Pass --project <project-ref>.",
            retryable: false,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "PAYLOAD_INVALID",
      message: "Missing Console project. Pass --project <project-ref>.",
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("Remote gateway rejected the command input");
  });

  it("projects 400 validation issues into a usage error", () => {
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 400,
        body: JSON.stringify({
          error: "ValidationError",
          issues: [
            { path: ["title"], code: "invalid_type", message: "Expected string, received undefined" },
            { providerBody: "PRIVATE_MESSAGE_8K2R" },
          ],
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "tasks create",
      code: "USAGE_ERROR",
      exitCode: 2,
      message: "title: Expected string, received undefined",
      details: {
        status: 400,
        issues: [{ path: ["title"], code: "invalid_type", message: "Expected string, received undefined" }],
      },
    });
    expect(JSON.stringify(error?.envelope())).toContain("Expected string, received undefined");
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });

  it("projects 422 contract issues without changing the remote taxonomy", () => {
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 422,
        body: JSON.stringify({
          success: false,
          op: "tasks create",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: "COMMAND_FAILED",
            message: "Command could not be completed.",
            retryable: false,
            issues: [{ path: ["instructions"], code: "too_small", message: "Required" }],
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "tasks create",
      code: "COMMAND_FAILED",
      exitCode: 1,
      details: {
        status: 422,
        retryable: false,
        issues: [{ path: ["instructions"], code: "too_small", message: "Required" }],
      },
    });
    expect(error?.envelope()).toMatchObject({
      error: {
        code: "COMMAND_FAILED",
        message: "instructions: Required",
        status: 422,
        issues: [{ path: ["instructions"], code: "too_small", message: "Required" }],
      },
    });
  });

  it("prints HTTP status and issues in text CLI output", () => {
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 400,
        body: JSON.stringify({
          error: "ValidationError",
          issues: [{ path: ["title"], code: "invalid_type", message: "Expected string, received undefined" }],
        }),
      }),
    );
    expect(error).not.toBeNull();
    const lines: string[] = [];
    const originalError = console.error;
    console.error = ((line?: unknown) => {
      lines.push(String(line ?? ""));
    }) as typeof console.error;
    try {
      renderContractError(error!, false);
    } finally {
      console.error = originalError;
    }
    expect(lines).toEqual(["title: Expected string, received undefined", "status: 400"]);
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
    [
      3,
      "blocked",
      "WRITE_REQUIRES_EXECUTE",
      "Dry-run: nothing was written. Re-run with --execute to perform the write.",
    ],
    [3, "blocked", "POLICY_BLOCKED", "Remote command was blocked by policy."],
  ] as const)(
    "projects a complete exit %i/%s response into a safe local contract",
    (exitCode, outcome, code, message) => {
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
      expect(error?.envelope().error.message).toBe(message);
      const serialized = JSON.stringify(error?.envelope());
      expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
      expect(serialized).not.toContain("providerBody");
      expect(serialized).not.toContain("metadata");
    },
  );

  it("tells a remote dry-run to add --execute instead of reporting a policy block", () => {
    // `ravi bug comment <id>` without --execute from an agent session used to print
    // "Remote command was blocked by policy.", hiding the write brake's next step.
    const error = remoteGatewayErrorToContractError(
      "bug comment",
      result({
        status: 409,
        body: JSON.stringify({
          success: false,
          op: "bug comment",
          exitCode: 3,
          outcome: "blocked",
          error: {
            code: "WRITE_REQUIRES_EXECUTE",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
            dryRun: true,
            plan: { textPresent: true },
          },
        }),
      }),
    );

    expect(error?.envelope().error).toMatchObject({
      code: "WRITE_REQUIRES_EXECUTE",
      message: "Dry-run: nothing was written. Re-run with --execute to perform the write.",
      suggestedAction: "Re-run 'bug comment' adding --execute to perform the write",
      dryRun: true,
    });
    expect(error?.exitCode).toBe(3);
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
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
      suggestedAction: "Re-run 'commands list' adding --execute to perform the write",
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

  it.each([
    [MEDIA_SEND_FAILED_CODE, true, MEDIA_SEND_FAILED_MESSAGE, MEDIA_SEND_FAILED_SUGGESTED_ACTION],
    [OMNI_AUTH_FAILED_CODE, false, OMNI_AUTH_FAILED_MESSAGE, OMNI_AUTH_FAILED_SUGGESTED_ACTION],
    [FILE_NOT_FOUND_CODE, false, FILE_NOT_FOUND_MESSAGE, FILE_NOT_FOUND_SUGGESTED_ACTION],
  ] as const)(
    "projects isolated media send %s through the local catalog without remote text",
    (code, retryable, message, suggestedAction) => {
      const error = remoteGatewayErrorToContractError(
        "media send",
        result({
          status: 500,
          body: JSON.stringify({
            success: false,
            op: "media send",
            exitCode: 1,
            outcome: "failed",
            error: {
              code,
              message: "PRIVATE_MESSAGE_8K2R sk-abcdefghijklmnop omni://internal",
              retryable,
              suggestedAction: "PRIVATE_ACTION_8K2R",
            },
          }),
        }),
      );

      expect(error).toMatchObject({
        op: "media send",
        code,
        exitCode: 1,
        message,
        details: { retryable, suggestedAction },
      });
      const serialized = JSON.stringify(error?.envelope());
      expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(serialized).not.toContain("PRIVATE_ACTION_8K2R");
      expect(serialized).not.toContain("sk-abcdefghijklmnop");
      expect(serialized).not.toContain("omni://internal");
    },
  );

  it("keeps generic isolated media send failures as Remote command failed", () => {
    const error = remoteGatewayErrorToContractError(
      "media send",
      result({
        status: 500,
        body: JSON.stringify({
          success: false,
          op: "media send",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: "COMMAND_FAILED",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: true,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "media send",
      code: "COMMAND_FAILED",
      message: "Remote command failed.",
      details: { retryable: true },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });

  it("does not apply the media catalog when a different op reuses a catalog code", () => {
    const error = remoteGatewayErrorToContractError(
      "transcribe file",
      result({
        status: 404,
        body: JSON.stringify({
          success: false,
          op: "transcribe file",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: FILE_NOT_FOUND_CODE,
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "transcribe file",
      code: FILE_NOT_FOUND_CODE,
      message: "Remote command failed.",
    });
    expect(error?.message).not.toBe(FILE_NOT_FOUND_MESSAGE);
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");
  });
});

describe("ravi link failures over the gateway", () => {
  it.each(["CONTACT_REQUIRED", "LINK_DM_UNSUPPORTED", "LINK_DM_FAILED", "AUTH_REQUIRED"] as const)(
    "keeps the local message and next step for %s",
    async (code) => {
      const local = cloudErrorToContractError("identity link", new CloudAuthError(code, "PRIVATE_MESSAGE_8K2R U0LUIS"));
      const response = contractErrorResponse(local);

      const error = remoteGatewayErrorToContractError(
        "identity link",
        result({ status: response.status, body: await response.text() }),
      );

      expect(error).toMatchObject({
        op: "identity link",
        code,
        message: local.message,
        details: { suggestedAction: local.details.suggestedAction },
      });
      expect(error?.message).not.toBe("Remote command failed.");
      const serialized = JSON.stringify(error?.envelope());
      expect(serialized).not.toContain("PRIVATE_MESSAGE_8K2R");
      expect(serialized).not.toContain("U0LUIS");
    },
  );
});

describe("personal connector blocks over the gateway", () => {
  async function relay(op: string, error: CloudAuthError) {
    const local = cloudErrorToContractError(op, error);
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      op,
      result({ status: response.status, body: await response.text() }),
    );
    return { local, remote };
  }

  it("keeps the message, chat line and reply target of a speaker-not-owner block", async () => {
    const chatLine = "I can't use Luis's Gmail for your request.";
    const { local, remote } = await relay(
      "gmail list",
      new CloudAuthError(
        "CONNECTOR_SPEAKER_NOT_OWNER",
        `This message came from someone other than Luis, and personal connections serve only Luis's own requests. Reply in this chat: "${chatLine}"`,
        {
          exitCode: 3,
          details: {
            source: "connector-turn",
            chatLine,
            chatLinePt: "Não posso usar o Gmail do Luis para o seu pedido.",
            replyTo: "same_chat",
          },
        },
      ),
    );

    expect(remote).toMatchObject({
      op: "gmail list",
      code: "CONNECTOR_SPEAKER_NOT_OWNER",
      exitCode: 3,
      message: local.message,
      details: {
        chatLine,
        chatLinePt: "Não posso usar o Gmail do Luis para o seu pedido.",
        replyTo: "same_chat",
        suggestedAction: local.details.suggestedAction,
      },
    });
    expect(remote?.message).not.toBe("Remote command was blocked by policy.");
  });

  it("keeps the group-blocked line for connectors commands", async () => {
    const { local, remote } = await relay(
      "connectors list",
      new CloudAuthError(
        "CONNECTOR_GROUP_BLOCKED",
        'Personal connections are never used in group chats, where other people would read the answer. Reply in the group: "I\'ll send this to you privately." and ask Luis to repeat the request in their direct chat with you.',
        {
          exitCode: 3,
          details: {
            source: "connector-turn",
            chatLine: "I'll send this to you privately.",
            chatLinePt: "Vou te mandar isso no privado.",
            replyTo: "same_chat",
          },
        },
      ),
    );

    expect(remote).toMatchObject({
      code: "CONNECTOR_GROUP_BLOCKED",
      exitCode: 3,
      message: local.message,
      details: { chatLine: "I'll send this to you privately.", replyTo: "same_chat" },
    });
  });

  it("keeps the whole reconnect link for the owner", async () => {
    const link = "https://console.ravi.bot/connectors";
    const { remote } = await relay(
      "gmail list",
      new CloudAuthError(
        "CONNECTOR_REAUTH_REQUIRED",
        'The Gmail connection expired. Tell Luis privately, never in a group: "Your Gmail connection expired. Reconnect: console.ravi.bot/connectors"',
        {
          details: {
            source: "connector-turn",
            chatLine: `Your Gmail connection expired. Reconnect: ${link}`,
            replyTo: "owner_privately",
            reconnectLink: link,
          },
        },
      ),
    );

    expect(remote?.message).toContain("Reconnect: console.ravi.bot/connectors");
    expect(remote?.details).toMatchObject({
      chatLine: `Your Gmail connection expired. Reconnect: ${link}`,
      replyTo: "owner_privately",
      reconnectLink: link,
    });
  });

  it("drops a reconnect link that is not the Console connectors page, and unknown reply targets", () => {
    const body = (error: Record<string, unknown>) =>
      JSON.stringify({
        success: false,
        op: "gmail list",
        exitCode: 1,
        outcome: "failed",
        error: { code: "CONNECTOR_REAUTH_REQUIRED", message: "The connection expired.", retryable: false, ...error },
      });

    for (const reconnectLink of [
      "javascript:alert(1)",
      "http://evil.example/connectors",
      "https://evil.example/connectors?next=https://x",
      "https://user:pw@console.ravi.bot/connectors",
      "https://console.ravi.bot/oauth/callback",
    ]) {
      const remote = remoteGatewayErrorToContractError(
        "gmail list",
        result({ status: 409, body: body({ chatLine: "Reconnect your Gmail.", replyTo: "everyone", reconnectLink }) }),
      );
      expect(remote?.details.reconnectLink).toBeUndefined();
      expect(remote?.details.replyTo).toBeUndefined();
      expect(remote?.details.chatLine).toBe("Reconnect your Gmail.");
    }
  });

  const APPROVAL_ID = "3f2c8a1e-5b6d-4c7e-9f00-1a2b3c4d5e6f";
  const APPROVAL_LINK = `https://console.ravi.bot/connectors/approvals/${APPROVAL_ID}`;

  function approvalAnswer(code: "CONNECTOR_APPROVAL_REQUIRED" | "CONNECTOR_APPROVAL_PENDING") {
    return new CloudAuthError(
      code,
      `Luis must approve this Gmail action first. Send them the link privately, never in a group: "Please approve this Gmail action: console.ravi.bot/connectors/approvals/${APPROVAL_ID}", then run the same command again with --approval ${APPROVAL_ID} once they approve.`,
      {
        exitCode: 3,
        status: 409,
        details: {
          source: "connector-turn",
          chatLine: `Please approve this Gmail action: ${APPROVAL_LINK}`,
          chatLinePt: `Aprove esta ação do Gmail: ${APPROVAL_LINK}`,
          replyTo: "owner_privately",
          approvalId: APPROVAL_ID,
          approvalLink: APPROVAL_LINK,
          retryWith: `--approval ${APPROVAL_ID}`,
          expiresAt: "2026-10-10T12:15:00.000Z",
        },
      },
    );
  }

  it.each(["CONNECTOR_APPROVAL_REQUIRED", "CONNECTOR_APPROVAL_PENDING"] as const)(
    "keeps the approval id, page, expiry and re-run flag of %s",
    async (code) => {
      const { local, remote } = await relay("gmail send", approvalAnswer(code));

      expect(remote).toMatchObject({
        op: "gmail send",
        code,
        exitCode: 3,
        message: local.message,
        details: {
          chatLine: `Please approve this Gmail action: ${APPROVAL_LINK}`,
          replyTo: "owner_privately",
          approvalId: APPROVAL_ID,
          approvalLink: APPROVAL_LINK,
          retryWith: `--approval ${APPROVAL_ID}`,
          expiresAt: "2026-10-10T12:15:00.000Z",
        },
      });
      expect(remote?.envelope().error).toMatchObject({
        approvalId: APPROVAL_ID,
        approvalLink: APPROVAL_LINK,
        retryWith: `--approval ${APPROVAL_ID}`,
        expiresAt: "2026-10-10T12:15:00.000Z",
      });
    },
  );

  it("drops approval details that are not in the shape the daemon builds", () => {
    const body = (error: Record<string, unknown>) =>
      JSON.stringify({
        success: false,
        op: "gmail send",
        exitCode: 3,
        outcome: "blocked",
        error: {
          code: "CONNECTOR_APPROVAL_REQUIRED",
          message: "Luis must approve this Gmail action first.",
          retryable: false,
          chatLine: "Please approve this Gmail action.",
          ...error,
        },
      });
    const relayed = (error: Record<string, unknown>) =>
      remoteGatewayErrorToContractError("gmail send", result({ status: 409, body: body(error) }))?.details;

    for (const approvalLink of [
      `https://console.ravi.bot/connectors/approvals/other-id`,
      `https://console.ravi.bot/connectors/approvals/${APPROVAL_ID}?next=https://x`,
      `https://user:pw@console.ravi.bot/connectors/approvals/${APPROVAL_ID}`,
      `http://evil.example/connectors/approvals/${APPROVAL_ID}`,
      `javascript:alert(1)//connectors/approvals/${APPROVAL_ID}`,
    ]) {
      const details = relayed({ approvalId: APPROVAL_ID, approvalLink, retryWith: "--approval other-id" });
      expect(details?.approvalId).toBe(APPROVAL_ID);
      expect(details?.approvalLink).toBeUndefined();
      expect(details?.retryWith).toBeUndefined();
    }
    expect(relayed({ approvalId: APPROVAL_ID, expiresAt: "soon" })?.expiresAt).toBeUndefined();
    const withoutId = relayed({
      approvalId: "../x",
      approvalLink: "https://console.ravi.bot/connectors/approvals/../x",
      retryWith: "--approval ../x",
      expiresAt: "2026-10-10T12:15:00.000Z",
    });
    expect(withoutId?.approvalId).toBeUndefined();
    expect(withoutId?.approvalLink).toBeUndefined();
    expect(withoutId?.retryWith).toBeUndefined();
    expect(withoutId?.expiresAt).toBeUndefined();
    // A Console under a path prefix keeps its approval page.
    expect(
      relayed({
        approvalId: APPROVAL_ID,
        approvalLink: `http://localhost:3000/console/connectors/approvals/${APPROVAL_ID}`,
      })?.approvalLink,
    ).toBe(`http://localhost:3000/console/connectors/approvals/${APPROVAL_ID}`);
  });

  const CONSENT_TOKEN = "cst_0123456789abcdefXYZ";
  const CONSENT_LINK = `https://console.ravi.bot/connectors/consent/${CONSENT_TOKEN}`;
  const PERSON_ASKING = { consoleUrl: "https://console.ravi.bot", audience: "person_asking" as const, agentId: "main" };

  it("keeps the consent link, its expiry and both chat lines for the person asking (exit 3)", async () => {
    const { local, remote } = await relay(
      "gmail list",
      connectorConsentError(
        new CloudAuthError("CONNECTOR_CONSENT_REQUIRED", "Ravi Link request failed (409): connector_consent_required", {
          status: 409,
          details: { consentRef: CONSENT_TOKEN, expiresAt: "2026-10-10T13:00:00.000Z" },
        }),
        PERSON_ASKING,
      ),
    );

    expect(remote).toMatchObject({
      code: "CONNECTOR_CONSENT_REQUIRED",
      exitCode: 3,
      message: local.message,
      details: {
        chatLine: `To use your Gmail here, approve it once: ${CONSENT_LINK}`,
        chatLinePt: `Para eu usar o seu Gmail aqui, aprove uma vez: ${CONSENT_LINK}`,
        replyTo: "same_chat",
        consentLink: CONSENT_LINK,
        expiresAt: "2026-10-10T13:00:00.000Z",
      },
    });
    expect(remote?.envelope().error).toMatchObject({ consentLink: CONSENT_LINK });
    expect(JSON.stringify(remote?.envelope())).not.toContain("REDACTED");
  });

  it("drops a consent link that is not a Console consent page", () => {
    const relayed = (consentLink: string, code = "CONNECTOR_CONSENT_REQUIRED") =>
      remoteGatewayErrorToContractError(
        "gmail list",
        result({
          status: 409,
          body: JSON.stringify({
            success: false,
            op: "gmail list",
            exitCode: 3,
            outcome: "blocked",
            error: {
              code,
              message: "The person asking has not allowed agent main to use their own Gmail yet.",
              retryable: false,
              chatLine: "To use your Gmail here, approve it once.",
              consentLink,
              expiresAt: "2026-10-10T13:00:00.000Z",
            },
          }),
        }),
      )?.details;

    for (const consentLink of [
      `https://console.ravi.bot/connectors/consent/short`,
      `https://console.ravi.bot/connectors/consent/${CONSENT_TOKEN}?next=https://x`,
      `https://user:pw@console.ravi.bot/connectors/consent/${CONSENT_TOKEN}`,
      `http://evil.example/connectors/consent/${CONSENT_TOKEN}`,
      `javascript:alert(1)//connectors/consent/${CONSENT_TOKEN}`,
      `https://console.ravi.bot/connectors/approvals/${CONSENT_TOKEN}`,
    ]) {
      const details = relayed(consentLink);
      expect(details?.consentLink).toBeUndefined();
      expect(details?.expiresAt).toBeUndefined();
      expect(details?.chatLine).toBe("To use your Gmail here, approve it once.");
    }
    expect(relayed(CONSENT_LINK)?.consentLink).toBe(CONSENT_LINK);
    // Only a consent answer carries a consent link.
    expect(relayed(CONSENT_LINK, "CONNECTOR_SPEAKER_NOT_OWNER")?.consentLink).toBeUndefined();
  });

  it("keeps the ravi link line of a person who has not linked this chat (exit 3)", async () => {
    const error = connectorNotLinkedError({ ...PERSON_ASKING, status: 403 });
    const { local, remote } = await relay("gmail list", error);

    expect(remote).toMatchObject({
      code: "CONNECTOR_NOT_LINKED",
      exitCode: 3,
      message: local.message,
      details: {
        chatLine: error.details?.chatLine,
        chatLinePt: error.details?.chatLinePt,
        replyTo: "same_chat",
      },
    });
    expect(remote?.message).toContain("`ravi link`");
  });

  it("keeps the connect line and the Connectors page for a person with no account connected (exit 3)", async () => {
    const link = "https://console.ravi.bot/connectors";
    const { local, remote } = await relay(
      "gmail send",
      connectorConnectionRequiredError({ ...PERSON_ASKING, status: 409 }),
    );

    expect(local.exitCode).toBe(3);
    expect(remote).toMatchObject({
      code: "CONNECTOR_CONNECTION_REQUIRED",
      exitCode: 3,
      message: local.message,
      details: {
        chatLine: `To use your Gmail here, connect it in Ravi Console first: ${link}`,
        replyTo: "same_chat",
        reconnectLink: link,
      },
    });
  });

  it("uses the catalog copy, not remote text, for connector failures without a chat line", async () => {
    const { remote } = await relay(
      "gmail list",
      new CloudAuthError("CONNECTOR_TOOL_BLOCKED", "PRIVATE_MESSAGE_8K2R", { exitCode: 3 }),
    );

    expect(remote).toMatchObject({
      code: "CONNECTOR_TOOL_BLOCKED",
      message: "The account owner or the organization blocked this tool.",
    });
    expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE_MESSAGE_8K2R");

    const auth = await relay("gmail list", new CloudAuthError("AUTH_REQUIRED", "PRIVATE_MESSAGE_8K2R"));
    expect(auth.remote).toMatchObject({
      code: "AUTH_REQUIRED",
      message: "Console authentication is required.",
      details: { suggestedAction: "run 'ravi login' and retry" },
    });
  });

  it("does not let other commands carry connector chat lines", () => {
    const remote = remoteGatewayErrorToContractError(
      "pages ship",
      result({
        status: 403,
        body: JSON.stringify({
          success: false,
          op: "pages ship",
          exitCode: 3,
          outcome: "blocked",
          error: {
            code: "CONNECTOR_SPEAKER_NOT_OWNER",
            message: "PRIVATE_MESSAGE_8K2R",
            retryable: false,
            chatLine: "PRIVATE_LINE",
          },
        }),
      }),
    );

    expect(remote?.message).toBe("Remote command was blocked by policy.");
    expect(remote?.details.chatLine).toBeUndefined();
  });
});

describe("gateway requirement for runtime context keys", () => {
  it("requires the gateway whenever a context key is present", () => {
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "rctx_test" })).toBe(true);
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "rctx_test", RAVI_HOST_CLI_GATEWAY: "0" })).toBe(true);
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "rctx_test", RAVI_GATEWAY_INTERNAL: "1" })).toBe(true);
    expect(requiresRemoteGateway({ RAVI_CONTEXT_KEY: "  " })).toBe(false);
    expect(requiresRemoteGateway({})).toBe(false);
  });

  it("fails closed with a retryable GATEWAY_REQUIRED contract error", () => {
    const error = gatewayRequiredError("pages published");
    expect(error.code).toBe("GATEWAY_REQUIRED");
    expect(error.exitCode).toBe(1);
    expect(error.details.retryable).toBe(true);
    expect(error.message).not.toContain("rctx_");
  });

  it("probes only the account home, never $HOME", async () => {
    const accountDir = join(userInfo().homedir, ".ravi");
    expect(resolveHostCliGatewayStateDirs({ HOME: "/tmp/agent-controlled" })).toEqual([accountDir]);
    const probed: string[] = [];
    const config = await resolveRemoteGatewayConfig(
      { RAVI_CONTEXT_KEY: "rctx_test", HOME: "/tmp/agent-controlled" },
      "pages published",
      {
        probeSocket: async (socketPath) => {
          probed.push(socketPath);
          return true;
        },
      },
    );
    expect(probed).toEqual([join(accountDir, "cli-gateway.sock")]);
    expect(config?.socketPath).toBe(join(accountDir, "cli-gateway.sock"));
  });

  it("does not reach a socket planted under $HOME when the account home has none", async () => {
    const config = await resolveRemoteGatewayConfig(
      { RAVI_CONTEXT_KEY: "rctx_test", HOME: "/tmp/agent-controlled" },
      "pages published",
      { probeSocket: async (socketPath) => socketPath.startsWith("/tmp/agent-controlled/") },
    );
    expect(config).toBeNull();
  });

  it("keeps RAVI_STATE_DIR as the only socket location when the daemon publishes it", () => {
    expect(resolveHostCliGatewayStateDirs({ RAVI_STATE_DIR: "/srv/ravi-state", HOME: "/tmp/x" })).toEqual([
      "/srv/ravi-state",
    ]);
  });
});
