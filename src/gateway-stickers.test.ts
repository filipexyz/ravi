import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { configStore } from "./config-store.js";
import { Gateway } from "./gateway.js";
import { dbUpsertInstance } from "./router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "./test/ravi-state.js";
import type { StickerSendEvent } from "./stickers/send.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-gateway-stickers-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

function makeGateway(sendSticker: ReturnType<typeof mock>, sendMedia = mock(async () => ({ messageId: "media-1" }))) {
  const gateway = new Gateway({
    omniSender: {
      send: mock(async () => ({})),
      sendTyping: mock(async () => {}),
      sendReaction: mock(async () => {}),
      sendMedia,
      sendSticker,
      markRead: mock(async () => {}),
    } as never,
    omniConsumer: {
      getActiveTarget: () => undefined,
      clearActiveTarget: () => {},
      renewActiveTarget: mock(async () => false),
    } as never,
  });
  return gateway;
}

async function handleSticker(gateway: unknown, data: StickerSendEvent): Promise<void> {
  await (
    gateway as {
      handleStickerSendEvent(data: StickerSendEvent): Promise<void>;
    }
  ).handleStickerSendEvent(data);
}

describe("Gateway sticker sends", () => {
  it("uses the dedicated WhatsApp omni sticker path", async () => {
    dbUpsertInstance({
      name: "main",
      instanceId: "11111111-1111-1111-1111-111111111111",
      channel: "whatsapp",
    });
    configStore.refresh();
    const sendSticker = mock(async () => ({ messageId: "sticker-1" }));
    const sendMedia = mock(async () => ({ messageId: "media-1" }));
    const gateway = makeGateway(sendSticker, sendMedia);

    await handleSticker(gateway, {
      channel: "whatsapp",
      accountId: "main",
      chatId: "group:120363407390920496",
      stickerId: "wave",
      label: "Wave",
      filePath: "/tmp/wave.webp",
      mimeType: "image/webp",
      filename: "wave.webp",
    });

    expect(sendSticker).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "120363407390920496@g.us",
      "/tmp/wave.webp",
    );
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("rejects non-WhatsApp channels before calling omni", async () => {
    const sendSticker = mock(async () => ({ messageId: "sticker-1" }));
    const gateway = makeGateway(sendSticker);

    await expect(
      handleSticker(gateway, {
        channel: "matrix",
        accountId: "main",
        chatId: "!room",
        stickerId: "wave",
        label: "Wave",
        filePath: "/tmp/wave.webp",
        mimeType: "image/webp",
        filename: "wave.webp",
      }),
    ).rejects.toThrow("Stickers are not supported on channel");
    expect(sendSticker).not.toHaveBeenCalled();
  });
});
