import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

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

mock.module("../runtime/context-registry.js", () => ({
  ...actualRuntimeContextRegistryModule,
  RAVI_CONTEXT_KEY_ENV: "RAVI_CONTEXT_KEY",
  getRuntimeContextFromEnv: () => resolvedContext,
}));

const { getContext } = await import("./context.js");

describe("cli context resolution", () => {
  const originalEnv = {
    RAVI_CONTEXT_KEY: process.env.RAVI_CONTEXT_KEY,
    RAVI_SESSION_KEY: process.env.RAVI_SESSION_KEY,
    RAVI_SESSION_NAME: process.env.RAVI_SESSION_NAME,
    RAVI_AGENT_ID: process.env.RAVI_AGENT_ID,
    RAVI_CHANNEL: process.env.RAVI_CHANNEL,
    RAVI_ACCOUNT_ID: process.env.RAVI_ACCOUNT_ID,
    RAVI_CHAT_ID: process.env.RAVI_CHAT_ID,
  };

  beforeEach(() => {
    resolvedContext = undefined;
    delete process.env.RAVI_CONTEXT_KEY;
    delete process.env.RAVI_SESSION_KEY;
    delete process.env.RAVI_SESSION_NAME;
    delete process.env.RAVI_AGENT_ID;
    delete process.env.RAVI_CHANNEL;
    delete process.env.RAVI_ACCOUNT_ID;
    delete process.env.RAVI_CHAT_ID;
  });

  afterEach(() => {
    process.env.RAVI_CONTEXT_KEY = originalEnv.RAVI_CONTEXT_KEY;
    process.env.RAVI_SESSION_KEY = originalEnv.RAVI_SESSION_KEY;
    process.env.RAVI_SESSION_NAME = originalEnv.RAVI_SESSION_NAME;
    process.env.RAVI_AGENT_ID = originalEnv.RAVI_AGENT_ID;
    process.env.RAVI_CHANNEL = originalEnv.RAVI_CHANNEL;
    process.env.RAVI_ACCOUNT_ID = originalEnv.RAVI_ACCOUNT_ID;
    process.env.RAVI_CHAT_ID = originalEnv.RAVI_CHAT_ID;
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

  it("falls back to legacy RAVI_* env vars when no runtime context is available", () => {
    process.env.RAVI_SESSION_KEY = "agent:main:main";
    process.env.RAVI_SESSION_NAME = "main";
    process.env.RAVI_AGENT_ID = "main";
    process.env.RAVI_CHANNEL = "whatsapp";
    process.env.RAVI_ACCOUNT_ID = "main";
    process.env.RAVI_CHAT_ID = "5511888888888";

    const ctx = getContext();
    expect(ctx).toMatchObject({
      sessionKey: "agent:main:main",
      sessionName: "main",
      agentId: "main",
      source: { channel: "whatsapp", accountId: "main", chatId: "5511888888888" },
    });
  });
});
