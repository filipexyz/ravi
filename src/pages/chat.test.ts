import { describe, expect, it, mock } from "bun:test";
import type { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import {
  buildPageChatPatchBody,
  describePageChatPatch,
  getPageChatSettings,
  normalizePageChatLanguage,
  PAGE_CHAT_VOICES,
  pageChatChangedFields,
  pageChatPath,
  readPageChatPayload,
  updatePageChatSettings,
} from "./chat.js";

describe("buildPageChatPatchBody", () => {
  it("sends only the fields the caller set", () => {
    expect(buildPageChatPatchBody({ voice: "tempo" })).toEqual({ voice: "tempo" });
    expect(buildPageChatPatchBody({ enabled: "false" })).toEqual({ enabled: false });
    expect(
      buildPageChatPatchBody({
        enabled: "TRUE",
        name: "  Lia  ",
        voice: " Bossa ",
        language: "pt-br",
        instructions: "  Fale pouco.  ",
      }),
    ).toEqual({
      enabled: true,
      assistantName: "Lia",
      voice: "bossa",
      language: "pt-BR",
      instructions: "Fale pouco.",
    });
  });

  it("clears name and instructions with null", () => {
    const body = buildPageChatPatchBody({ clearName: true, clearInstructions: true });
    expect(body).toEqual({ assistantName: null, instructions: null });
    expect(JSON.stringify(body)).toBe('{"assistantName":null,"instructions":null}');
    expect(pageChatChangedFields(body)).toEqual(["assistantName", "instructions"]);
  });

  it("rejects an empty change set", () => {
    expect(() => buildPageChatPatchBody({})).toThrow(CloudAuthError);
    expect(() => buildPageChatPatchBody({ clearName: false })).toThrow(/Missing a setting to change/);
  });

  it("rejects conflicting set and clear flags", () => {
    expect(() => buildPageChatPatchBody({ name: "Lia", clearName: true })).toThrow(/--name or --clear-name/);
    expect(() => buildPageChatPatchBody({ instructions: "x", clearInstructions: true })).toThrow(
      /--instructions or --clear-instructions/,
    );
  });

  it("validates every field as a usage error", () => {
    const cases: Array<[Parameters<typeof buildPageChatPatchBody>[0], RegExp]> = [
      [{ enabled: "yes" }, /--enabled must be true or false/],
      [{ voice: "alloy" }, /--voice must be one of/],
      [{ name: "   " }, /--clear-name/],
      [{ name: "a".repeat(61) }, /at most 60/],
      [{ name: "line\nbreak" }, /single line/],
      [{ instructions: "  " }, /--clear-instructions/],
      [{ instructions: "x".repeat(2001) }, /at most 2000/],
      [{ language: "portuguese_brazil" }, /BCP 47/],
      [{ language: "" }, /BCP 47/],
    ];
    for (const [input, message] of cases) {
      let caught: unknown;
      try {
        buildPageChatPatchBody(input);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(input)).toBeInstanceOf(CloudAuthError);
      expect((caught as CloudAuthError).code).toBe("PAYLOAD_INVALID");
      expect((caught as CloudAuthError).message).toMatch(message);
    }
  });

  it("accepts the limits exactly", () => {
    expect(buildPageChatPatchBody({ name: "a".repeat(60) }).assistantName).toHaveLength(60);
    expect(buildPageChatPatchBody({ instructions: "x".repeat(2000) }).instructions).toHaveLength(2000);
  });

  it("accepts every documented voice", () => {
    for (const voice of PAGE_CHAT_VOICES) {
      expect(buildPageChatPatchBody({ voice }).voice).toBe(voice);
    }
    expect(PAGE_CHAT_VOICES[0]).toBe("bossa");
    expect(PAGE_CHAT_VOICES).toContain("tempo");
  });

  it("canonicalizes BCP 47 language tags", () => {
    expect(normalizePageChatLanguage("en-us")).toBe("en-US");
    expect(normalizePageChatLanguage("es")).toBe("es");
    expect(normalizePageChatLanguage(undefined)).toBeUndefined();
  });
});

describe("describePageChatPatch", () => {
  it("reports instructions by length only", () => {
    const plan = describePageChatPatch({ enabled: true, instructions: "segredo do prompt", voice: "tempo" });
    expect(plan).toEqual({ enabled: true, voice: "tempo", instructionsLength: 17 });
    expect(JSON.stringify(plan)).not.toContain("segredo");
    expect(describePageChatPatch({ instructions: null })).toEqual({ instructions: null });
  });
});

describe("readPageChatPayload", () => {
  it("allowlists the Console fields", () => {
    const result = readPageChatPayload(
      {
        success: true,
        projectRef: "proj",
        siteRef: "acme-website",
        siteId: "site_1",
        host: "acme-website.ravi.page",
        featureEnabled: true,
        settings: {
          enabled: true,
          assistantName: null,
          voice: "bossa",
          language: "pt-BR",
          instructions: null,
          apiKey: "sk-should-not-leak",
        },
        voices: ["bossa", "tempo", "bossa", 3],
        openaiSecret: "should-not-leak",
      },
      { project: "proj", site: "acme-website" },
    );
    expect(result).toEqual({
      success: true,
      projectRef: "proj",
      siteRef: "acme-website",
      siteId: "site_1",
      host: "acme-website.ravi.page",
      featureEnabled: true,
      settings: { enabled: true, assistantName: null, voice: "bossa", language: "pt-BR", instructions: null },
      voices: ["bossa", "tempo"],
    });
    expect(JSON.stringify(result)).not.toContain("leak");
  });

  it("accepts a nested data envelope and fills defaults", () => {
    const result = readPageChatPayload(
      { success: true, data: { featureEnabled: false, settings: { enabled: false } } },
      { project: "proj", site: "demo" },
    );
    expect(result).toMatchObject({
      projectRef: "proj",
      siteRef: "demo",
      siteId: null,
      host: null,
      featureEnabled: false,
      settings: { enabled: false, assistantName: null, voice: "bossa", language: "pt-BR", instructions: null },
    });
    expect(result.voices).toEqual([...PAGE_CHAT_VOICES]);
  });

  it("rejects a response without settings", () => {
    expect(() => readPageChatPayload({ featureEnabled: true }, { project: "p", site: "s" })).toThrow(
      /invalid Page Chat settings/,
    );
    expect(() =>
      readPageChatPayload({ settings: { enabled: "yes" }, featureEnabled: true }, { project: "p", site: "s" }),
    ).toThrow(/settings.enabled/);
  });
});

describe("Page Chat Console client", () => {
  it("GETs the chat path with a hostname siteRef", async () => {
    const calls: Array<{ method: string; path: string; body: unknown; accessToken: string }> = [];
    const client = makeClient(async (method, path, body, accessToken) => {
      calls.push({ method, path, body, accessToken });
      return consoleResponse();
    });

    const result = await getPageChatSettings(
      { project: "proj", site: "acme-website.ravi.page" },
      { client, readCredentials: () => makeCredentials() },
    );

    expect(pageChatPath("proj", "acme-website.ravi.page")).toBe(
      "/api/cli/projects/proj/pages/acme-website.ravi.page/chat",
    );
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/cli/projects/proj/pages/acme-website.ravi.page/chat",
        body: undefined,
        accessToken: "access-secret",
      },
    ]);
    expect(result).toMatchObject({ consoleUrl: "https://console.example", featureEnabled: true, success: true });
  });

  it("PATCHes only the changed fields and reports them", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client = makeClient(async (method, path, body) => {
      calls.push({ method, path, body });
      return consoleResponse({ settings: { enabled: true, assistantName: null, voice: "tempo", language: "pt-BR" } });
    });

    const result = await updatePageChatSettings(
      { project: "proj", site: "demo", body: { voice: "tempo", assistantName: null } },
      { client, readCredentials: () => makeCredentials() },
    );

    expect(calls).toEqual([
      {
        method: "PATCH",
        path: "/api/cli/projects/proj/pages/demo/chat",
        body: { voice: "tempo", assistantName: null },
      },
    ]);
    expect(result.changed).toEqual(["assistantName", "voice"]);
    expect(result.settings.voice).toBe("tempo");
  });

  it("refuses an empty PATCH before any Console call", async () => {
    const client = makeClient(async () => {
      throw new Error("console should not be called");
    });
    await expect(
      updatePageChatSettings(
        { project: "proj", site: "demo", body: {} },
        { client, readCredentials: () => makeCredentials() },
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_INVALID" });
    expect(client.requestJson).not.toHaveBeenCalled();
  });

  it("passes Console CloudAuthErrors through", async () => {
    const client = makeClient(async () => {
      throw new CloudAuthError("PROJECT_ACCESS_DENIED", "No access to this project.", { status: 403 });
    });
    await expect(
      getPageChatSettings({ project: "proj", site: "demo" }, { client, readCredentials: () => makeCredentials() }),
    ).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
  });
});

function consoleResponse(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    projectRef: "proj",
    siteRef: "demo",
    siteId: "site_1",
    host: "demo.ravi.page",
    featureEnabled: true,
    settings: { enabled: true, assistantName: null, voice: "bossa", language: "pt-BR", instructions: null },
    voices: [...PAGE_CHAT_VOICES],
    ...overrides,
  };
}

function makeClient(
  handler: (method: string, path: string, body: unknown, accessToken: string) => Promise<unknown>,
): ConsoleApiClient {
  return {
    me: mock(async () => ({ user: { email: "alice@example.com" }, organization: { id: "org_1" } })),
    requestJson: mock(async (method: string, path: string, body: unknown, accessToken: string) =>
      handler(method, path, body, accessToken),
    ),
  } as unknown as ConsoleApiClient;
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2099-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2099-06-10T00:00:00.000Z",
    scopes: ["console.projects.read", "console.projects.link", "artifacts.publish"],
    user: { email: "alice@example.com" },
    organization: { id: "org_1", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}
