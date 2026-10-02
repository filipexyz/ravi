/**
 * Message edits (#1061, reopened).
 *
 * Baileys re-emits every MESSAGE_EDIT as `messages.update` with the ORIGINAL key
 * and `{ editedMessage: { message: <new content> } }`. The raw protocol message on
 * `messages.upsert` may surface the same edit first; the edit dedupe makes sure the
 * pair produces exactly one edit event and never a `message.received`.
 *
 * The dedupe set is module-level: every test starts from an empty one, so each test
 * passes alone and in any order (`bun test --randomize`).
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { resetEditDedupeForTests, setupMessageHandlers } from "../handlers/messages.js";
import { createFakeHost } from "./fake-host.js";

const GROUP = "120363000000000000@g.us";

function harness() {
  const ev = new EventEmitter();
  const sock = { ev, presenceSubscribe: mock(async () => {}) } as unknown as Parameters<typeof setupMessageHandlers>[0];
  const plugin = createFakeHost();
  setupMessageHandlers(sock, plugin, "inst-1");
  // Omni asserted on plugin.emitMessageReceived; the handler-level equivalent is handleMessageReceived.
  return { ev, handleEdited: plugin.handleMessageEdited, emitReceived: plugin.handleMessageReceived };
}

const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  resetEditDedupeForTests();
});

describe("WhatsApp message edits via messages.update", () => {
  it("text edit of own group message lands on the original id with the new text", async () => {
    const h = harness();
    h.ev.emit("messages.update", [
      {
        key: { id: "ORIG789", remoteJid: GROUP, fromMe: true, participant: "5511999998888@s.whatsapp.net" },
        update: { message: { editedMessage: { message: { extendedTextMessage: { text: "edited in group" } } } } },
      },
    ]);
    await flush();
    expect(h.handleEdited).toHaveBeenCalledWith("inst-1", "ORIG789", GROUP, "edited in group", true);
  });

  it("media caption edit carries the caption", async () => {
    const h = harness();
    h.ev.emit("messages.update", [
      {
        key: { id: "ORIG456", remoteJid: "5511999998888@s.whatsapp.net", fromMe: false },
        update: { message: { editedMessage: { message: { imageMessage: { caption: "new caption" } } } } },
      },
    ]);
    await flush();
    expect(h.handleEdited).toHaveBeenCalledWith(
      "inst-1",
      "ORIG456",
      "5511999998888@s.whatsapp.net",
      "new caption",
      false,
    );
  });

  it("status-only updates do not emit edits", async () => {
    const h = harness();
    h.ev.emit("messages.update", [{ key: { id: "X", remoteJid: GROUP, fromMe: true }, update: { status: 3 } }]);
    await flush();
    expect(h.handleEdited).not.toHaveBeenCalled();
  });

  it("the raw edit protocol message on messages.upsert plus its messages.update yield exactly one edit", async () => {
    const h = harness();
    h.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "EDITMSG1", remoteJid: GROUP, fromMe: true, participant: "5511999998888@s.whatsapp.net" },
          messageTimestamp: 1_700_000_000,
          message: {
            deviceSentMessage: {
              destinationJid: GROUP,
              message: {
                editedMessage: {
                  message: {
                    protocolMessage: {
                      key: { id: "ORIG789", remoteJid: GROUP, fromMe: true },
                      type: 14,
                      editedMessage: { conversation: "edited in group" },
                    },
                  },
                },
              },
            },
          },
        },
      ],
    });
    await flush();
    h.ev.emit("messages.update", [
      {
        key: { id: "ORIG789", remoteJid: GROUP, fromMe: true, participant: "5511999998888@s.whatsapp.net" },
        update: { message: { editedMessage: { message: { conversation: "edited in group" } } } },
      },
    ]);
    await flush();
    // Whichever of the two surfaces it first (here the upsert), the edit lands once, on the original id.
    expect(h.handleEdited).toHaveBeenCalledTimes(1);
    expect(h.handleEdited.mock.calls[0]?.slice(0, 5)).toEqual(["inst-1", "ORIG789", GROUP, "edited in group", true]);
    expect(h.emitReceived).not.toHaveBeenCalled();
  });

  it("a repeated messages.update for the same edit is emitted once", async () => {
    const h = harness();
    const update = {
      key: { id: "ORIG999", remoteJid: GROUP, fromMe: false, participant: "5511999998888@s.whatsapp.net" },
      update: { message: { editedMessage: { message: { conversation: "same text" } } } },
    };
    h.ev.emit("messages.update", [update]);
    h.ev.emit("messages.update", [update]);
    await flush();
    expect(h.handleEdited).toHaveBeenCalledTimes(1);
  });
});
