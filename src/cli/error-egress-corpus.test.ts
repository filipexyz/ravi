import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Command as CommanderCommand } from "commander";
import OpenAI from "openai";
import { buildErrorFromGateway } from "../../packages/ravi-os-sdk/src/errors.js";
import { sendSlackText } from "../channels/slack/text-send.js";
import type { ContextRecord } from "../router/router-db.js";
import { dispatch } from "../sdk/gateway/dispatcher.js";
import { logGatewayFailure } from "../sdk/gateway/diagnostics.js";
import { getSessionTraceBlob, recordSessionBlob, recordSessionEvent } from "../session-trace/session-trace-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { contractFail, renderContractError } from "./agent-contract.js";
import { runWithContext } from "./context.js";
import { Command, CommandAccess, Group, Option } from "./decorators.js";
import { registerCommands } from "./registry.js";
import { mapMediaSendFailure } from "./media-send-auth.js";
import { buildRegistry } from "./registry-snapshot.js";
import { remoteGatewayErrorToContractError } from "./remote-gateway.js";
import { extractTools } from "./tools-export.js";

const OP = "diagnostic corpus fail";
const REASON = "provider returned 401 on POST /v1/x";
const ORIGINAL_CODE = "UPSTREAM_DENIED";
const EXACT_CAUSE =
  "Cannot read audio\nCaused by: EACCES: permission denied, open /tmp/audio.wav; token=[redacted:token]";

interface CorpusVector {
  name: string;
  makeError(): Error;
  expectedCause: string;
  reason: string;
  secrets: string[];
  code?: string;
  surfaceCode?: string;
  status?: number;
  operation?: string;
}

function failure(message: string): Error {
  return Object.assign(new Error(message), { code: ORIGINAL_CODE, status: 401, provider: "fixture" });
}

