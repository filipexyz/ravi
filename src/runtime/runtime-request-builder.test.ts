import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { dbBindSessionToChat, dbUpsertChat } from "../router/router-db.js";
import { getOrCreateSession } from "../router/index.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import type { RuntimeLaunchPrompt } from "./message-types.js";
import { resolveRuntimePromptSource } from "./runtime-request-builder.js";

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
    dbBindSessionToChat({
      sessionKey: session.sessionKey,
      chatId: chat.id,
      agentId: "audit",
      bindingReason: "test",
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
});
