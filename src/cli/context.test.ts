import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterAll(() => mock.restore());

const actualRuntimeContextRegistryModule = await import("../runtime/context-registry.js");

let resolvedContext:
  | {
      contextId: string;
      agentId?: string;
      sessionKey?: string;
      sessionName?: string;
      source?: { channel: string; accountId: string; chatId: string };
      capabilities: unknown[];
      kind: string;
      createdAt: number;
    }
  | undefined;
let runtimeResolutionOptions: unknown;

mock.module("../runtime/context-registry.js", () => ({
  ...actualRuntimeContextRegistryModule,
  RAVI_CONTEXT_KEY_ENV: "RAVI_CONTEXT_KEY",
  getRuntimeContextFromEnv: (_env?: NodeJS.ProcessEnv, options?: unknown) => {
    runtimeResolutionOptions = options;
    return resolvedContext;
  },
}));

const { getContext, hasContext, hasRuntimeInvocationContext, runWithContext } = await import("./context.js");

describe("cli context resolution", () => {
  const originalEnv = {
    RAVI_CONTEXT_KEY: process.env.RAVI_CONTEXT_KEY,
    RAVI_SESSION_KEY: process.env.RAVI_SESSION_KEY,
    RAVI_SESSION_NAME: process.env.RAVI_SESSION_NAME,
    RAVI_AGENT_ID: process.env.RAVI_AGENT_ID,
    RAVI_CHANNEL: process.env.RAVI_CHANNEL,
    RAVI_ACCOUNT_ID: process.env.RAVI_ACCOUNT_ID,
    RAVI_INSTANCE_ID: process.env.RAVI_INSTANCE_ID,
    RAVI_CHAT_ID: process.env.RAVI_CHAT_ID,
    RAVI_CANONICAL_CHAT_ID: process.env.RAVI_CANONICAL_CHAT_ID,
    RAVI_CREDENTIALS_PATH: process.env.RAVI_CREDENTIALS_PATH,
  };

  beforeEach(() => {
    resolvedContext = undefined;
    runtimeResolutionOptions = undefined;
    delete process.env.RAVI_CONTEXT_KEY;
    delete process.env.RAVI_SESSION_KEY;
    delete process.env.RAVI_SESSION_NAME;
    delete process.env.RAVI_AGENT_ID;
    delete process.env.RAVI_CHANNEL;
    delete process.env.RAVI_ACCOUNT_ID;
    delete process.env.RAVI_INSTANCE_ID;
    delete process.env.RAVI_CHAT_ID;
    delete process.env.RAVI_CANONICAL_CHAT_ID;
    process.env.RAVI_CREDENTIALS_PATH = join(tmpdir(), `ravi-cli-context-test-missing-${process.pid}.json`);
  });

  afterEach(() => {
    restoreEnv("RAVI_CONTEXT_KEY", originalEnv.RAVI_CONTEXT_KEY);
    restoreEnv("RAVI_SESSION_KEY", originalEnv.RAVI_SESSION_KEY);
    restoreEnv("RAVI_SESSION_NAME", originalEnv.RAVI_SESSION_NAME);
    restoreEnv("RAVI_AGENT_ID", originalEnv.RAVI_AGENT_ID);
    restoreEnv("RAVI_CHANNEL", originalEnv.RAVI_CHANNEL);
    restoreEnv("RAVI_ACCOUNT_ID", originalEnv.RAVI_ACCOUNT_ID);
    restoreEnv("RAVI_INSTANCE_ID", originalEnv.RAVI_INSTANCE_ID);
    restoreEnv("RAVI_CHAT_ID", originalEnv.RAVI_CHAT_ID);
    restoreEnv("RAVI_CANONICAL_CHAT_ID", originalEnv.RAVI_CANONICAL_CHAT_ID);
    restoreEnv("RAVI_CREDENTIALS_PATH", originalEnv.RAVI_CREDENTIALS_PATH);
  });

  it("prefers resolved runtime context when RAVI_CONTEXT_KEY is present", () => {
    process.env.RAVI_CONTEXT_KEY = "rctx_123";
    resolvedContext = {
      contextId: "ctx_123",
      kind: "agent-runtime",
      agentId: "dev",
      sessionKey: "agent:dev:main",
      sessionName: "dev-main",
      source: { channel: "whatsapp", accountId: "main", chatId: "5511999999999" },
      capabilities: [],
      createdAt: 1000,
    };

    const ctx = getContext();
    expect(ctx).toMatchObject({
      contextId: "ctx_123",
      agentId: "dev",
      sessionKey: "agent:dev:main",
      sessionName: "dev-main",
      source: { channel: "whatsapp", accountId: "main", chatId: "5511999999999" },
    });
  });

  it("propagates read-only no-touch resolution through CLI bootstrap", () => {
    process.env.RAVI_CONTEXT_KEY = "rctx_read_only";
    resolvedContext = {
      contextId: "ctx_read_only",
      kind: "agent-runtime",
      capabilities: [],
      createdAt: 1000,
    };

    expect(getContext({ touch: false, readOnly: true })?.contextId).toBe("ctx_read_only");
    expect(runtimeResolutionOptions).toEqual({ touch: false, readOnly: true });
  });

  it("falls back to legacy RAVI_* env vars when no runtime context is available", () => {
    process.env.RAVI_SESSION_KEY = "agent:main:main";
    process.env.RAVI_SESSION_NAME = "main";
    process.env.RAVI_AGENT_ID = "main";
    process.env.RAVI_CHANNEL = "whatsapp";
    process.env.RAVI_ACCOUNT_ID = "main";
    process.env.RAVI_INSTANCE_ID = "instance-main";
    process.env.RAVI_CHAT_ID = "5511888888888";
    process.env.RAVI_CANONICAL_CHAT_ID = "chat-main";

    const ctx = getContext();
    expect(ctx).toMatchObject({
      sessionKey: "agent:main:main",
      sessionName: "main",
      agentId: "main",
      source: {
        channel: "whatsapp",
        accountId: "main",
        instanceId: "instance-main",
        chatId: "5511888888888",
        canonicalChatId: "chat-main",
      },
    });
  });

  it("does not mistake the generic CLI handler boundary for a runtime invocation", () => {
    for (const context of [{}, { agentId: "operator", sessionName: "default" }]) {
      expect(
        runWithContext(context, () => ({
          hasHandlerContext: hasContext(),
          hasRuntimeInvocationContext: hasRuntimeInvocationContext(),
        })),
      ).toEqual({
        hasHandlerContext: true,
        hasRuntimeInvocationContext: false,
      });
    }
  });

  it.each(["tool", "gateway"] as const)("recognizes the %s transport as a runtime invocation", (transport) => {
    expect(runWithContext({ transport }, () => hasRuntimeInvocationContext())).toBe(true);
  });

  it("recognizes explicit runtime env outside an in-process tool transport", () => {
    process.env.RAVI_SESSION_NAME = "runtime-session";

    expect(hasRuntimeInvocationContext()).toBe(true);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