// Expected causes are literal assertions, never produced by the redactor under test.
const CORPUS: CorpusVector[] = [
  {
    name: "query key",
    makeError: () => failure(`${REASON}; /v1/x?key=QUERY_KEY_SENTINEL_798`),
    expectedCause: `${REASON}; /v1/x?[redacted:url-query]`,
    reason: REASON,
    secrets: ["QUERY_KEY_SENTINEL_798"],
  },
  {
    name: "signed URL",
    makeError: () =>
      failure(`${REASON}; https://provider.test/media?token=SIGNED_TOKEN_798&sig=SIGNED_SIG_798#SIGNED_FRAGMENT_798`),
    expectedCause: `${REASON}; https://provider.test/media?[redacted:url-query]#[redacted:url-fragment]`,
    reason: REASON,
    secrets: ["SIGNED_TOKEN_798", "SIGNED_SIG_798", "SIGNED_FRAGMENT_798"],
  },
  {
    name: "cookie",
    makeError: () => failure(`${REASON}; Cookie: session=COOKIE_SESSION_798; refresh=COOKIE_TAIL_798`),
    expectedCause: `${REASON}; Cookie: [redacted:cookie]`,
    reason: REASON,
    secrets: ["COOKIE_SESSION_798", "COOKIE_TAIL_798"],
  },
  {
    name: "Authorization header",
    makeError: () => failure(`${REASON}; Authorization: Bearer AUTH_BEARER_SENTINEL_798`),
    expectedCause: `${REASON}; Authorization: [redacted:authorization]`,
    reason: REASON,
    secrets: ["AUTH_BEARER_SENTINEL_798"],
  },
  {
    name: "actual APIError body and PII",
    makeError: () =>
      new OpenAI.APIError(
        401,
        {
          code: ORIGINAL_CODE,
          message: `${REASON}; {"email":"private798@example.test","customer":"API_PRIVATE_CUSTOMER_798","token":"API_BODY_SECRET_798"}`,
          body: {
            token: "API_BODY_SECRET_798",
            customer: "API_PRIVATE_CUSTOMER_798",
            email: "private798@example.test",
          },
        },
        undefined,
        new Headers({ "set-cookie": "session=API_COOKIE_SECRET_798" }),
      ),
    expectedCause: `HTTP 401: ${ORIGINAL_CODE}: ${REASON}; [redacted:provider.body]`,
    reason: REASON,
    secrets: ["API_BODY_SECRET_798", "API_PRIVATE_CUSTOMER_798", "private798@example.test", "API_COOKIE_SECRET_798"],
  },
  {
    name: "password tail",
    makeError: () => failure(`${REASON}; password=PASSWORD_HEAD_798#PASSWORD_TAIL_798;PASSWORD_SUFFIX_798`),
    expectedCause: `${REASON}; password=[redacted:password]`,
    reason: REASON,
    secrets: ["PASSWORD_HEAD_798", "PASSWORD_TAIL_798", "PASSWORD_SUFFIX_798"],
  },
  {
    name: "password escaped quote tail",
    makeError: () => failure(`${REASON}; escaped quote; password="ESCAPED_HEAD_798\\"ESCAPED_TAIL_798"`),
    expectedCause: `${REASON}; escaped quote; password=[redacted:password]`,
    reason: REASON,
    secrets: ["ESCAPED_HEAD_798", "ESCAPED_TAIL_798"],
  },
  {
    name: "DSN credentials",
    makeError: () => failure(`${REASON}; postgres://DSN_USER_798:DSN_PASSWORD_798@db.test/ravi`),
    expectedCause: `${REASON}; postgres://[redacted:userinfo]@db.test/ravi`,
    reason: REASON,
    secrets: ["DSN_USER_798", "DSN_PASSWORD_798"],
  },
  {
    name: "path token",
    makeError: () => failure(`${REASON}; /cache/sk-PATH_TOKEN_SENTINEL_798/audio.wav`),
    expectedCause: `${REASON}; /cache/[redacted:credential]/audio.wav`,
    reason: REASON,
    secrets: ["sk-PATH_TOKEN_SENTINEL_798", "PATH_TOKEN_SENTINEL_798"],
  },
  {
    name: "arbitrary exception properties",
    makeError: () =>
      Object.assign(failure(REASON), {
        arbitrary: "ARBITRARY_PROPERTY_798",
        body: "ARBITRARY_BODY_798",
        headers: { private: "ARBITRARY_HEADER_798" },
        context: { operation: OP, status: 401, provider: "fixture", arbitrary: "ARBITRARY_CONTEXT_798" },
      }),
    expectedCause: REASON,
    reason: REASON,
    secrets: ["ARBITRARY_PROPERTY_798", "ARBITRARY_BODY_798", "ARBITRARY_HEADER_798", "ARBITRARY_CONTEXT_798"],
  },
  {
    name: "high entropy base64",
    makeError: () => failure(`${REASON}; Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4Yz5aB6cD7eF8gH9iJ0kL1mN2oP3q`),
    expectedCause: `${REASON}; [redacted:encoded-credential]`,
    reason: REASON,
    secrets: ["Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4Yz5aB6cD7eF8gH9iJ0kL1mN2oP3q"],
  },
  {
    name: "media send real provider failure",
    makeError: () =>
      Object.assign(
        new Error("Omni rejected both invitation attachments: invalid media payload; token=OMNI_INSTANCE_SECRET_798"),
        {
          code: "OMNI_MEDIA_REJECTED",
          status: 422,
          body: { token: "OMNI_BODY_SECRET_798" },
        },
      ),
    expectedCause: "Omni rejected both invitation attachments: invalid media payload; token=[redacted:token]",
    reason: "Omni rejected both invitation attachments: invalid media payload",
    secrets: ["OMNI_INSTANCE_SECRET_798", "OMNI_BODY_SECRET_798"],
    code: "OMNI_MEDIA_REJECTED",
    surfaceCode: "MEDIA_SEND_FAILED",
    status: 422,
    operation: "media send",
  },
  {
    name: "exact original cause positive",
    makeError: () =>
      Object.assign(
        new Error("Cannot read audio", {
          cause: new Error("EACCES: permission denied, open /tmp/audio.wav; token=[redacted:token]"),
        }),
        { code: "EACCES", syscall: "open", path: "/tmp/audio.wav", provider: "fixture", status: 401 },
      ),
    expectedCause: EXACT_CAUSE,
    reason: "EACCES: permission denied, open /tmp/audio.wav",
    secrets: [],
    code: "EACCES",
  },
];

@Group({ name: "diagnostic.corpus", description: "Diagnostic egress corpus fixture", scope: "open" })
class DiagnosticCorpusCommands {
  @Command({ name: "fail", description: "Inject a corpus error" })
  @CommandAccess({ kind: "read", resource: "diagnostic.corpus", action: "fail", risk: "low" })
  fail(
    @Option({ flags: "--vector <vector>", description: "Corpus vector" }) vector: string,
    @Option({ flags: "--json", description: "Print JSON" }) _json?: boolean,
  ): never {
    const row = CORPUS.find((candidate) => candidate.name === vector);
    if (!row) throw new Error("Unknown diagnostic corpus vector");
    if (row.surfaceCode === "MEDIA_SEND_FAILED") {
      const mapped = mapMediaSendFailure(row.makeError(), "omni");
      contractFail(OP, mapped.code, mapped.message, {
        asJson: _json,
        diagnostic: mapped,
        details: { retryable: mapped.retryable, suggestedAction: mapped.suggestedAction },
      });
    }
    throw row.makeError();
  }
}

