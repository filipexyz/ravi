import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { close, countHistoryByChatIds, getRecentHistory, getRecentHistoryByChatIds, saveMessage } from "./db.js";

describe("chat db messages", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.RAVI_STATE_DIR;
    stateDir = mkdtempSync(join(tmpdir(), "ravi-chat-db-"));
    process.env.RAVI_STATE_DIR = stateDir;
    close();
  });

  afterEach(() => {
    close();
    if (previousStateDir === undefined) {
      delete process.env.RAVI_STATE_DIR;
    } else {
      process.env.RAVI_STATE_DIR = previousStateDir;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists channel source metadata with messages", () => {
    saveMessage("dev", "user", "hello", "provider-1", {
      agentId: "main",
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "63295117615153@lid",
      sourceMessageId: "wamid-1",
    });

    const [message] = getRecentHistory("dev", 10);

    expect(message).toMatchObject({
      session_id: "dev",
      role: "user",
      content: "hello",
      sdk_session_id: "provider-1",
      agent_id: "main",
      channel: "whatsapp-baileys",
      account_id: "main",
      chat_id: "63295117615153@lid",
      source_message_id: "wamid-1",
    });
  });

  it("reads durable messages by chat id variants", () => {
    saveMessage("session-a", "assistant", "right chat", "provider-1", {
      agentId: "main",
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "63295117615153@lid",
      sourceMessageId: "wamid-1",
    });
    saveMessage("session-b", "assistant", "other chat", "provider-2", {
      agentId: "other",
      channel: "whatsapp-baileys",
      accountId: "main",
      chatId: "63295117615153@lid",
      sourceMessageId: "wamid-2",
    });

    const messages = getRecentHistoryByChatIds(["63295117615153@lid"], 10, "main");

    expect(countHistoryByChatIds(["63295117615153@lid"], "main")).toBe(1);
    expect(messages.map((message) => message.content)).toEqual(["right chat"]);
  });
});
