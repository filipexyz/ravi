import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";

import {
  applyPageChatSiteSettingsPatch,
  PAGE_CHAT_DEFAULT_SITE_SETTINGS,
  parsePageChatSiteSettings,
  parsePageChatSiteSettingsPatch,
} from "./site-settings";

describe("Page Chat site settings", () => {
  test("defaults to on with the Brazilian voice when nothing is stored", () => {
    expect(parsePageChatSiteSettings(null)).toEqual(PAGE_CHAT_DEFAULT_SITE_SETTINGS);
    expect(parsePageChatSiteSettings({ other: true })).toEqual({
      enabled: true,
      assistantName: null,
      voice: "bossa",
      language: "pt-BR",
      instructions: null,
      text: true,
      replyPolicy: "mention",
      textModel: null,
      raviAgent: null,
    });
  });

  test("falls back field by field when stored values are malformed", () => {
    expect(
      parsePageChatSiteSettings({
        pageChat: { enabled: "no", assistantName: "  Lia  ", voice: "robot", language: "not a tag", instructions: "" },
      }),
    ).toEqual({
      enabled: true,
      assistantName: "Lia",
      voice: "bossa",
      language: "pt-BR",
      instructions: null,
      text: true,
      replyPolicy: "mention",
      textModel: null,
      raviAgent: null,
    });
    expect(parsePageChatSiteSettings({ pageChat: { enabled: false, voice: "marin", language: "en-US" } })).toMatchObject({
      enabled: false,
      voice: "marin",
      language: "en-US",
    });
  });

  test("rejects unknown fields and voices in a patch", () => {
    expect(() => parsePageChatSiteSettingsPatch({ voice: "robot" })).toThrow(ConsoleApiError);
    expect(() => parsePageChatSiteSettingsPatch({ model: "x" })).toThrow(ConsoleApiError);
    try {
      parsePageChatSiteSettingsPatch({ assistantName: "x".repeat(61) });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleApiError);
      expect((error as ConsoleApiError).status).toBe(400);
      expect(JSON.stringify((error as ConsoleApiError).payload)).toContain("assistantName");
    }
    expect(parsePageChatSiteSettingsPatch(undefined)).toEqual({});
    expect(() => parsePageChatSiteSettingsPatch({ replyPolicy: "sometimes" })).toThrow(ConsoleApiError);
    expect(() => parsePageChatSiteSettingsPatch({ textModel: "Claude Sonnet" })).toThrow(ConsoleApiError);
    expect(() => parsePageChatSiteSettingsPatch({ raviAgent: { installationId: "x", agentId: "main" } })).toThrow(ConsoleApiError);
  });

  test("reads and patches the text chat settings", () => {
    const stored = {
      pageChat: {
        text: false,
        replyPolicy: "always",
        textModel: "anthropic/claude-sonnet-5.5",
        raviAgent: { installationId: "11111111-1111-4111-8111-111111111111", agentId: "main" },
      },
    };
    expect(parsePageChatSiteSettings(stored)).toMatchObject(stored.pageChat);
    expect(parsePageChatSiteSettings({ pageChat: { replyPolicy: "x", textModel: "bad model", raviAgent: { agentId: "a" } } })).toMatchObject({
      replyPolicy: "mention",
      textModel: null,
      raviAgent: null,
    });
    const { settings } = applyPageChatSiteSettingsPatch(stored, parsePageChatSiteSettingsPatch({ textModel: null, raviAgent: null, text: true }));
    expect(settings).toMatchObject({ text: true, replyPolicy: "always", textModel: null, raviAgent: null });
  });

  test("applies a patch, keeps other metadata and clears text with null", () => {
    const metadata = { theme: "dark", pageChat: { assistantName: "Lia", instructions: "Seja breve." } };
    const { metadataJson, settings } = applyPageChatSiteSettingsPatch(
      metadata,
      parsePageChatSiteSettingsPatch({ enabled: false, voice: "tempo", instructions: null }),
    );
    expect(settings).toEqual({
      enabled: false,
      assistantName: "Lia",
      voice: "tempo",
      language: "pt-BR",
      instructions: null,
      text: true,
      replyPolicy: "mention",
      textModel: null,
      raviAgent: null,
    });
    expect(metadataJson).toEqual({ theme: "dark", pageChat: settings });
    expect(metadata.pageChat.instructions).toBe("Seja breve.");
  });
});
