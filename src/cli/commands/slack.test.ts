/**
 * Slack CLI tests.
 *
 * 1. "Slack CLI Canvas helpers": pure helper behavior (pre-existing suite).
 * 2. "slack agent-first contract" (Manual v2): write brake (exit 3,
 *    WRITE_REQUIRES_EXECUTE) on every externally visible Slack mutation BEFORE
 *    any Slack Web API call, not-found envelopes (CHANNEL_NOT_FOUND /
 *    MESSAGE_NOT_FOUND / ARTIFACT_NOT_FOUND, exit 1) with suggestions from
 *    cheap local sources, and compact `--fields` mode. Follows the
 *    group.test.ts pattern: no-op decorator mocks + Slack client mock with
 *    spies + `hasContext: () => true` so the contract helpers throw
 *    ContractError instead of exiting the process.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { fileURLToPath } from "node:url";

afterAll(() => {
  mock.restore();
});

// Any real, readable file works as the "JSON payload" fixture because the
// Block Kit / Work Object parsers are mocked below; only readFileSync runs.
const jsonFixturePath = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------
// Spies and mutable fixtures
// ---------------------------------------------------------------------------

const clientCalls: Array<{ method: string; args: unknown }> = [];
const credentialResolutionCalls: Array<{ action?: string; channel?: string }> = [];
const replayEnvelopes: Array<Record<string, unknown>> = [];
const interactionResponses: Array<Record<string, unknown>> = [];
const createdArtifacts: Array<Record<string, unknown>> = [];
const schemaInitializingArtifactCalls: string[] = [];
const commandAccessMetadata = new Map<string, { redactions?: string[] }>();

let conversationsListResult: Record<string, unknown> = { ok: true, channels: [] };
let conversationsHistoryResult: Record<string, unknown> = { ok: true, messages: [] };
let filesListResult: Record<string, unknown> = { ok: true, files: [] };
let credentialsAvailable = true;
let credentialConnectionConfigured = true;
let clientConstructionCount = 0;

function recordClientCall<T extends Record<string, unknown>>(method: string, args: unknown, result: T): T {
  clientCalls.push({ method, args });
  return result;
}

function callsTo(method: string): Array<{ method: string; args: unknown }> {
  return clientCalls.filter((call) => call.method === method);
}

// ---------------------------------------------------------------------------
// Module mocks (must be installed before importing the module under test)
// ---------------------------------------------------------------------------

mock.module("../decorators.js", () => ({
  Group: () => () => {},
  Command: () => () => {},
  CommandAccess: (options: { redactions?: string[] }) => (_target: object, propertyKey: string) => {
    commandAccessMetadata.set(propertyKey, options);
  },
  Scope: () => () => {},
  CliOnly: () => () => {},
  Returns: Object.assign(() => () => {}, { binary: () => () => {} }),
  Arg: () => () => {},
  Option: () => () => {},
}));

mock.module("../context.js", () => ({
  getContext: () => undefined,
  // Real hasContext checks RAVI_* envs; the contract helpers use it to throw
  // ContractError instead of process.exit, which is what tests need.
  hasContext: () => true,
  fail: (message: string) => {
    throw new Error(message);
  },
}));

mock.module("../../config-store.js", () => ({
  configStore: {
    getConfig: () => ({
      channels: {
        main: {
          enabled: true,
          provider: "slack",
          name: "ravi-slack",
          ...(credentialConnectionConfigured ? { credentialConnection: "ravi-slack-secret" } : {}),
        },
        dev: {
          enabled: true,
          provider: "slack",
          name: "ravi-slack-dev",
          credentialConnection: "ravi-slack-dev-secret",
        },
        zap: { enabled: true, provider: "whatsapp", name: "zap" },
      },
    }),
  },
}));

mock.module("../../channels/slack/credentials.js", () => ({
  resolveSlackCredentialConfigFromEnv: async (
    _env: NodeJS.ProcessEnv,
    options?: { action?: string; channel?: { name?: string; credentialConnection?: string } },
  ) => {
    credentialResolutionCalls.push({
      ...(options?.action ? { action: options.action } : {}),
      ...(options?.channel?.name ? { channel: options.channel.name } : {}),
    });
    if (!credentialsAvailable || !options?.channel?.credentialConnection) return null;
    const name = options?.channel?.name ?? "ravi-slack";
    return {
      appToken: "xapp-test",
      botToken: "xoxb-test",
      accountId: name,
      routeAccountId: name,
      channel: name,
      instanceId: name,
      connection: name,
      source: "broker" as const,
    };
  },
}));

mock.module("../../channels/slack/client.js", () => ({
  SlackWebApiClient: class SlackWebApiClient {
    constructor() {
      clientConstructionCount += 1;
    }

    async authTest() {
      return recordClientCall("authTest", {}, { ok: true, scopes: ["chat:write"] });
    }
    async conversationsList(args: Record<string, unknown>) {
      return recordClientCall("conversationsList", args, conversationsListResult);
    }
    async conversationsInfo(args: Record<string, unknown>) {
      return recordClientCall("conversationsInfo", args, { ok: true, channel: { id: args.channel } });
    }
    async conversationsHistory(args: Record<string, unknown>) {
      return recordClientCall("conversationsHistory", args, conversationsHistoryResult);
    }
    async conversationsMembers(args: Record<string, unknown>) {
      return recordClientCall("conversationsMembers", args, { ok: true, members: [] });
    }
    async conversationsCreate(args: Record<string, unknown>) {
      return recordClientCall("conversationsCreate", args, { ok: true, channel: { id: "C_NEW", name: args.name } });
    }
    async conversationsRename(args: Record<string, unknown>) {
      return recordClientCall("conversationsRename", args, {
        ok: true,
        channel: { id: args.channel, name: args.name },
      });
    }
    async conversationsInvite(args: Record<string, unknown>) {
      return recordClientCall("conversationsInvite", args, { ok: true, channel: { id: args.channel } });
    }
    async conversationsCanvasesCreate(args: Record<string, unknown>) {
      return recordClientCall("conversationsCanvasesCreate", args, { ok: true, canvas_id: "F_NEW" });
    }
    async filesList(args: Record<string, unknown>) {
      return recordClientCall("filesList", args, filesListResult);
    }
    async blocksValidate(args: Record<string, unknown>) {
      return recordClientCall("blocksValidate", args, { ok: true });
    }
    async postMessage(args: Record<string, unknown>) {
      return recordClientCall("postMessage", args, {
        ok: true,
        channel: args.channel,
        ts: "111.222",
        raw: { ok: true },
      });
    }
    async postEphemeral(args: Record<string, unknown>) {
      return recordClientCall("postEphemeral", args, {
        ok: true,
        channel: args.channel,
        ts: "111.223",
        raw: { ok: true },
      });
    }
    async updateMessage(args: Record<string, unknown>) {
      return recordClientCall("updateMessage", args, {
        ok: true,
        channel: args.channel,
        ts: args.ts,
        raw: { ok: true },
      });
    }
    async viewsOpen(args: Record<string, unknown>) {
      return recordClientCall("viewsOpen", args, { ok: true, view: { id: "V1", hash: "h1" } });
    }
    async viewsUpdate(args: Record<string, unknown>) {
      return recordClientCall("viewsUpdate", args, { ok: true, view: { id: "V1", hash: "h2" } });
    }
    async viewsPush(args: Record<string, unknown>) {
      return recordClientCall("viewsPush", args, { ok: true, view: { id: "V2", hash: "h1" } });
    }
    async unfurl(args: Record<string, unknown>) {
      return recordClientCall("unfurl", args, { ok: true });
    }
    async entityPresentDetails(args: Record<string, unknown>) {
      return recordClientCall("entityPresentDetails", args, { ok: true });
    }
    async canvasesCreate(args: Record<string, unknown>) {
      return recordClientCall("canvasesCreate", args, { ok: true, canvas_id: "F_NEW", canvas: null });
    }
    async canvasesEdit(args: Record<string, unknown>) {
      return recordClientCall("canvasesEdit", args, { ok: true, canvas: { id: args.canvasId } });
    }
    async canvasesSectionsLookup(args: Record<string, unknown>) {
      return recordClientCall("canvasesSectionsLookup", args, { ok: true, sections: [] });
    }
    async canvasesAccessSet(args: Record<string, unknown>) {
      return recordClientCall("canvasesAccessSet", args, { ok: true });
    }
    async canvasesAccessDelete(args: Record<string, unknown>) {
      return recordClientCall("canvasesAccessDelete", args, { ok: true });
    }
    async canvasesDelete(args: Record<string, unknown>) {
      return recordClientCall("canvasesDelete", args, { ok: true });
    }
  },
}));

mock.module("../../channels/slack/socket-mode.js", () => ({
  SlackSocketModeService: class SlackSocketModeService {
    async handleEnvelope(envelope: Record<string, unknown>) {
      replayEnvelopes.push(envelope);
      return "processed";
    }
  },
}));

mock.module("../../channels/slack/interactions.js", () => ({
  respondToSlackInteraction: async (input: Record<string, unknown>) => {
    interactionResponses.push(input);
    return { ok: true };
  },
}));

mock.module("../../channels/slack/topology.js", () => ({
  buildSlackTopology: () => ({
    ok: true as const,
    provider: "slack" as const,
    accountId: "ravi-slack",
    channels: [],
    ungroupedChannelIds: [],
    capabilities: {},
  }),
}));

mock.module("../../channels/slack/block-kit.js", () => ({
  parseSlackBlockKitJson: () => ({ mocked: true }),
  normalizeSlackBlockKitMessagePayload: (_payload: unknown, text?: string) => ({
    text: text ?? "fallback text",
    blocks: [{ type: "section" }],
  }),
  normalizeSlackBlockKitValidationPayload: (_payload: unknown, target?: string) => ({
    target: target?.trim() || "message",
    message: {},
    blocks: [],
    view: { type: "modal" },
  }),
  buildSlackBlockKitShowcasePayload: () => ({ text: "showcase", blocks: [{ type: "section" }] }),
}));

mock.module("../../channels/slack/work-objects.js", () => ({
  normalizeSlackNativeWorkObjectMessagePayload: (_payload: unknown, text?: string) => ({
    text: text ?? "work object",
    metadata: { event_type: "ravi_work_object", event_payload: {} },
  }),
  normalizeSlackNativeWorkObjectMetadata: (metadata: Record<string, unknown>) => metadata,
  normalizeSlackNativeWorkObjectDetailMetadata: (metadata: Record<string, unknown>) => metadata,
  normalizeSlackNativeWorkObjectUnfurlPayload: (_payload: unknown, url: string) => ({
    metadata: { event_type: "ravi_work_object", event_payload: {} },
    unfurls: { [url]: {} },
  }),
}));

mock.module("../../contacts.js", () => ({
  getContact: () => null,
  getContactDetails: () => null,
}));

mock.module("../../router/router-db.js", () => ({
  dbCreateContext: () => null,
  dbFindChat: () => null,
  dbFindChatMessage: () => null,
  dbGetAgent: () => null,
  dbGetContext: () => null,
  dbGetContextByKey: () => null,
  dbGetContextByKeyReadOnly: () => null,
  dbListContexts: () => [],
  dbRevokeContextCascade: () => null,
  dbTouchContext: () => null,
  dbUpdateAgent: () => null,
  dbUpdateContextRuntimeState: () => null,
  getDb: () => {
    throw new Error("router DB is not available in Slack command unit tests");
  },
  getRaviDbPath: () => "",
}));

mock.module("../../artifacts/store.js", () => ({
  getArtifactDetails: () => {
    schemaInitializingArtifactCalls.push("getArtifactDetails");
    return null;
  },
  getArtifactVersion: () => {
    schemaInitializingArtifactCalls.push("getArtifactVersion");
    return null;
  },
  inspectArtifactPublishStateReadOnly: (id: string) => {
    const known = id === "art_canvas_runbook";
    const artifact = known
      ? {
          id,
          kind: "slack.canvas.markdown",
          title: "Runbook",
          status: "active",
          output: "# Canvas runbook",
          tags: [],
          createdAt: 1,
          updatedAt: 1,
        }
      : null;
    return {
      artifactExists: known,
      versionExists: null,
      artifact,
      version: null,
      publishedEvents: [],
      candidates: ["art_canvas_runbook", "art_canvas_status"],
    };
  },
  listArtifacts: () => [
    { id: "art_canvas_runbook", kind: "slack.canvas.markdown" },
    { id: "art_canvas_status", kind: "slack.canvas.markdown" },
  ],
  createArtifact: (input: Record<string, unknown>) => {
    createdArtifacts.push(input);
    return { id: "art_new_1", kind: "slack.canvas.markdown", title: input.title ?? null };
  },
  createArtifactVersion: () => ({ id: "artv_1", versionNumber: 1 }),
  updateArtifact: () => ({ id: "art_new_1", kind: "slack.canvas.markdown" }),
  appendArtifactEvent: () => {},
  attachArtifact: () => {},
}));

const slackModule = await import("./slack.js");
const {
  SlackCommands,
  buildSlackCanvasArtifactPublishMetadata,
  buildSlackCanvasShowcaseMarkdown,
  buildSlackCanvasEditChange,
  extractSlackCanvasArtifactPublishState,
  extractSlackCanvasIdFromConversationInfo,
  hashSlackCanvasMarkdown,
  isSlackCanvasArtifactId,
  parseSlackCanvasAccessTargets,
  redactSlackPrivateMetadata,
  resolveSlackCanvasMarkdownInput,
  slackViewMutationItem,
  validateSlackCanvasAccessLevelTargets,
} = slackModule;
const { ContractError } = await import("../agent-contract.js");
const { redactCommandAccessInput } = await import("../command-access.js");

type ContractErrorInstance = InstanceType<typeof ContractError>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function silenced<T>(run: () => Promise<T> | T): Promise<T> {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<ContractErrorInstance> {
  let caught: unknown;
  await silenced(async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as ContractErrorInstance;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

beforeEach(() => {
  clientCalls.length = 0;
  credentialResolutionCalls.length = 0;
  clientConstructionCount = 0;
  replayEnvelopes.length = 0;
  interactionResponses.length = 0;
  createdArtifacts.length = 0;
  conversationsListResult = { ok: true, channels: [] };
  conversationsHistoryResult = { ok: true, messages: [] };
  filesListResult = { ok: true, files: [] };
  credentialsAvailable = true;
  credentialConnectionConfigured = true;
  schemaInitializingArtifactCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Pure Canvas helpers (pre-existing suite)
// ---------------------------------------------------------------------------

describe("Slack CLI Canvas helpers", () => {
  it("builds validated Canvas edit changes", () => {
    expect(
      buildSlackCanvasEditChange({
        operation: "replace",
        sectionId: "temp:C:1",
        markdown: "## Status\nok",
      }),
    ).toEqual({
      operation: "replace",
      sectionId: "temp:C:1",
      markdown: "## Status\nok",
    });

    expect(
      buildSlackCanvasEditChange({
        operation: "rename",
        title: "Ravi Channels",
      }),
    ).toEqual({
      operation: "rename",
      title: "Ravi Channels",
    });
  });

  it("rejects invalid Canvas edit combinations before calling Slack", () => {
    expect(() => buildSlackCanvasEditChange({ operation: "delete" })).toThrow("requires --section-id");
    expect(() =>
      buildSlackCanvasEditChange({
        operation: "insert_after",
        sectionId: "temp:C:1",
      }),
    ).toThrow("requires --markdown, --markdown-file or --artifact");
    expect(() =>
      buildSlackCanvasEditChange({
        operation: "rename",
        title: "Ravi Channels",
        markdown: "content",
      }),
    ).toThrow("does not accept --markdown");
  });

  it("accepts exactly one Canvas access target kind", () => {
    expect(parseSlackCanvasAccessTargets("U1,U2", undefined)).toEqual({ userIds: ["U1", "U2"] });
    expect(parseSlackCanvasAccessTargets(undefined, "C1,C2")).toEqual({ channelIds: ["C1", "C2"] });
    expect(() => parseSlackCanvasAccessTargets("U1", "C1")).toThrow("only one");
    expect(() => parseSlackCanvasAccessTargets(undefined, undefined)).toThrow("one of --users or --channels");
  });

  it("rejects owner access for channel targets", () => {
    expect(() => validateSlackCanvasAccessLevelTargets("owner", { channelIds: ["C1"] })).toThrow("only target users");
    expect(() => validateSlackCanvasAccessLevelTargets("owner", { userIds: ["U1"] })).not.toThrow();
  });

  it("resolves markdown input from one source only", () => {
    expect(resolveSlackCanvasMarkdownInput("hello", undefined)).toBe("hello");
    expect(() => resolveSlackCanvasMarkdownInput("hello", "canvas.md")).toThrow("only one");
    expect(() => resolveSlackCanvasMarkdownInput(undefined, "canvas.md", "art_abc_123")).toThrow("only one");
  });

  it("redacts modal private metadata from CLI-facing payloads", () => {
    expect(
      redactSlackPrivateMetadata({
        view: {
          id: "V123",
          private_metadata: { contextKey: "ctx_secret" },
          blocks: [{ type: "section", private_metadata: ["nested_secret"] }],
        },
      }),
    ).toEqual({
      view: {
        id: "V123",
        private_metadata: "[redacted]",
        blocks: [{ type: "section", private_metadata: "[redacted]" }],
      },
    });

    expect(
      slackViewMutationItem({
        ok: true,
        view: {
          id: "V123",
          hash: "hash-1",
          callback_id: "callback",
          private_metadata: "ctx_secret",
        },
      }),
    ).toEqual({
      viewId: "V123",
      hash: "hash-1",
      callbackId: "callback",
      externalId: null,
      type: null,
    });
  });

  it("extracts Canvas IDs from conversation metadata shapes", () => {
    expect(extractSlackCanvasIdFromConversationInfo({ properties: { canvas: "F123" } })).toBe("F123");
    expect(extractSlackCanvasIdFromConversationInfo({ properties: { canvas: { id: "F456" } } })).toBe("F456");
    expect(extractSlackCanvasIdFromConversationInfo({ canvas: { canvas_id: "F789" } })).toBe("F789");
    expect(
      extractSlackCanvasIdFromConversationInfo(
        {
          properties: {
            tabs: [
              { type: "files", id: "files" },
              { type: "canvas", label: "Runbook", data: { file_id: "F111" } },
              { type: "canvas", label: "Showcase", data: { file_id: "F222" } },
            ],
          },
        },
        "Showcase",
      ),
    ).toBe("F222");
    expect(
      extractSlackCanvasIdFromConversationInfo(
        {
          properties: {
            tabs: [
              { type: "files", id: "files" },
              { type: "canvas", label: "Runbook", data: { file_id: "F111" } },
            ],
          },
        },
        "Missing",
      ),
    ).toBeUndefined();
    expect(extractSlackCanvasIdFromConversationInfo({ canvas: { canvas_id: "F999" } }, "Missing")).toBeUndefined();
  });

  it("renders the Canvas showcase with implemented features and missing product gaps", () => {
    const markdown = buildSlackCanvasShowcaseMarkdown({
      canvasId: "F123",
      channelId: "C123",
      title: "Showcase",
    });

    expect(markdown).toContain("# Showcase");
    expect(markdown).toContain("`conversations.canvases.create`");
    expect(markdown).toContain("`ravi slack canvas-channel-showcase`");
    expect(markdown).toContain("`ravi slack canvas-edit --artifact`");
    expect(markdown).not.toContain("`canvas-artifact-publish`");
    expect(markdown).toContain("Modelo canonico `ChannelCanvas`");
    expect(markdown).toContain("Artifact Markdown como fonte");
    expect(markdown).toContain("<#C123>");
    expect(markdown).toContain("F123");
  });

  it("models Canvas artifact publish metadata without claiming bidirectional sync", () => {
    const markdownSha256 = hashSlackCanvasMarkdown("# Canvas\nok");
    const metadata = buildSlackCanvasArtifactPublishMetadata({
      provider: "slack",
      syncDirection: "artifact_to_slack",
      publishMode: "replace",
      canvasId: "F123",
      channelId: "C123",
      connection: "ravi-rbbt-slack",
      credentialSource: "credentials",
      title: "Canvas",
      artifactId: "art_abc_123",
      artifactVersionId: "artv_abc_123",
      artifactVersionNumber: 2,
      markdownSha256,
      markdownChars: 11,
      publishedAt: "2026-07-05T00:00:00.000Z",
      remoteContentExportSupported: false,
    });

    expect(metadata.slackCanvas).toMatchObject({
      current: {
        syncDirection: "artifact_to_slack",
        publishMode: "replace",
        canvasId: "F123",
        markdownSha256,
        remoteContentExportSupported: false,
      },
    });
    expect(
      extractSlackCanvasArtifactPublishState({
        id: "art_abc_123",
        kind: "slack.canvas.markdown",
        status: "active",
        tags: [],
        createdAt: 1,
        updatedAt: 1,
        metadata,
      }),
    ).toMatchObject({
      canvasId: "F123",
      artifactVersionNumber: 2,
    });
    expect(isSlackCanvasArtifactId("art_abc_123")).toBe(true);
    expect(isSlackCanvasArtifactId("canvas.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Agent-first contract (Manual v2)
// ---------------------------------------------------------------------------

describe("slack agent-first contract", () => {
  const brakedMutationCases: Array<{ name: string; run: (commands: InstanceType<typeof SlackCommands>) => unknown }> = [
    {
      name: "messages-send",
      run: (commands) => commands.messagesSend("C123", "message", "ravi-slack", undefined, undefined, true, undefined),
    },
    {
      name: "blocks-send",
      run: (commands) =>
        commands.blocksSend(
          "C123",
          jsonFixturePath,
          "ravi-slack",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
    },
    {
      name: "blocks-update",
      run: (commands) =>
        commands.blocksUpdate("C123", "111.222", jsonFixturePath, "ravi-slack", undefined, true, undefined),
    },
    {
      name: "interactions-respond",
      run: (commands) => commands.interactionsRespond("response-1", jsonFixturePath, "ravi-slack", true, undefined),
    },
    {
      name: "modals-open",
      run: (commands) => commands.modalsOpen("trigger-1", jsonFixturePath, "ravi-slack", true, undefined),
    },
    {
      name: "modals-update",
      run: (commands) => commands.modalsUpdate("V1", jsonFixturePath, "ravi-slack", false, undefined, true, undefined),
    },
    {
      name: "modals-push",
      run: (commands) => commands.modalsPush("trigger-1", jsonFixturePath, "ravi-slack", true, undefined),
    },
    {
      name: "blocks-showcase",
      run: (commands) => commands.blocksShowcase("C123", "ravi-slack", undefined, true, undefined),
    },
    {
      name: "work-objects-send",
      run: (commands) =>
        commands.workObjectsSend(
          "C123",
          jsonFixturePath,
          "ravi-slack",
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
    },
    {
      name: "work-objects-unfurl",
      run: (commands) =>
        commands.workObjectsUnfurl(
          "C123",
          "111.222",
          "https://example.test/task",
          jsonFixturePath,
          "ravi-slack",
          undefined,
          true,
          undefined,
        ),
    },
    {
      name: "work-objects-present-details",
      run: (commands) =>
        commands.workObjectsPresentDetails("trigger-1", jsonFixturePath, "ravi-slack", undefined, true, undefined),
    },
    {
      name: "messages-replay",
      run: (commands) => commands.messagesReplay("C123", "111.222", "ravi-slack", false, true, undefined),
    },
    {
      name: "channels-create",
      run: (commands) => commands.channelsCreate("new-channel", "ravi-slack", false, true, undefined),
    },
    {
      name: "channels-rename",
      run: (commands) => commands.channelsRename("C123", "renamed-channel", "ravi-slack", true, undefined),
    },
    {
      name: "channels-invite",
      run: (commands) => commands.channelsInvite("C123", "U1,U2", "ravi-slack", undefined, true, undefined),
    },
    {
      name: "canvas-create",
      run: (commands) =>
        commands.canvasCreate(
          "ravi-slack",
          "Canvas",
          "# Markdown",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
    },
    {
      name: "canvas-channel-create",
      run: (commands) =>
        commands.canvasChannelCreate(
          "C123",
          "ravi-slack",
          "Canvas",
          "# Markdown",
          undefined,
          undefined,
          false,
          undefined,
          true,
          undefined,
        ),
    },
    {
      name: "canvas-showcase",
      run: (commands) => commands.canvasShowcase("F123", "ravi-slack", undefined, "Canvas", true, undefined),
    },
    {
      name: "canvas-channel-showcase",
      run: (commands) => commands.canvasChannelShowcase("C123", "ravi-slack", "Canvas", true, undefined),
    },
    {
      name: "canvas-artifact-publish",
      run: (commands) =>
        commands.canvasArtifactPublish(
          "art_canvas_runbook",
          "ravi-slack",
          "F123",
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
    },
    {
      name: "canvas-edit",
      run: (commands) =>
        commands.canvasEdit(
          "F123",
          "replace",
          "ravi-slack",
          undefined,
          "# Updated",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
    },
    {
      name: "canvas-access-set",
      run: (commands) => commands.canvasAccessSet("F123", "write", "ravi-slack", "U1", undefined, true, undefined),
    },
    {
      name: "canvas-access-delete",
      run: (commands) => commands.canvasAccessDelete("F123", "ravi-slack", "U1", undefined, true, undefined),
    },
    {
      name: "canvas-delete",
      run: (commands) => commands.canvasDelete("F123", "ravi-slack", true, undefined),
    },
  ];

  for (const mutationCase of brakedMutationCases) {
    it(`${mutationCase.name} dry-run does not hydrate credentials or construct a Slack client`, async () => {
      const commands = new SlackCommands();

      await expectContractError(() => mutationCase.run(commands), "WRITE_REQUIRES_EXECUTE", 3);

      expect(credentialResolutionCalls).toEqual([]);
      expect(clientConstructionCount).toBe(0);
      expect(clientCalls).toEqual([]);
      expect(interactionResponses).toEqual([]);
      expect(replayEnvelopes).toEqual([]);
      expect(createdArtifacts).toEqual([]);
    });
  }

  it("declares redactions for actual Slack content, payload-file and identifier inputs", () => {
    const sentinel = "SENTINEL_SLACK_PRIVATE_INPUT_DO_NOT_LEAK";
    const cases = [
      {
        method: "messagesSend",
        input: { channel: sentinel, text: sentinel, threadTs: sentinel, ephemeralUser: sentinel },
      },
      {
        method: "blocksSend",
        input: {
          channel: sentinel,
          file: sentinel,
          text: sentinel,
          blocks: sentinel,
          threadTs: sentinel,
          ephemeralUser: sentinel,
        },
      },
      {
        method: "interactionsRespond",
        input: { responseUrlId: sentinel, file: sentinel, payload: sentinel },
      },
      {
        method: "canvasCreate",
        input: {
          title: sentinel,
          markdown: sentinel,
          markdownFile: sentinel,
          artifact: sentinel,
          channelId: sentinel,
        },
      },
      {
        method: "canvasEdit",
        input: {
          canvas: sentinel,
          sectionId: sentinel,
          markdown: sentinel,
          markdownFile: sentinel,
          artifact: sentinel,
          title: sentinel,
        },
      },
      {
        method: "canvasAccessSet",
        input: { canvas: sentinel, users: sentinel, channels: sentinel },
      },
    ];

    for (const { method, input } of cases) {
      const access = commandAccessMetadata.get(method);
      expect(access?.redactions).toEqual(expect.arrayContaining(Object.keys(input)));
      const auditInput = redactCommandAccessInput(access, input);
      expect(Object.values(auditInput)).toEqual(Object.keys(input).map(() => "[REDACTED]"));
      expect(JSON.stringify(auditInput)).not.toContain(sentinel);
    }
  });

  it("messages-send without --execute summarizes content without exposing request text", async () => {
    const commands = new SlackCommands();
    const error = await expectContractError(
      () => commands.messagesSend("C123", "olá time", "ravi-slack", undefined, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      connection: "ravi-slack",
      method: "chat.postMessage",
      request: { destinationProvided: true, textChars: "olá time".length },
    });
    const plan = JSON.stringify(error.details.plan);
    expect(plan).not.toContain("C123");
    expect(plan).not.toContain("olá time");
    expect(plan).not.toContain('"text":"');
    expect(clientCalls).toHaveLength(0);
  });

  it("messages-send with --execute posts through chat.postMessage", async () => {
    const commands = new SlackCommands();
    const payload = await silenced(() =>
      commands.messagesSend("C123", "olá time", "ravi-slack", undefined, undefined, true, true),
    );

    expect(callsTo("postMessage")).toHaveLength(1);
    expect(callsTo("postMessage")[0]?.args).toMatchObject({ channel: "C123", text: "olá time" });
    expect(credentialResolutionCalls).toHaveLength(1);
    expect(clientConstructionCount).toBe(1);
    expect(payload).toMatchObject({ ok: true, dryRun: false, method: "chat.postMessage" });
  });

  it("interactions-respond with --execute resolves credentials once without constructing an unused client", async () => {
    const commands = new SlackCommands();

    await silenced(() => commands.interactionsRespond("response-1", jsonFixturePath, "ravi-slack", true, true));

    expect(credentialResolutionCalls).toHaveLength(1);
    expect(clientConstructionCount).toBe(0);
    expect(interactionResponses).toHaveLength(1);
  });

  it("blocks-send without --execute is a dry-run: exit 3 and no Web API call", async () => {
    const commands = new SlackCommands();
    const error = await expectContractError(
      () =>
        commands.blocksSend(
          "C123",
          jsonFixturePath,
          "ravi-slack",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({ method: "chat.postMessage" });
    const plan = JSON.stringify(error.details.plan);
    expect(plan).not.toContain("fallback text");
    expect(plan).not.toContain('"blocks":[');
    expect(clientCalls).toHaveLength(0);
  });

  it("dry-run plans never serialize a Slack message sentinel", async () => {
    const commands = new SlackCommands();
    const sentinel = "SENTINEL_SLACK_MESSAGE_DO_NOT_LEAK";
    const error = await expectContractError(
      () => commands.messagesSend("C123", sentinel, "ravi-slack", undefined, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({ request: { destinationProvided: true, textChars: sentinel.length } });
    expect(JSON.stringify(error.envelope())).not.toContain("C123");
    expect(JSON.stringify(error.envelope())).not.toContain(sentinel);
    expect(clientCalls).toHaveLength(0);
  });

  it("blocks-send with --execute posts the Block Kit message", async () => {
    const commands = new SlackCommands();
    await silenced(() =>
      commands.blocksSend(
        "C123",
        jsonFixturePath,
        "ravi-slack",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(callsTo("postMessage")).toHaveLength(1);
    expect(callsTo("postMessage")[0]?.args).toMatchObject({ channel: "C123", text: "fallback text" });
  });

  it("work-objects-send without --execute is a dry-run: exit 3 and no Web API call", async () => {
    const commands = new SlackCommands();
    await expectContractError(
      () =>
        commands.workObjectsSend(
          "C123",
          jsonFixturePath,
          "ravi-slack",
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(clientCalls).toHaveLength(0);
  });

  it("channels-create and channels-invite are braked; --execute performs the call", async () => {
    const commands = new SlackCommands();
    await expectContractError(
      () => commands.channelsCreate("novo-canal", "ravi-slack", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    await expectContractError(
      () => commands.channelsInvite("C123", "U1,U2", "ravi-slack", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(clientCalls).toHaveLength(0);

    await silenced(() => commands.channelsCreate("novo-canal", "ravi-slack", undefined, true, true));
    expect(callsTo("conversationsCreate")).toHaveLength(1);
    expect(callsTo("conversationsCreate")[0]?.args).toMatchObject({ name: "novo-canal" });
  });

  it("channel and Canvas access dry-runs describe the material effect without serializing identifiers", async () => {
    const commands = new SlackCommands();
    const sentinel = "SENTINEL_SLACK_ID_OR_CONTENT_DO_NOT_LEAK";
    const createError = await expectContractError(
      () => commands.channelsCreate(sentinel, "ravi-slack", true, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    const renameError = await expectContractError(
      () => commands.channelsRename(sentinel, sentinel, "ravi-slack", true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    const inviteError = await expectContractError(
      () => commands.channelsInvite(sentinel, `${sentinel},${sentinel}`, "ravi-slack", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    const accessError = await expectContractError(
      () =>
        commands.canvasAccessSet(
          sentinel,
          "write",
          "ravi-slack",
          `${sentinel},${sentinel}`,
          undefined,
          true,
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(createError.details.plan).toMatchObject({
      request: { channelNameChars: sentinel.length, isPrivate: true },
    });
    expect(renameError.details.plan).toMatchObject({ request: { newNameChars: sentinel.length } });
    expect(inviteError.details.plan).toMatchObject({ request: { userCount: 2 } });
    expect(accessError.details.plan).toMatchObject({
      request: { accessLevel: "write", accessTargetKind: "users", accessTargetCount: 2 },
    });

    for (const error of [createError, renameError, inviteError, accessError]) {
      expect(JSON.stringify(error.envelope())).not.toContain(sentinel);
    }
    expect(clientCalls).toHaveLength(0);
  });

  it("canvas-create without --execute is a dry-run: exit 3, no Web API call, no artifact created", async () => {
    const commands = new SlackCommands();
    const error = await expectContractError(
      () =>
        commands.canvasCreate(
          "ravi-slack",
          "Titulo",
          "# markdown",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({ method: "canvases.create" });
    expect(clientCalls).toHaveLength(0);
    expect(createdArtifacts).toHaveLength(0);
  });

  it("canvas artifact dry-run resolves local content without schema initialization", async () => {
    const commands = new SlackCommands();
    const error = await expectContractError(
      () =>
        commands.canvasArtifactPublish(
          "art_canvas_runbook",
          "ravi-slack",
          "F123",
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.plan).toMatchObject({ method: "slack.canvas.artifact.publish" });
    expect(schemaInitializingArtifactCalls).toEqual([]);
    expect(clientCalls).toHaveLength(0);
  });

  it("canvas-create with --execute calls canvases.create", async () => {
    const commands = new SlackCommands();
    await silenced(() =>
      commands.canvasCreate(
        "ravi-slack",
        "Titulo",
        "# markdown",
        undefined,
        undefined,
        undefined,
        undefined,
        true,
        true,
      ),
    );

    expect(callsTo("canvasesCreate")).toHaveLength(1);
    expect(callsTo("canvasesCreate")[0]?.args).toMatchObject({ title: "Titulo", markdown: "# markdown" });
  });

  it("canvas-delete and canvas-access-set are braked before any Web API call", async () => {
    const commands = new SlackCommands();
    await expectContractError(
      () => commands.canvasDelete("F123", "ravi-slack", true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    await expectContractError(
      () => commands.canvasAccessSet("F123", "write", "ravi-slack", "U1", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(clientCalls).toHaveLength(0);

    await silenced(() => commands.canvasDelete("F123", "ravi-slack", true, true));
    expect(callsTo("canvasesDelete")).toHaveLength(1);
  });

  it("canvas-access-set still validates the access level BEFORE the brake", async () => {
    const commands = new SlackCommands();
    await silenced(async () => {
      await expect(
        commands.canvasAccessSet("F123", "bogus", "ravi-slack", "U1", undefined, true, undefined),
      ).rejects.toThrow("Invalid canvas access level");
    });
    expect(clientCalls).toHaveLength(0);
  });

  it("messages-replay without --execute exits 3 BEFORE the conversations.history read", async () => {
    const commands = new SlackCommands();
    await expectContractError(
      () => commands.messagesReplay("C123", "111.222", "ravi-slack", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    // The brake fires before ANY Slack Web API call — including the read.
    expect(callsTo("conversationsHistory")).toHaveLength(0);
    expect(replayEnvelopes).toHaveLength(0);
  });

  it("messages-replay with --execute on a missing message exits 1 with MESSAGE_NOT_FOUND", async () => {
    conversationsHistoryResult = { ok: true, messages: [] };
    const commands = new SlackCommands();
    const error = await expectContractError(
      () => commands.messagesReplay("C123", "111.222", "ravi-slack", undefined, true, true),
      "MESSAGE_NOT_FOUND",
      1,
    );

    expect(error.details.suggestedAction).toContain("ravi slack channels-history");
    expect(replayEnvelopes).toHaveLength(0);
  });

  it("messages-replay with --execute replays a found message through the channel pipeline", async () => {
    conversationsHistoryResult = {
      ok: true,
      messages: [{ type: "message", ts: "111.222", user: "U1", text: "oi", channel_type: "channel" }],
    };
    const commands = new SlackCommands();
    const payload = await silenced(() =>
      commands.messagesReplay("C123", "111.222", "ravi-slack", undefined, true, true),
    );

    expect(replayEnvelopes).toHaveLength(1);
    expect(payload).toMatchObject({ ok: true, dryRun: false });
  });

  it("an unknown Ravi channel config exits 1 with CHANNEL_NOT_FOUND and local suggestions", async () => {
    const commands = new SlackCommands();
    const error = await expectContractError(
      () => commands.channelsList("ravi-slak", undefined, undefined, undefined, undefined, undefined, true),
      "CHANNEL_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("ravi-slack");
    expect(clientCalls).toHaveLength(0);
  });

  it("a mutating command reports a missing credential connection without hydrating the broker", async () => {
    credentialConnectionConfigured = false;
    const commands = new SlackCommands();

    await expectContractError(
      () => commands.messagesSend("C123", "message", "ravi-slack", undefined, undefined, true, undefined),
      "CREDENTIALS_NOT_CONFIGURED",
      1,
    );

    expect(credentialResolutionCalls).toEqual([]);
    expect(clientConstructionCount).toBe(0);
  });

  it("missing credentials exit 1 with CREDENTIALS_NOT_CONFIGURED", async () => {
    credentialsAvailable = false;
    const commands = new SlackCommands();
    await expectContractError(
      () => commands.channelsList("ravi-slack", undefined, undefined, undefined, undefined, undefined, true),
      "CREDENTIALS_NOT_CONFIGURED",
      1,
    );
    expect(clientCalls).toHaveLength(0);
  });

  it("canvas-artifact-status on an unknown artifact exits 1 with ARTIFACT_NOT_FOUND and local suggestions", async () => {
    const commands = new SlackCommands();
    const error = await expectContractError(
      () => commands.canvasArtifactStatus("art_canvas_runbok", true),
      "ARTIFACT_NOT_FOUND",
      1,
    );

    expect(error.details.suggestions).toContain("art_canvas_runbook");
  });

  it("canvas-artifact-publish validates an unknown artifact before hydrating credentials", async () => {
    const commands = new SlackCommands();

    await expectContractError(
      () =>
        commands.canvasArtifactPublish(
          "art_canvas_missing",
          "ravi-slack",
          "F123",
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
      "ARTIFACT_NOT_FOUND",
      1,
    );

    expect(credentialResolutionCalls).toEqual([]);
    expect(clientConstructionCount).toBe(0);
  });

  it("channels-list --fields narrows each item to the requested fields", async () => {
    conversationsListResult = {
      ok: true,
      channels: [
        { id: "C1", name: "geral", is_channel: true, is_archived: false },
        { id: "C2", name: "dev", is_channel: true, is_archived: false },
      ],
    };
    const commands = new SlackCommands();
    const payload = await silenced(() =>
      commands.channelsList("ravi-slack", undefined, undefined, undefined, undefined, "id,name", true),
    );

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "name"]);
    }
  });

  it("files-list --fields narrows each item to the requested fields", async () => {
    filesListResult = {
      ok: true,
      files: [
        { id: "F1", name: "doc.pdf", size: 100, mimetype: "application/pdf" },
        { id: "F2", name: "img.png", size: 200, mimetype: "image/png" },
      ],
    };
    const commands = new SlackCommands();
    const payload = await silenced(() =>
      commands.filesList("ravi-slack", undefined, undefined, undefined, undefined, "id,name", true),
    );

    expect(payload.items).toHaveLength(2);
    for (const item of payload.items as Array<Record<string, unknown>>) {
      expect(Object.keys(item).sort()).toEqual(["id", "name"]);
    }
  });

  it("blocks-validate is declared UNBRAKED: the validation-only call runs without --execute", async () => {
    const commands = new SlackCommands();
    const payload = await silenced(() => commands.blocksValidate(jsonFixturePath, "ravi-slack", undefined, true));

    expect(callsTo("blocksValidate")).toHaveLength(1);
    expect(payload).toMatchObject({ ok: true });
  });
});
