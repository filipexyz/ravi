import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { spawn } from "bun";
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

  it("upgrades an existing chat database without rewriting historical output", () => {
    const legacy = new Database(join(stateDir, "chat.db"));
    legacy.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT NOT NULL, sdk_session_id TEXT, created_at TEXT DEFAULT (datetime('now'))
    ); INSERT INTO messages VALUES (17, 'dev', 'assistant', 'legacy final', 'provider-old', '2026-01-01 10:00:00')`);
    legacy.close();
    expect(
      saveMessage("dev", "assistant", "checking", "provider-new", { utteranceClass: "commentary", turnId: "turn-new" }),
    ).toBe(true);
    expect(
      saveMessage("dev", "assistant", "checking", "provider-new", { utteranceClass: "commentary", turnId: "turn-new" }),
    ).toBe(false);
    expect(
      saveMessage("dev", "assistant", "checking", "provider-new", { utteranceClass: "final", turnId: "turn-new" }),
    ).toBe(true);
    expect(
      saveMessage("dev", "assistant", "checking", "provider-new", {
        utteranceClass: "commentary",
        turnId: "turn-next",
      }),
    ).toBe(true);
    const messages = getRecentHistory("dev", 20);
    expect(messages).toHaveLength(4);
    expect(messages[0]).toMatchObject({
      id: 17,
      content: "legacy final",
      sdk_session_id: "provider-old",
      created_at: "2026-01-01 10:00:00",
      utterance_class: null,
      turn_id: null,
    });
    close();
    expect(getRecentHistory("dev", 20)).toEqual(messages);
  });

  it("deduplicates exact turn output across concurrent writers", async () => {
    getRecentHistory("dev", 1); // Apply migrations before the writers race.
    const source = `import { saveMessage, close } from ${JSON.stringify(join(import.meta.dir, "db.ts"))};
      for (let i = 0; i < 50; i++) saveMessage('dev', 'assistant', 'same output', null, { turnId: 'shared-turn', utteranceClass: 'commentary' }); close();`;
    const writers = [0, 1].map(() =>
      spawn([process.execPath, "--eval", source], {
        env: { ...process.env, RAVI_STATE_DIR: stateDir },
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    for (const writer of writers) {
      expect(await new Response(writer.stderr).text()).toBe("");
      expect(await writer.exited).toBe(0);
    }
    expect(getRecentHistory("dev", 20)).toHaveLength(1);
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