const principal: ContextRecord = {
  contextId: "ctx_diagnostic_corpus",
  contextKey: "rctx_diagnostic_corpus",
  kind: "test-runtime",
  agentId: "corpus",
  capabilities: [{ permission: "read", objectType: "diagnostic.corpus", objectId: "fail", source: "test" }],
  createdAt: Date.now(),
};
const tool = extractTools([DiagnosticCorpusCommands]).find((entry) => entry.name === "diagnostic_corpus_fail")!;
const command = buildRegistry([DiagnosticCorpusCommands]).commands.find(
  (entry) => entry.fullName === "diagnostic.corpus.fail",
)!;
const REQUIRED_SINKS = [
  "cli",
  "tool",
  "gateway",
  "relay",
  "gateway log",
  "trace row",
  "trace artifact",
  "SDK",
  "Slack chat.postMessage",
];
let stateDir: string;
const previousHostGateway = process.env.RAVI_HOST_CLI_GATEWAY;
beforeAll(async () => {
  stateDir = await createIsolatedRaviState("ravi-error-egress-corpus-");
  process.env.RAVI_HOST_CLI_GATEWAY = "0";
});
afterAll(async () => {
  await cleanupIsolatedRaviState(stateDir);
  if (previousHostGateway === undefined) delete process.env.RAVI_HOST_CLI_GATEWAY;
  else process.env.RAVI_HOST_CLI_GATEWAY = previousHostGateway;
});

function rawCause(error: Error): string {
  return error.message + (error.cause instanceof Error ? `\nCaused by: ${rawCause(error.cause)}` : "");
}

