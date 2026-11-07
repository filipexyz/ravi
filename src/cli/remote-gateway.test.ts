import { errorDiagnostic } from "../utils/error-diagnostic.js";
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
import { ContractError } from "./agent-contract.js";
import { presentationProfile, withPresentationContract } from "./library-contract.js";
import { LibraryCommandError } from "../library/service.js";
import {
  RUNTIME_CONTROL_DISABLED,
  RUNTIME_CONTROL_DISABLED_REASON,
  RUNTIME_CONTROL_TIMEOUT,
  runtimeControlCatalogCopy,
} from "../runtime/runtime-control-errors.js";
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
  remoteNextStepLine,
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
  it.each([true, false])(
    "bounds remote cause after redaction including denial fallback (explicit cause: %s)",
    (withCause) => {
      const source = ["provider returned 401; token=RELAY_BOUNDARY_SECRET", ...Array(5).fill("a".repeat(1000))].join(
        "\n",
      );
      const error = remoteGatewayErrorToContractError(
        "commands list",
        result({
          status: 403,
          body: JSON.stringify({
            success: false,
            op: "commands list",
            exitCode: 1,
            outcome: "denied",
            error: {
              code: "PERMISSION_DENIED",
              message: withCause ? "provider denied access" : source,
              ...(withCause ? { cause: source } : {}),
              retryable: false,
              context: { provider: "fixture", file: source },
            },
          }),
        }),
      );
      expect(error).not.toBeNull();
      if (!error) throw new Error("Expected projected denial");
      const cause = error.details.cause as string;
      expect(cause).toStartWith("provider returned 401; token=[redacted:token]");
      expect(cause).toEndWith(" [truncated]");
      expect(cause.length).toBeLessThanOrEqual(4096);
      expect((error.details.context as { file: string }).file.length).toBeLessThanOrEqual(4096);
      expect(JSON.stringify(error?.envelope())).not.toContain("RELAY_BOUNDARY_SECRET");
    },
  );

  it("preserves projected denial context when the remote response has no cause", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({
        status: 403,
        body: JSON.stringify({
          success: false,
          op: "commands list",
          exitCode: 1,
          outcome: "denied",
          error: {
            code: "PERMISSION_DENIED",
            message: "provider denied access",
            retryable: false,
            context: {
              provider: "fixture",
              model: "audio-1",
              actor: { type: "agent", id: "reader" },
              body: "PRIVATE_BODY",
            },
          },
        }),
      }),
    );
    expect(error?.details.cause).toBe("provider denied access");
    expect(error?.details.context).toEqual({
      operation: "commands list",
      status: 403,
      provider: "fixture",
      model: "audio-1",
      actor: { type: "agent", id: "reader" },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_BODY");
  });

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
        body: JSON.stringify({
          error: "PermissionDenied",
          reason: "Permission denied: executable ffmpeg is blocked; api_key=opaque",
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "commands list",
      code: "PERMISSION_DENIED",
      exitCode: 1,
      message: "Permission denied: executable ffmpeg is blocked; api_key=[redacted:api_key]",
    });
    expect(error?.envelope()).toMatchObject({ success: false, error: { code: "PERMISSION_DENIED" } });
    expect(JSON.stringify(error?.envelope())).not.toContain("opaque");
  });

  it("preserves transcription cause and diagnostic context through gateway and remote CLI", async () => {
    const local = new ContractError("transcribe file", "TRANSCRIBE_FAILED", "Audio transcription failed.", 1, {
      ...errorDiagnostic("Audio transcription failed.", { operation: "transcribe file" }),
      ...{
        cause: "HTTP 429: quota exhausted; api_key=fixture-token",
        context: {
          operation: "transcribe file",
          provider: "openai",
          model: "whisper-1",
          status: 429,
          file: "/tmp/voice.mp3",
          code: "insufficient_quota",
          ...{ authorization: "fixture-token" },
        },
      },
    });
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      "transcribe file",
      result({ status: response.status, body: await response.text() }),
    );
    expect(remote?.details.cause).toBe("HTTP 429: quota exhausted; api_key=[redacted:api_key]");
    expect(remote?.details.context).toEqual({
      operation: "transcribe file",
      provider: "openai",
      model: "whisper-1",
      status: 429,
      file: "/tmp/voice.mp3",
      code: "insufficient_quota",
    });
    expect(JSON.stringify(remote?.envelope())).not.toContain("fixture-token");
  });

  it("redacts malformed remote failures without encouraging retries of an uncertain write", () => {
    const error = remoteGatewayErrorToContractError(
      "commands list",
      result({ status: 503, contentType: "text/plain", body: "private upstream response" }),
    );

    expect(error).toMatchObject({
      op: "commands list",
      code: "SERVER_UNAVAILABLE",
      exitCode: 1,
      details: { status: 503, retryable: false },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("private upstream response");
  });

  it("relays the Pages domain setup instruction and steps instead of the generic failure", () => {
    const message = [
      "Pages domain setup was saved but is not ready yet.",
      "",
      "nba-ui.rbbt.page (step 2 of 3: DNS): Add or keep these records.",
      "CNAME nba-ui.rbbt.page = cname.ravi.page",
    ].join("\n");
    const error = remoteGatewayErrorToContractError(
      "pages domains",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages domains",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: "DOMAIN_SETUP_REQUIRED",
            message,
            retryable: false,
            suggestedAction: "complete the displayed DNS action, wait for propagation, then rerun the same command",
            domainSetup: [
              {
                hostname: "nba-ui.rbbt.page",
                state: "pages_pending",
                steps: [
                  { id: "ownership", status: "done", dnsRecords: [] },
                  {
                    id: "dns",
                    status: "pending",
                    dnsRecords: [{ type: "CNAME", name: "nba-ui.rbbt.page", value: "cname.ravi.page" }],
                  },
                  { id: "certificate", status: "pending", dnsRecords: [] },
                ],
                note: "PRIVATE_REMOTE_TEXT",
              },
            ],
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "DOMAIN_SETUP_REQUIRED",
      exitCode: 1,
      message,
      details: {
        suggestedAction: "complete the displayed DNS action, wait for propagation, then rerun the same command",
        domainSetup: [{ hostname: "nba-ui.rbbt.page", currentStep: { id: "dns", number: 2, total: 3 } }],
      },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_REMOTE_TEXT");
  });

  it("preserves the cause for DOMAIN_SETUP_REQUIRED outside pages domains", () => {
    const error = remoteGatewayErrorToContractError(
      "pages ship",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages ship",
          exitCode: 1,
          outcome: "failed",
          error: { code: "DOMAIN_SETUP_REQUIRED", message: "Domain is not configured", retryable: false },
        }),
      }),
    );

    expect(error?.message).toBe("Domain is not configured");
  });

  it("shows the DNS to add on a pages domains dry-run through the gateway", () => {
    const error = remoteGatewayErrorToContractError(
      "pages domains",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages domains",
          exitCode: 3,
          outcome: "blocked",
          error: {
            code: "WRITE_REQUIRES_EXECUTE",
            message: "Dry-run: nothing was written. Re-run with --execute to perform the write.",
            retryable: false,
            dryRun: true,
            suggestedAction: "Re-run 'pages domains' adding --execute to perform the write",
            plan: {
              site: "briefing",
              hostnameCount: 2,
              dnsSetup: [
                { hostname: "nba.rbbt.page", dnsRecords: [] },
                { hostname: "bad host; rm -rf", dnsRecords: [] },
              ],
            },
          },
        }),
      }),
    );

    expect(error?.exitCode).toBe(3);
    expect(error?.message).toContain("CNAME nba.rbbt.page = cname.ravi.page");
    expect(error?.message).toContain("Global host: CNAME *.<domain> = cname.ravi.page");
    expect(error?.message).not.toContain("rm -rf");
    expect(error?.details.plan).toMatchObject({
      site: "briefing",
      dnsSetup: [
        { hostname: "nba.rbbt.page", dnsRecords: [{ type: "CNAME", name: "nba.rbbt.page", value: "cname.ravi.page" }] },
      ],
    });
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
    expect(error?.details.suggestedAction).toBe("correct the command input and retry");
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

  it("shows which task profile inputs are missing instead of the generic rejection", () => {
    const message = "Missing required input(s) for task profile input-contract: goal. Pass them with --input goal=...";
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "tasks create",
          exitCode: 2,
          outcome: "usage_error",
          error: { code: "USAGE_ERROR", message, retryable: false },
        }),
      }),
    );

    expect(error).toMatchObject({ op: "tasks create", code: "USAGE_ERROR", exitCode: 2, message });
  });

  it("preserves an issue-less permission profile failure and its inspection command", () => {
    const message =
      "No capabilities found for this profile. Provide --capabilities <permission>:<objectType>:<objectId> to create or bootstrap it.";
    const suggestedAction = "Inspect built-in profiles with 'ravi skills show permissions'.";
    const error = remoteGatewayErrorToContractError(
      "permissions allow",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "permissions allow",
          exitCode: 2,
          outcome: "usage_error",
          error: { code: "USAGE_ERROR", message, suggestedAction, retryable: false },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "permissions allow",
      code: "USAGE_ERROR",
      exitCode: 2,
      message,
      details: { status: 400, suggestedAction },
    });
    expect(error?.envelope().error.message).toBe(message);
  });

  it("preserves a safe legacy validation message without issues", () => {
    const message = "Profile is unknown. Run 'ravi skills show permissions' to inspect built-in profiles.";
    const error = remoteGatewayErrorToContractError(
      "permissions allow",
      result({ status: 400, body: JSON.stringify({ error: "ValidationError", message }) }),
    );
    expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2, message });
  });

  it("preserves profile discovery controls across a complete local and remote usage-error envelope", () => {
    const acceptedValues = [
      "bootstrap",
      "chat-only",
      "explicit-only",
      "full-access",
      ...Array.from({ length: 501 }, (_, index) => `permission-profile-${index}`),
    ];
    const inspectCommands = [
      "ravi skills show permissions",
      "ravi tags list --kind system --source permissions --json",
    ];
    const message =
      "Unknown or empty permission profile: permission-missing. Available profiles: bootstrap, chat-only, explicit-only, full-access, ... .";
    const local = new ContractError("permissions allow", "USAGE_ERROR", message, 2, {
      ...errorDiagnostic("Unknown permission profile", { operation: "permissions allow" }),
      acceptedValues,
      inspectCommands,
    });
    expect(local.envelope().error.inspectCommands).toEqual(inspectCommands);
    const remote = remoteGatewayErrorToContractError(
      "permissions allow",
      result({
        status: 422,
        body: JSON.stringify({ ...local.envelope(), exitCode: 2, outcome: "usage_error" }),
      }),
    );
    expect(remote?.details.acceptedValues).toEqual(acceptedValues);
    expect(remote?.details.inspectCommands).toEqual(inspectCommands);
    expect(remote?.details.acceptedValuesTruncated).toBeUndefined();
    expect(remote?.envelope().error.inspectCommands).toEqual(inspectCommands);
  });

  it("bounds and validates remote profile discovery without relaying commands or credential-shaped values", () => {
    const safeValues = Array.from({ length: 513 }, (_, index) => `permission-profile-${index}`);
    const error = remoteGatewayErrorToContractError(
      "permissions allow",
      result({
        status: 422,
        body: JSON.stringify({
          success: false,
          op: "permissions allow",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "USAGE_ERROR",
            message: "Unknown profile.",
            retryable: false,
            acceptedValues: [
              null,
              {},
              4,
              "bad value",
              "x".repeat(129),
              "ctx_fixture",
              "rctx_fixture",
              "PRIVATE_PROFILE",
              ...safeValues,
            ],
            inspectCommands: [
              "ravi skills show permissions",
              "ravi tags list --kind system --source permissions --json",
              "ravi permissions allow full-access --apply",
              "ravi skills show permissions; echo unsafe",
              "ravi skills show permissions\nprivate",
              { command: "ravi skills show permissions" },
            ],
          },
        }),
      }),
    );
    expect(error?.details.acceptedValues).toEqual(safeValues.slice(0, 512));
    expect(error?.details.acceptedValuesTruncated).toBe(true);
    expect(error?.envelope().error.acceptedValuesTruncated).toBe(true);
    expect(error?.details.inspectCommands).toEqual([
      "ravi skills show permissions",
      "ravi tags list --kind system --source permissions --json",
    ]);
    const relayed = remoteGatewayErrorToContractError(
      "permissions allow",
      result({
        status: 422,
        body: JSON.stringify({ ...error!.envelope(), exitCode: 2, outcome: "usage_error" }),
      }),
    );
    expect(relayed?.details.acceptedValues).toEqual(safeValues.slice(0, 512));
    expect(relayed?.details.acceptedValuesTruncated).toBe(true);
    const encoded = JSON.stringify(error?.envelope());
    for (const forbidden of ["ctx_fixture", "PRIVATE_PROFILE", "full-access --apply", "echo unsafe", "private"])
      expect(encoded).not.toContain(forbidden);
  });

  it.each([null, "bootstrap", {}, [null, {}, 3, "bad value"]])(
    "drops malformed profile discovery controls: %j",
    (value) => {
      const error = remoteGatewayErrorToContractError(
        "permissions allow",
        result({
          status: 422,
          body: JSON.stringify({
            success: false,
            op: "permissions allow",
            exitCode: 2,
            outcome: "usage_error",
            error: {
              code: "USAGE_ERROR",
              message: "Unknown profile.",
              retryable: false,
              acceptedValues: value,
              inspectCommands: value,
              acceptedValuesTruncated: true,
            },
          }),
        }),
      );
      expect(error?.details.acceptedValues).toBeUndefined();
      expect(error?.details.inspectCommands).toBeUndefined();
      expect(error?.details.acceptedValuesTruncated).toBeUndefined();
    },
  );

  it("preserves the bounded generated permission-profile diagnostic", () => {
    const message =
      "Unknown or empty permission profile: permission-missing. Available profiles: bootstrap, chat-only, explicit-only, full-access, permission-read:tasks-list. Inspect built-ins with 'ravi skills show permissions' and stored profiles with 'ravi tags list --kind system --source permissions --json'. Provide --capabilities <permission>:<objectType>:<objectId> to bootstrap a custom profile.";
    const error = remoteGatewayErrorToContractError(
      "permissions allow",
      result({
        status: 422,
        body: JSON.stringify({
          success: false,
          op: "permissions allow",
          exitCode: 2,
          outcome: "usage_error",
          error: { code: "USAGE_ERROR", message, retryable: false },
        }),
      }),
    );
    expect(error?.message).toBe(message);
  });

  it("redacts secret-bearing unknown keys while retaining ordinary field names", () => {
    const secretKey = "password-hunter2";
    const error = remoteGatewayErrorToContractError(
      "permissions allow",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "permissions allow",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "USAGE_ERROR",
            message: "Invalid command input.",
            issues: [
              {
                path: [],
                code: "unrecognized_keys",
                keys: [secretKey, "json", "subjects"],
                message: "Unknown fields.",
              },
            ],
            retryable: false,
          },
        }),
      }),
    );
    expect(error).toMatchObject({
      code: "USAGE_ERROR",
      exitCode: 2,
      message: "Unknown field.",
      details: {
        issues: [
          { path: ["<unknown>"], code: "unrecognized_keys", message: "Unknown field." },
          { path: ["json"], code: "unrecognized_keys", message: "Unknown field." },
          { path: ["subjects"], code: "unrecognized_keys", message: "Unknown field." },
        ],
      },
    });
    expect(JSON.stringify(error?.envelope())).not.toContain(secretKey);
  });

  it.each([
    "No capabilities found: token=unstructured-secret",
    "No capabilities found for rctx_secret_fixture",
    "No capabilities found for ctx_secret_fixture",
    "No capabilities found: PRIVATE_PROVIDER_BODY_8K2R",
    "Profile is unknown.\nPRIVATE_PROVIDER_BODY_8K2R",
  ])("does not relay unsafe issue-less validation copy: %s", (message) => {
    const error = remoteGatewayErrorToContractError(
      "permissions allow",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "permissions allow",
          exitCode: 2,
          outcome: "usage_error",
          error: { code: "USAGE_ERROR", message, suggestedAction: message, retryable: false },
        }),
      }),
    );
    expect(error?.message).toBe("Remote gateway rejected the command input.");
    expect(JSON.stringify(error?.envelope())).not.toContain(message);
  });

  it("preserves a missing task profile error from the gateway", () => {
    const message = "private profile catalog /runtime/path";
    const error = remoteGatewayErrorToContractError(
      "tasks create",
      result({
        status: 422,
        body: JSON.stringify({
          success: false,
          op: "tasks create",
          exitCode: 1,
          outcome: "failed",
          error: { code: "TASK_PROFILE_NOT_FOUND", message, retryable: false },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "tasks create",
      code: "TASK_PROFILE_NOT_FOUND",
      exitCode: 1,
      message: "Task profile was not found in this runtime.",
    });
    expect(error?.details.suggestedAction).toContain("ravi tasks profiles list --json");
    expect(JSON.stringify(error?.envelope())).not.toContain(message);
  });

  it("does not apply the task profile copy to other commands", () => {
    const error = remoteGatewayErrorToContractError(
      "demo echo",
      result({
        status: 422,
        body: JSON.stringify({
          success: false,
          op: "demo echo",
          exitCode: 1,
          outcome: "failed",
          error: { code: "TASK_PROFILE_NOT_FOUND", message: "Profile lookup failed.", retryable: false },
        }),
      }),
    );
    expect(error?.message).toBe("Profile lookup failed.");
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
    expect(lines).toEqual(["title: Expected string, received undefined", "operation: tasks create", "status: 400"]);
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
    [1, "failed", "COMMAND_FAILED", "Command refused; token=[redacted:token]"],
    [1, "denied", "PERMISSION_DENIED", "Command refused; token=[redacted:token]"],
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
              message: "Command refused; token=opaque",
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
      expect(serialized).not.toContain("opaque");
      expect(serialized).not.toContain("SENTINEL_SECRET_7M4Q");
      expect(serialized).not.toContain("providerBody");
      expect(serialized).not.toContain("metadata");
    },
  );

  it("preserves the canonical capability and denial metadata of a remote denial", () => {
    const error = remoteGatewayErrorToContractError(
      "pages published",
      result({
        status: 403,
        body: JSON.stringify({
          success: false,
          op: "pages published",
          exitCode: 1,
          outcome: "denied",
          error: {
            code: "PERMISSION_DENIED",
            message:
              "Permission denied: agent:main cannot execute pages published\nMissing capability: read:pages:list\nInspect: ravi permissions status",
            retryable: false,
            stage: "command_access",
            denialId: 42,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "PERMISSION_DENIED",
      exitCode: 1,
      details: {
        status: 403,
        authorizationDecision: "denied",
        capability: "read:pages:list",
        stage: "command_access",
        denialId: 42,
      },
    });
    expect(error?.envelope().error.message).toContain("agent:main cannot execute pages published");
    expect(error?.details.cause).toContain("Missing capability: read:pages:list");
  });

  it("preserves a denial reason even without a capability", () => {
    const error = remoteGatewayErrorToContractError(
      "pages published",
      result({
        status: 403,
        body: JSON.stringify({
          success: false,
          op: "pages published",
          exitCode: 1,
          outcome: "denied",
          error: {
            code: "PERMISSION_DENIED",
            message: "Policy rejected the operation; token=DENIAL_TOKEN_798",
            retryable: false,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "PERMISSION_DENIED",
      details: { status: 403, authorizationDecision: "denied" },
    });
    expect(error?.details.capability).toBeUndefined();
    const serialized = JSON.stringify(error?.envelope());
    expect(error?.details.cause).toBe("Policy rejected the operation; token=[redacted:token]");
    expect(serialized).not.toContain("DENIAL_TOKEN_798");
  });

  it("drops a remote capability field that is not a canonical capability", () => {
    const error = remoteGatewayErrorToContractError(
      "pages published",
      result({
        status: 403,
        body: JSON.stringify({
          success: false,
          op: "pages published",
          exitCode: 1,
          outcome: "denied",
          error: {
            code: "PERMISSION_DENIED",
            message: "denied",
            retryable: false,
            capability: "read pages list with PRIVATE_TEXT",
          },
        }),
      }),
    );

    expect(error?.details.capability).toBeUndefined();
    expect(JSON.stringify(error?.envelope())).not.toContain("PRIVATE_TEXT");
  });

  it("keeps an argument error as a 400 usage_error instead of a permission denial", () => {
    const error = remoteGatewayErrorToContractError(
      "pages published",
      result({
        status: 400,
        body: JSON.stringify({
          success: false,
          op: "pages published",
          exitCode: 2,
          outcome: "usage_error",
          error: {
            code: "USAGE_ERROR",
            message: "limit must be a string",
            retryable: false,
            issues: [{ path: ["limit"], code: "invalid_type", message: "Expected string" }],
          },
        }),
      }),
    );

    expect(error).toMatchObject({ code: "USAGE_ERROR", exitCode: 2, details: { status: 400 } });
    expect(error?.details.authorizationDecision).toBeUndefined();
    expect(error?.details.issues).toMatchObject([{ path: ["limit"] }]);
  });

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
        op: "pr publish",
        plan: {
          repo: "owner/repo",
          base: "dev",
          head: "fix/publish",
          localSha: "a".repeat(40),
          treeSha: "b".repeat(40),
          remoteSha: null,
          commitCount: 2,
          objectCount: 6,
          uploadBytes: 1024,
          refAction: "create",
          prAction: "create",
          prNumber: null,
          replySession: "publisher",
          followAction: "reconcile",
        },
      },
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

  it("keeps publication recovery evidence through the gateway while stripping unrelated content", () => {
    const partial = {
      publicationId: `prpub_${"a".repeat(24)}`,
      attemptId: "10000000-0000-4000-8000-000000000001",
      phase: "follow",
      repo: "owner/repo",
      head: "fix/publish",
      localSha: "a".repeat(40),
      refPublished: true,
      prNumber: 42,
      uncertain: true,
    };
    const error = remoteGatewayErrorToContractError(
      "pr publish",
      result({
        status: 500,
        body: JSON.stringify({
          success: false,
          op: "pr publish",
          exitCode: 1,
          outcome: "failed",
          error: {
            code: "PR_PUBLICATION_INCOMPLETE",
            message: "SECRET REMOTE TEXT",
            retryable: true,
            partial: { ...partial, body: "SECRET BODY" },
            token: "SECRET TOKEN",
          },
        }),
      }),
    );
    expect(error?.envelope().error).toMatchObject({ code: "PR_PUBLICATION_INCOMPLETE", partial });
    expect(JSON.stringify(error?.envelope())).not.toContain("SECRET");
  });

  it.each([
    [MEDIA_SEND_FAILED_CODE, true, MEDIA_SEND_FAILED_MESSAGE, MEDIA_SEND_FAILED_SUGGESTED_ACTION],
    [OMNI_AUTH_FAILED_CODE, false, OMNI_AUTH_FAILED_MESSAGE, OMNI_AUTH_FAILED_SUGGESTED_ACTION],
    [FILE_NOT_FOUND_CODE, false, FILE_NOT_FOUND_MESSAGE, FILE_NOT_FOUND_SUGGESTED_ACTION],
  ] as const)(
    "preserves media send %s cause with local catalog headline and redacted credential",
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
              cause: "Omni rejected upload: unsupported media format; api_key=MEDIA_RELAY_SECRET_798",
              context: { operation: "media send", provider: "omni", code: "UNSUPPORTED_MEDIA", status: 415 },
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
      expect(serialized).not.toContain("MEDIA_RELAY_SECRET_798");
      expect(error?.details.cause).toBe("Omni rejected upload: unsupported media format; api_key=[redacted:api_key]");
      expect(error?.details.context).toMatchObject({ provider: "omni", code: "UNSUPPORTED_MEDIA", status: 415 });
    },
  );

  it("preserves unknown media failure causes", () => {
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
            message: "Remote media service timed out",
            retryable: true,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "media send",
      code: "COMMAND_FAILED",
      message: "Remote media service timed out",
      details: { retryable: true },
    });
    expect(error?.message).toBe("Remote media service timed out");
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
            message: "Audio file /tmp/audio.wav was not found",
            retryable: false,
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      op: "transcribe file",
      code: FILE_NOT_FOUND_CODE,
      message: "Audio file /tmp/audio.wav was not found",
    });
    expect(error?.message).not.toBe(FILE_NOT_FOUND_MESSAGE);
    expect(error?.message).toContain("/tmp/audio.wav");
  });
});

describe("ravi link failures over the gateway", () => {
  it.each([
    ["CONTACT_REQUIRED", "ravi link needs the current chat message to come from a known person (a resolved contact)."],
    ["LINK_DM_UNSUPPORTED", "Ravi cannot send a private message to this person on this channel."],
    ["LINK_DM_FAILED", "Ravi could not send the private message to the person who asked."],
    ["AUTH_REQUIRED", "Console authentication is required."],
  ] as const)("keeps the local message and next step for %s", async (code, reason) => {
    const local = cloudErrorToContractError(
      "identity link",
      new CloudAuthError(code, "Identity service rejected the link request; token=LINK_RELAY_SECRET_798"),
    );
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
    expect(error?.details.cause).toBe(`${reason}\nCaused by: [redacted:provider.body]`);
    expect(serialized).not.toContain("LINK_RELAY_SECRET_798");
  });
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

  it("rebuilds the 'message me in private' copy for a write refused for a person with no link", async () => {
    const { local, remote } = await relay(
      "pages ship",
      new CloudAuthError("ACTOR_NOT_LINKED", "remote text is never relayed", {
        status: 403,
        details: { linkFlow: "awaiting_dm" },
      }),
    );

    expect(local.exitCode).toBe(3);
    expect(local.message).toContain("message you in private");
    expect(remote).toMatchObject({
      op: "pages ship",
      code: "ACTOR_NOT_LINKED",
      exitCode: 3,
      message: local.message,
      details: { linkFlow: "awaiting_dm", chatLinePt: local.details.chatLinePt },
    });
    expect(String(remote?.details.chatLinePt)).toContain("Me chama na DM");
  });

  it("keeps the group-blocked line for connectors commands", async () => {
    const { local, remote } = await relay(
      "connectors list",
      new CloudAuthError(
        "CONNECTOR_GROUP_BLOCKED",
        "This message came from someone other than Luis, and personal connections serve only Luis's own requests. Reply in this chat: \"I can't use Luis's Gmail for your request.\"",
        {
          exitCode: 3,
          details: {
            source: "connector-turn",
            chatLine: "I can't use Luis's Gmail for your request.",
            chatLinePt: "Não posso usar o Gmail do Luis para o seu pedido.",
            replyTo: "same_chat",
          },
        },
      ),
    );

    expect(remote).toMatchObject({
      code: "CONNECTOR_GROUP_BLOCKED",
      exitCode: 3,
      message: local.message,
      details: { chatLine: "I can't use Luis's Gmail for your request.", replyTo: "same_chat" },
    });
  });

  it("keeps the whole reconnect link for the owner", async () => {
    const link = "https://console.ravi.bot/connectors";
    const { remote } = await relay(
      "gmail list",
      new CloudAuthError(
        "CONNECTOR_REAUTH_REQUIRED",
        'The Gmail connection expired. Tell Luis: "Your Gmail connection expired. Reconnect: console.ravi.bot/connectors"',
        {
          details: {
            source: "connector-turn",
            chatLine: `Your Gmail connection expired. Reconnect: ${link}`,
            replyTo: "same_chat",
            reconnectLink: link,
          },
        },
      ),
    );

    expect(remote?.message).toContain("Reconnect: console.ravi.bot/connectors");
    expect(remote?.details).toMatchObject({
      chatLine: `Your Gmail connection expired. Reconnect: ${link}`,
      replyTo: "same_chat",
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
          replyTo: "same_chat",
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
          replyTo: "same_chat",
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

  it("uses the catalog headline while preserving connector failure cause without credentials", async () => {
    const { remote } = await relay(
      "gmail list",
      new CloudAuthError(
        "CONNECTOR_TOOL_BLOCKED",
        "Connector policy blocked the tool; token=CONNECTOR_RELAY_SECRET_798",
        { exitCode: 3 },
      ),
    );

    expect(remote).toMatchObject({
      code: "CONNECTOR_TOOL_BLOCKED",
      message: "The account owner or the organization blocked this tool.",
    });
    expect(remote?.details.cause).toBe(
      "The account owner or the organization blocked this tool.\nCaused by: [redacted:provider.body]",
    );
    expect(JSON.stringify(remote?.envelope())).not.toContain("CONNECTOR_RELAY_SECRET_798");

    const auth = await relay(
      "gmail list",
      new CloudAuthError("AUTH_REQUIRED", "Console rejected the credential; token=AUTH_RELAY_SECRET_798"),
    );
    expect(auth.remote).toMatchObject({
      code: "AUTH_REQUIRED",
      message: "Console authentication is required.",
      details: { suggestedAction: "run 'ravi login' and retry" },
    });
    expect(auth.remote?.details.cause).toBe("Console authentication is required.\nCaused by: [redacted:provider.body]");
    expect(JSON.stringify(auth.remote?.envelope())).not.toContain("AUTH_RELAY_SECRET_798");
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

describe("Library refusals over the gateway", () => {
  async function relay(op: string, thrown: unknown) {
    const local = await withPresentationContract(op, presentationProfile("widget"), true, async () => {
      throw thrown;
    }).catch((error: unknown) => error as ContractError);
    expect(local).toBeInstanceOf(ContractError);
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      op,
      result({ status: response.status, body: await response.text() }),
    );
    return { local, remote };
  }

  it("keeps the code, message, conflict and next step of a Console conflict", async () => {
    const { local, remote } = await relay(
      "widgets propose",
      new CloudAuthError("CONFLICT", "Slug taken.", { status: 409, details: { reason: "slug_taken_in_project" } }),
    );
    expect(remote).toMatchObject({
      code: "CONFLICT",
      exitCode: 1,
      message: "A project already has a Library widget with this slug.",
      details: { conflict: "slug_taken_in_project", suggestedAction: "Pick another slug with --slug" },
    });
    expect(remote?.message).toBe(local.message);
    expect(remote?.details.suggestedAction).not.toContain("Inspect redacted remote logs");
    expect(remoteNextStepLine(remote!)).toContain("Next: Pick another slug with --slug");
  });

  it("keeps which item a slug conflict is about (ref, scope, project, archived)", async () => {
    const { remote } = await relay(
      "widgets propose",
      new CloudAuthError("CONFLICT", "Slug taken.", {
        status: 409,
        details: {
          reason: "slug_taken_in_project",
          conflict: "slug_taken_in_project",
          ref: "painel/pedido-card",
          scope: "project",
          project: "painel",
          archived: true,
        },
      }),
    );
    expect(remote).toMatchObject({
      code: "CONFLICT",
      message:
        "A project already has a Library widget with this slug (painel/pedido-card, archived: its slug stays taken).",
      details: {
        conflict: "slug_taken_in_project",
        ref: "painel/pedido-card",
        scope: "project",
        project: "painel",
        archived: true,
      },
    });
  });

  it("keeps the versions of a stale_base conflict", async () => {
    const { remote } = await relay(
      "widgets propose",
      new CloudAuthError("CONFLICT", "Stale.", {
        status: 409,
        details: { reason: "stale_base", conflict: "stale_base", currentVersion: 3, baseVersion: 2 },
      }),
    );
    expect(remote).toMatchObject({
      code: "CONFLICT",
      details: { conflict: "stale_base", currentVersion: 3, baseVersion: 2 },
    });
    expect(remote?.message).toBe("The published version changed after the plan was read.");
  });

  it("keeps the Console's own words for a conflict reason this side has no copy for", async () => {
    const { remote } = await relay(
      "widgets propose",
      new CloudAuthError("CONFLICT", "Org proposals from agents need a reviewer group.", {
        status: 422,
        details: { reason: "no_reviewers" },
      }),
    );
    expect(remote).toMatchObject({
      code: "CONFLICT",
      message: "Org proposals from agents need a reviewer group.",
      details: { conflict: "no_reviewers" },
    });
  });

  it("keeps an out-of-view refusal (exit 3) with the session's view instead of a generic policy line", async () => {
    const message =
      "Library widget 'outro/card' belongs to project 'outro', which is not this agent's Console project. This session sees org acme and project painel (from agent_default); use --scope painel or --scope org.";
    const { remote } = await relay(
      "widgets propose",
      new LibraryCommandError("LIBRARY_OUT_OF_VIEW", message, 3, {
        view: { organization: "acme", project: "painel", source: "agent_default" },
        suggestedAction: "Use --scope painel or --scope org",
      }),
    );
    expect(remote).toMatchObject({
      code: "LIBRARY_OUT_OF_VIEW",
      exitCode: 3,
      message,
      details: {
        view: { organization: "acme", project: "painel", source: "agent_default" },
        suggestedAction: "Use --scope painel or --scope org",
      },
    });
    expect(remote?.message).not.toBe("Remote command was blocked by policy.");
    // The next step already travels as an issue, so text mode does not print it twice.
    expect(remoteNextStepLine(remote!)).toContain(String(remote?.details.requestId));
  });

  it("preserves diagnostic copy from other commands", async () => {
    const local = new ContractError("transcribe file", "CONFLICT", "Audio resource is locked", 1, {
      ...errorDiagnostic("Audio resource is locked", { operation: "transcribe file" }),
      ...{
        suggestedAction: "Retry after unlocking the resource",
      },
    });
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      "transcribe file",
      result({ status: response.status, body: await response.text() }),
    );
    expect(remote?.message).toBe("Audio resource is locked");
    expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE");
    expect(remoteNextStepLine(remote!)).toContain(String(remote?.details.requestId));
  });
});

describe("pages read refusals over the gateway", () => {
  it("keeps the public-only refusal and the turn rule that decided it", async () => {
    const message =
      "https://acme.ravi.page/weekly is not public. Private Ravi Pages are read only on the operator's own turns (terminal, their direct chat, their routines). This turn is not the operator's own: the owner's direct chat runs in a session other people's chats share (dmScope main, a route that names the session, or another chat attached to it).";
    const local = new ContractError("pages read", "PAGE_ACCESS_DENIED", message, 3, {
      ...errorDiagnostic(message, { operation: "pages read" }),
      ...{
        reason: "public_only",
        turn: "shared_session",
        suggestedAction: "Tell the person you cannot open this private Page for them.",
      },
    });
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      "pages read",
      result({ status: response.status, body: await response.text() }),
    );
    expect(remote).toMatchObject({
      code: "PAGE_ACCESS_DENIED",
      exitCode: 3,
      details: {
        turn: "shared_session",
        suggestedAction: "Tell the person you cannot open this private Page for them.",
      },
    });
    // The relay sanitizes the message again (the URL reads as a path); the rule that decided stays.
    expect(remote?.message).toContain("This turn is not the operator's own: the owner's direct chat runs in a session");
    expect(remote?.message).not.toBe("Remote command was blocked by policy.");
  });
});

describe("operator-only refusals over the gateway", () => {
  const chatLine = "Ask me in our private chat and I'll check the calendar there.";

  it("keeps the agenda refusal and the line that sends the operator to their own chat", async () => {
    const message =
      "The calendar is used only on the operator's own turns (terminal, their direct chat, their routines). This turn is not the operator's own: the answer would go to a group, where everyone in it would read it.";
    const local = new ContractError("agenda list", "CALENDAR_ACCESS_DENIED", message, 3, {
      ...errorDiagnostic(message, { operation: "agenda list" }),
      ...{
        refusal: "operator_only",
        turn: "group",
        suggestedAction: `The operator asked in a group. Reply here with the chat line: "${chatLine}"`,
        chatLine,
        chatLinePt: "Me peça no nosso chat privado que eu vejo a agenda lá.",
        replyTo: "same_chat",
      },
    });
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      "agenda list",
      result({ status: response.status, body: await response.text() }),
    );
    expect(remote).toMatchObject({
      code: "CALENDAR_ACCESS_DENIED",
      exitCode: 3,
      message,
      details: {
        refusal: "operator_only",
        turn: "group",
        suggestedAction: `The operator asked in a group. Reply here with the chat line: "${chatLine}"`,
        chatLine,
        chatLinePt: "Me peça no nosso chat privado que eu vejo a agenda lá.",
        replyTo: "same_chat",
      },
    });
    expect(remoteNextStepLine(remote!)).toContain(
      `Next: The operator asked in a group. Reply here with the chat line: "${chatLine}"`,
    );
  });

  it("keeps the meetings read refusal for someone else's turn", async () => {
    const message =
      "Meeting transcripts are read only on the operator's own turns (terminal, their direct chat, their routines). This turn is not the operator's own: this turn answers into a group or a chat that is not the owner's direct chat.";
    const local = new ContractError("meetings read", "MEETING_ACCESS_DENIED", message, 3, {
      ...errorDiagnostic(message, { operation: "meetings read" }),
      ...{
        refusal: "operator_only",
        turn: "group",
        suggestedAction: "Tell the person you cannot read meeting transcripts for other people.",
      },
    });
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      "meetings read",
      result({ status: response.status, body: await response.text() }),
    );
    expect(remote).toMatchObject({
      code: "MEETING_ACCESS_DENIED",
      message,
      details: {
        refusal: "operator_only",
        turn: "group",
        suggestedAction: "Tell the person you cannot read meeting transcripts for other people.",
      },
    });
    expect(remote?.details.chatLine).toBeUndefined();
  });

  it("does not relay the refusal copy for the same code on another command", async () => {
    const local = new ContractError(
      "transcribe file",
      "MEETING_ACCESS_DENIED",
      "Access policy rejected transcription; token=PRIVATE_POLICY_TOKEN_798",
      3,
      {
        ...errorDiagnostic("Access policy rejected transcription; token=PRIVATE_POLICY_TOKEN_798", {
          operation: "transcribe file",
        }),
        ...{
          suggestedAction: "PRIVATE_ACTION",
        },
      },
    );
    const response = contractErrorResponse(local);
    const remote = remoteGatewayErrorToContractError(
      "transcribe file",
      result({ status: response.status, body: await response.text() }),
    );
    expect(remote?.message).toBe("Remote command was blocked by policy.");
    expect(remote?.details.cause).toBe("Access policy rejected transcription; token=[redacted:token]");
    expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE");
  });
});

describe("sessions runtime remote relay", () => {
  async function relay(op: string, local: ContractError) {
    const response = contractErrorResponse(local);
    return remoteGatewayErrorToContractError(op, result({ status: response.status, body: await response.text() }));
  }

  it("relays a disabled steer with catalog copy and typed details instead of Remote command failed", async () => {
    const remote = await relay(
      "sessions runtime steer",
      new ContractError(
        "sessions runtime steer",
        RUNTIME_CONTROL_DISABLED,
        "Runtime provider does not support turn steering; token=PRIVATE_RUNTIME_TOKEN_798",
        1,
        {
          ...errorDiagnostic("Runtime provider does not support turn steering; token=PRIVATE_RUNTIME_TOKEN_798", {
            operation: "sessions runtime steer",
          }),
          ...{
            retryable: false,
            suggestedAction: "PRIVATE_ACTION_8K2R",
            operation: "turn.steer",
            sessionName: "session-private-name",
            activeTurn: true,
            turnId: "turn_123",
            disabledReason: RUNTIME_CONTROL_DISABLED_REASON,
          },
        },
      ),
    );

    const catalog = runtimeControlCatalogCopy(RUNTIME_CONTROL_DISABLED);
    expect(remote).toMatchObject({
      op: "sessions runtime steer",
      code: RUNTIME_CONTROL_DISABLED,
      exitCode: 1,
      message: catalog?.message,
      details: {
        retryable: false,
        suggestedAction: catalog?.suggestedAction,
        operation: "turn.steer",
        activeTurn: true,
        turnId: "turn_123",
        disabledReason: RUNTIME_CONTROL_DISABLED_REASON,
      },
    });
    const serialized = JSON.stringify(remote?.envelope());
    expect(remote?.details.cause).toBe("Runtime provider does not support turn steering; token=[redacted:token]");
    expect(serialized).not.toContain("PRIVATE_RUNTIME_TOKEN_798");
    expect(serialized).not.toContain("PRIVATE_ACTION_8K2R");
    expect(serialized).not.toContain("session-private-name");
  });

  it("keeps the timeout retryable and drops unbounded details", async () => {
    const remote = await relay(
      "sessions runtime read",
      new ContractError(
        "sessions runtime read",
        RUNTIME_CONTROL_TIMEOUT,
        "Runtime read exceeded its deadline; token=PRIVATE_TIMEOUT_TOKEN_798",
        1,
        {
          ...errorDiagnostic("Runtime read exceeded its deadline; token=PRIVATE_TIMEOUT_TOKEN_798", {
            operation: "sessions runtime read",
          }),
          ...{
            retryable: true,
            suggestedAction: "PRIVATE_ACTION_8K2R",
            operation: "thread.read",
            turnId: "turn with spaces and PRIVATE_8K2R",
            disabledReason: "PRIVATE_REASON_8K2R",
          },
        },
      ),
    );

    expect(remote).toMatchObject({
      code: RUNTIME_CONTROL_TIMEOUT,
      message: runtimeControlCatalogCopy(RUNTIME_CONTROL_TIMEOUT)?.message,
      details: { retryable: true },
    });
    expect(remote?.details.turnId).toBeUndefined();
    expect(remote?.details.disabledReason).toBeUndefined();
    expect(remote?.details.cause).toBe("Runtime read exceeded its deadline; token=[redacted:token]");
    expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE");
  });

  it("does not mark a timed-out rollback retryable", async () => {
    const remote = await relay(
      "sessions runtime rollback",
      new ContractError("sessions runtime rollback", RUNTIME_CONTROL_TIMEOUT, "x", 1, {
        ...errorDiagnostic("x", { operation: "sessions runtime rollback" }),
        ...{
          retryable: true,
          operation: "thread.rollback",
        },
      }),
    );

    expect(remote).toMatchObject({ code: RUNTIME_CONTROL_TIMEOUT, details: { retryable: false } });
  });

  it("renders missing sessions for info and orphan-close without leaking names", async () => {
    for (const op of ["sessions info", "sessions close-thread"]) {
      const remote = await relay(
        op,
        new ContractError(op, "SESSION_NOT_FOUND", "private-session-8k2r", 1, {
          ...errorDiagnostic("private-session-8k2r", { operation: op }),
          ...{},
        }),
      );
      expect(remote?.message).toBe("Session not found, or not visible to this context.");
      expect(JSON.stringify(remote?.envelope())).not.toContain("private-session-8k2r");
    }
  });

  it("renders SESSION_NOT_FOUND without echoing the requested session", async () => {
    const remote = await relay(
      "sessions runtime steer",
      new ContractError("sessions runtime steer", "SESSION_NOT_FOUND", "Session not found: private-session-8k2r", 1, {
        ...errorDiagnostic("Session not found: private-session-8k2r", { operation: "sessions runtime steer" }),
        ...{
          suggestedAction: "List visible sessions with: ravi sessions list --json",
        },
      }),
    );

    expect(remote).toMatchObject({
      code: "SESSION_NOT_FOUND",
      message: "Session not found, or not visible to this context.",
    });
    expect(JSON.stringify(remote?.envelope())).not.toContain("private-session-8k2r");
  });

  it("does not apply the runtime catalog to other ops", async () => {
    const remote = await relay(
      "media send",
      new ContractError("media send", RUNTIME_CONTROL_DISABLED, "PRIVATE_8K2R", 1, {
        ...errorDiagnostic("PRIVATE_8K2R", { operation: "media send" }),
        ...{ suggestedAction: "x" },
      }),
    );

    expect(remote?.message).toBe("PRIVATE_8K2R");
  });
});

describe("thread command remote relay", () => {
  async function relay(op: string, local: ContractError) {
    const response = contractErrorResponse(local);
    return remoteGatewayErrorToContractError(op, result({ status: response.status, body: await response.text() }));
  }

  it("returns a creation failure for an incompatible model instead of generic remote text", async () => {
    const remote = await relay(
      "sessions create-thread",
      new ContractError(
        "sessions create-thread",
        "THREAD_MODEL_INVALID",
        "Provider rejected the configured model; token=PRIVATE_MODEL_TOKEN_798",
        1,
        {
          ...errorDiagnostic("Provider rejected the configured model; token=PRIVATE_MODEL_TOKEN_798", {
            operation: "sessions create-thread",
          }),
          ...{},
        },
      ),
    );
    expect(remote?.message).toContain("Thread was not created");
    expect(remote?.details.suggestedAction).toContain("--provider codex");
    expect(remote?.details.cause).toBe("Provider rejected the configured model; token=[redacted:token]");
    expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE_MODEL_TOKEN_798");
  });

  it("relays a report outside a thread with local copy instead of Remote command failed", async () => {
    const remote = await relay(
      "sessions report",
      new ContractError(
        "sessions report",
        "THREAD_NOT_THREAD_CHILD",
        "Session is not bound to a thread; token=PRIVATE_THREAD_TOKEN_798",
        1,
        {
          ...errorDiagnostic("Session is not bound to a thread; token=PRIVATE_THREAD_TOKEN_798", {
            operation: "sessions report",
          }),
          ...{
            suggestedAction: "PRIVATE_ACTION_8K2R",
          },
        },
      ),
    );
    expect(remote).toMatchObject({
      code: "THREAD_NOT_THREAD_CHILD",
      exitCode: 1,
      message: "This command is available only inside a Slack thread child session.",
      details: { suggestedAction: "Run it from the Slack thread's own session, or pass --session <thread session>" },
    });
    expect(remote?.details.cause).toBe("Session is not bound to a thread; token=[redacted:token]");
    expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE");
  });

  it("relays the identity mismatch and a missing thread session for close-thread and thread-send", async () => {
    const mismatch = await relay(
      "sessions close-thread",
      new ContractError(
        "sessions close-thread",
        "THREAD_IDENTITY_MISMATCH",
        "Thread request and session identities differ; token=PRIVATE_IDENTITY_TOKEN_798",
        1,
        {
          ...errorDiagnostic("Thread request and session identities differ; token=PRIVATE_IDENTITY_TOKEN_798", {
            operation: "sessions close-thread",
          }),
          ...{},
        },
      ),
    );
    expect(mismatch?.message).toContain("lost its session");
    const missing = await relay(
      "sessions thread-send",
      new ContractError(
        "sessions thread-send",
        "THREAD_SESSION_MISSING",
        "Thread child session is unavailable; token=PRIVATE_IDENTITY_TOKEN_798",
        1,
        {
          ...errorDiagnostic("Thread child session is unavailable; token=PRIVATE_IDENTITY_TOKEN_798", {
            operation: "sessions thread-send",
          }),
          ...{},
        },
      ),
    );
    expect(missing?.message).toBe("The Slack thread's session no longer exists.");
    expect(mismatch?.details.cause).toBe("Thread request and session identities differ; token=[redacted:token]");
    expect(missing?.details.cause).toBe("Thread child session is unavailable; token=[redacted:token]");
    expect(JSON.stringify([mismatch?.envelope(), missing?.envelope()])).not.toContain("PRIVATE");
  });

  it("relays the task dispatch thread identity conflict", async () => {
    const remote = await relay(
      "tasks dispatch",
      new ContractError(
        "tasks dispatch",
        "TASK_SESSION_THREAD_IDENTITY_CONFLICT",
        "Dispatch target conflicts with the thread session identity; token=PRIVATE_IDENTITY_TOKEN_798",
        1,
        {
          ...errorDiagnostic(
            "Dispatch target conflicts with the thread session identity; token=PRIVATE_IDENTITY_TOKEN_798",
            { operation: "tasks dispatch" },
          ),
          ...{},
        },
      ),
    );
    expect(remote?.message).toContain("open Slack thread");
    expect(remote?.details.suggestedAction).toContain("--session");
    expect(remote?.details.cause).toBe(
      "Dispatch target conflicts with the thread session identity; token=[redacted:token]",
    );
    expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE");
  });

  it("relays active trigger IDs and repoint guidance without forwarding arbitrary remote text", async () => {
    const remote = await relay(
      "sessions close-thread",
      new ContractError(
        "sessions close-thread",
        "THREAD_TRIGGERS_PENDING",
        "Active triggers prevent thread closure; token=PRIVATE_TRIGGER_TOKEN_798",
        1,
        {
          ...errorDiagnostic("Active triggers prevent thread closure; token=PRIVATE_TRIGGER_TOKEN_798", {
            operation: "sessions close-thread",
          }),
          ...{
            triggerIds: ["abcd1234", "bad;command", "1234abcd"],
            suggestedAction: "PRIVATE_ACTION",
          },
        },
      ),
    );
    expect(remote?.code).toBe("THREAD_TRIGGERS_PENDING");
    expect(remote?.details.triggerIds).toEqual(["abcd1234", "1234abcd"]);
    expect(remote?.details.suggestedAction).toContain("abcd1234, 1234abcd");
    expect(remote?.details.suggestedAction).toContain("ravi triggers set <id> replySession <parent-session>");
    expect(remote?.details.cause).toBe("Active triggers prevent thread closure; token=[redacted:token]");
    expect(JSON.stringify(remote?.envelope())).not.toMatch(/PRIVATE|bad;command/);
  });

  it("relays decision errors and pending closure with safe local guidance", async () => {
    for (const [op, code, copy] of [
      ["decisions answer", "DECISION_SELF_ANSWER", "waiting worker"],
      ["decisions retry", "DECISION_DELIVERY_UNCERTAIN", "uncertain"],
      ["sessions close-thread", "THREAD_DECISIONS_PENDING", "open decisions"],
    ]) {
      const remote = await relay(
        op!,
        new ContractError(op!, code!, "Decision policy rejected the transition; token=PRIVATE_DECISION_TOKEN_798", 1, {
          ...errorDiagnostic("Decision policy rejected the transition; token=PRIVATE_DECISION_TOKEN_798", {
            operation: op!,
          }),
          ...{},
        }),
      );
      expect(remote?.message).toContain(copy!);
      expect(remote?.details.cause).toBe("Decision policy rejected the transition; token=[redacted:token]");
      expect(JSON.stringify(remote?.envelope())).not.toContain("PRIVATE");
    }
  });

  it("preserves the cause for unknown codes, prototype keys and other commands", async () => {
    for (const [op, code] of [
      ["sessions report", "COMMAND_FAILED"],
      ["sessions report", "toString"],
      ["sessions list", "THREAD_NOT_THREAD_CHILD"],
    ] as const) {
      const remote = await relay(
        op,
        new ContractError(op, code, "PRIVATE_8K2R", 1, {
          ...errorDiagnostic("PRIVATE_8K2R", { operation: op }),
          ...{},
        }),
      );
      if (code === "toString") expect(remote?.message).toContain("without a valid error envelope");
      else expect(remote?.message).toBe("PRIVATE_8K2R");
      expect(remote?.message).not.toContain("Remote command failed");
    }
  });
});
