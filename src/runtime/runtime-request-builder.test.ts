import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbUpsertChat } from "../router/router-db.js";
import { attachChatToSession, getOrCreateSession } from "../router/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimePromptSource, rotateRuntimeProviderEnvironment } from "./runtime-request-builder.js";
import { buildSessionRelayTurnOrigin } from "./turn-origin.js";

let stateDir: string | null = null;

describe("resolveRuntimePromptSource", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-runtime-source-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("enriches raw prompt sources with the session chat binding canonical chat id", () => {
    const session = getOrCreateSession("agent:audit:whatsapp:main:group:120363424239734858", "audit", "/tmp/audit", {
      name: "audit-2",
    });
    const chat = dbUpsertChat({
      channel: "whatsapp",
      instanceId: "main",
      platformChatId: "120363424239734858@g.us",
      normalizedChatId: "group:120363424239734858",
      chatType: "group",
      title: "Ravi - Audit",
    });
    attachChatToSession({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      attachedByType: "system",
      attachedReason: "test",
      setOutputTarget: true,
    });

    const prompt: RuntimeLaunchPrompt = {
      prompt: "checkpoint",
      _cron: true,
      _jobId: "job-1",
      source: {
        channel: "whatsapp",
        accountId: "main",
        chatId: "120363424239734858@g.us",
      },
    };

    const source = resolveRuntimePromptSource(prompt, session);

    expect(source).toMatchObject({
      channel: "whatsapp",
      accountId: "main",
      chatId: "120363424239734858@g.us",
      canonicalChatId: chat.id,
      instanceId: "main",
    });
  });

  it("does not copy leftover lastChannel onto session-relay HTTP send", () => {
    const session = getOrCreateSession("agent:main:main", "main", "/tmp/main", { name: "main" });
    session.lastChannel = "whatsapp";
    session.lastAccountId = "main";
    session.lastTo = "5511999999999@s.whatsapp.net";

    expect(
      resolveRuntimePromptSource(
        {
          prompt: "hello from gateway",
          source: {
            channel: "whatsapp",
            accountId: "main",
            chatId: "5511999999999@s.whatsapp.net",
          },
          _turnOrigin: buildSessionRelayTurnOrigin("send"),
        },
        session,
      ),
    ).toBeUndefined();
    expect(
      resolveRuntimePromptSource(
        {
          prompt: "hello from gateway",
          _turnOrigin: buildSessionRelayTurnOrigin("send"),
        },
        session,
      ),
    ).toBeUndefined();
  });

  it("still resolves a real inbound WhatsApp source and strips tui", () => {
    const session = getOrCreateSession("agent:main:main", "main", "/tmp/main", { name: "main" });
    session.lastChannel = "whatsapp";
    session.lastTo = "old@s.whatsapp.net";

    const inbound = resolveRuntimePromptSource(
      {
        prompt: "from whatsapp",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "new@s.whatsapp.net",
        },
      },
      session,
    );
    expect(inbound).toMatchObject({
      channel: "whatsapp",
      chatId: "new@s.whatsapp.net",
    });

    expect(
      resolveRuntimePromptSource(
        {
          prompt: "local tui",
          source: { channel: "tui", accountId: "", chatId: "" },
        },
        session,
      ),
    ).toBeUndefined();
  });
});

describe("rotateRuntimeProviderEnvironment", () => {
  it("restores host values and refuses secret or Ravi-owned provider overrides", () => {
    const runtimeEnv: Record<string, string> = {
      PATH: "/broker:/base",
      OLD_BINDING: "old",
      RAVI_CONTEXT_KEY: "ctx",
    };
    const activeProviderEnvKeys = new Set(["PATH", "OLD_BINDING"]);
    const next = rotateRuntimeProviderEnvironment({
      runtimeEnv,
      baselineRuntimeEnv: { PATH: "/base", RAVI_CONTEXT_KEY: "ctx" },
      raviEnv: { RAVI_CONTEXT_KEY: "ctx" },
      activeProviderEnvKeys,
      nextProviderEnv: {
        NEXT_BINDING: "next",
        RAVI_CONTEXT_KEY: "provider-override",
        RAVI_BIN: "/untrusted/ravi",
        DATABASE_URL: "secret",
      },
      nextResolvedRuntimeEnv: {
        PATH: "/base",
        NEXT_BINDING: "next",
        RAVI_CONTEXT_KEY: "ctx",
        RAVI_BIN: "/trusted/ravi",
      },
    });

    expect(runtimeEnv).toEqual({
      PATH: "/base",
      NEXT_BINDING: "next",
      RAVI_CONTEXT_KEY: "ctx",
    });
    expect([...next]).toEqual(["NEXT_BINDING"]);
  });
});