async function collectSinks(vector: CorpusVector): Promise<Record<string, string>> {
  const cliLines: string[] = [];
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExit = process.exit;
  let exitCode: number | undefined;
  console.log = (...args: unknown[]) => cliLines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("__corpus_cli_exit__");
  }) as typeof process.exit;
  try {
    const program = new CommanderCommand();
    program.exitOverride();
    registerCommands(program, [DiagnosticCorpusCommands]);
    await expect(
      runWithContext({}, () =>
        program.parseAsync(["node", "test", "diagnostic", "corpus", "fail", "--vector", vector.name, "--json"]),
      ),
    ).rejects.toThrow("__corpus_cli_exit__");
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }
  expect(exitCode).toBe(1);
  expect(cliLines).toHaveLength(1);
  const cliEnvelope = JSON.parse(cliLines[0]!);
  const toolResult = await runWithContext({ agentId: principal.agentId, context: principal }, () =>
    tool.handler({ vector: vector.name }),
  );
  expect(toolResult.isError).toBe(true);
  const toolEnvelope = JSON.parse(toolResult.content[0]!.text);
  logs.length = 0;
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  });
  let gateway;
  try {
    gateway = await dispatch(command, { vector: vector.name }, {}, { contextRecord: principal, emitAudit: () => {} });
    // Expected 422s do not auto-log. Exercise their diagnostic logging sink explicitly.
    if (vector.surfaceCode === "MEDIA_SEND_FAILED") logGatewayFailure(vector.makeError(), vector.surfaceCode);
  } finally {
    stderr.mockRestore();
  }
  expect(gateway.response.status).toBe(vector.surfaceCode ? 422 : 500);
  const gatewayText = await gateway.response.text();
  const gatewayEnvelope = JSON.parse(gatewayText);
  const relay = remoteGatewayErrorToContractError(OP, {
    status: gateway.response.status,
    ok: false,
    body: gatewayText,
    contentType: "application/json",
  })!;
  const relayLines: string[] = [];
  console.error = (...args: unknown[]) => relayLines.push(args.map(String).join(" "));
  try {
    renderContractError(relay, false);
  } finally {
    console.error = originalError;
  }
  const sdk = buildErrorFromGateway(gateway.response.status, gatewayEnvelope, OP);
  expect(sdk).toMatchObject({
    code: vector.surfaceCode ?? "UNHANDLED_ERROR",
    cause: vector.expectedCause,
    context: { operation: vector.operation ?? OP, code: vector.code ?? ORIGINAL_CODE, status: vector.status ?? 401 },
  });

  for (const envelope of [cliEnvelope, toolEnvelope, gatewayEnvelope, relay.envelope()]) {
    expect(envelope.error.code).toBe(vector.surfaceCode ?? "UNHANDLED_ERROR");
    expect(envelope.error.cause).toBe(vector.expectedCause);
    expect(envelope.error.context).toMatchObject({
      operation: vector.operation ?? OP,
      code: vector.code ?? ORIGINAL_CODE,
      status: vector.status ?? 401,
    });
    expect(envelope.error).not.toHaveProperty("stack");
    expect(envelope.error).not.toHaveProperty("body");
    expect(envelope.error).not.toHaveProperty("headers");
  }

  const original = vector.makeError();
  const unsafePacket = {
    ...original,
    code: vector.code ?? ORIGINAL_CODE,
    message: original.message,
    cause: gatewayEnvelope.error.cause,
    context: {
      operation: vector.operation ?? OP,
      status: vector.status ?? 401,
      provider: "fixture",
      code: vector.code ?? ORIGINAL_CODE,
      ...("context" in original ? (original.context as object) : {}),
    },
  };
  const trace = recordSessionEvent({
    sessionKey: "corpus",
    eventType: "tool.error",
    eventGroup: "tool",
    error: rawCause(original),
    payloadJson: unsafePacket,
  });
  const artifact = recordSessionBlob({ kind: "error", contentJson: unsafePacket });
  const storedArtifact = getSessionTraceBlob(artifact.sha256)!;
  expect(trace.error).toContain(vector.reason);
  if (vector.name === "exact original cause positive") expect(trace.error).toBe(EXACT_CAUSE);
  expect((trace.payloadJson as { cause: string }).cause).toBe(vector.expectedCause);
  expect((storedArtifact.contentJson as { cause: string }).cause).toBe(vector.expectedCause);

  const slackRequests: Array<{ url: string; body: Record<string, string> }> = [];
  await sendSlackText(
    { accountId: "corpus-slack", chatId: "C_CORPUS", text: relayLines.join("\n"), unfurlLinks: false },
    {
      channels: {
        corpus: {
          name: "corpus-slack",
          provider: "slack",
          enabled: true,
          credentialConnection: "corpus-slack",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      resolveSecret: async () => ({ secret: JSON.stringify({ appToken: "xapp-fixture", botToken: "xoxb-fixture" }) }),
      apiBaseUrl: "https://slack.test/api/",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        slackRequests.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(String(init?.body))) });
        return Response.json({ ok: true, channel: "C_CORPUS", ts: "1784000000.000100" });
      }) as typeof fetch,
    },
  );
  expect(slackRequests).toHaveLength(1);
  expect(slackRequests[0]!.url).toBe("https://slack.test/api/chat.postMessage");
  const blocks = JSON.parse(slackRequests[0]!.body.blocks ?? "[]") as Array<{ text?: string }>;
  expect(blocks.map((block) => block.text ?? "").join("\n")).toContain(vector.expectedCause);
  const logLines = logs.filter((line) => line.includes("Gateway command exception"));
  expect(logLines).toHaveLength(1);
  expect(logLines[0]).toContain(vector.expectedCause);
  return {
    cli: JSON.stringify(cliEnvelope),
    tool: JSON.stringify(toolResult),
    gateway: gatewayText,
    relay: JSON.stringify(relay.envelope()) + "\n" + relayLines.join("\n"),
    "gateway log": logLines.join("\n"),
    "trace row": JSON.stringify(trace),
    "trace artifact": JSON.stringify(storedArtifact),
    SDK: JSON.stringify(sdk),
    "Slack chat.postMessage": JSON.stringify(slackRequests[0]!.body),
  };
}

describe("error egress corpus", () => {
  it("covers every required vector exactly once", () => {
    expect(CORPUS.map((row) => row.name).sort()).toEqual(
      [
        "query key",
        "signed URL",
        "cookie",
        "Authorization header",
        "actual APIError body and PII",
        "password tail",
        "password escaped quote tail",
        "DSN credentials",
        "path token",
        "arbitrary exception properties",
        "high entropy base64",
        "media send real provider failure",
        "exact original cause positive",
      ].sort(),
    );
  });
  for (const vector of CORPUS) {
    it(`${vector.name}: preserves original cause and excludes secrets at every sink`, async () => {
      const sinks = await collectSinks(vector);
      expect(Object.keys(sinks).sort()).toEqual([...REQUIRED_SINKS].sort());
      for (const sink of REQUIRED_SINKS) {
        expect(sinks[sink], `${vector.name}: ${sink} retains the reason`).toContain(vector.reason);
        for (const secret of vector.secrets)
          expect(sinks[sink], `${vector.name}: ${sink} leaks ${secret}`).not.toContain(secret);
      }
    });
  }
});
