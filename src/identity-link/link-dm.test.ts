import { describe, expect, it } from "bun:test";
import type { OutboundAccountResolution } from "../channels/account-resolution.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { LinkRequester } from "../cloud-auth/link-identity.js";
import { slackNative } from "./fake-console.fixture.js";
import { linkRequestDmText, resolveLinkDmRoute } from "./link-dm.js";

const omni = (accountId: string | undefined): OutboundAccountResolution => ({
  kind: "omni",
  accountId: accountId ?? "",
  instanceId: "omni-1",
});

function requester(origin: LinkRequester["origin"], platformUserId: string | null): LinkRequester {
  return {
    contactId: "contact_luis",
    actorPrincipal: "contact:contact_luis",
    platformUserId,
    platformIdentityId: null,
    displayName: "Luís",
    origin,
    platformIdentity: null,
  };
}

function unsupported(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof CloudAuthError ? error.code : undefined;
  }
  return undefined;
}

describe("resolveLinkDmRoute", () => {
  it("messages the Slack author's user id, never the channel", () => {
    const route = resolveLinkDmRoute(
      requester({ channel: "slack", accountId: "acme", chatId: "C0CHANNEL", threadId: "1.2" }, "U0LUIS"),
      slackNative,
    );
    expect(route).toEqual({ channel: "slack", accountId: "acme", recipient: "U0LUIS", slackUserId: "U0LUIS" });
  });

  it("refuses Slack without the native adapter or without a person as sender", () => {
    const origin = { channel: "slack", accountId: "acme", chatId: "C0CHANNEL" };
    expect(unsupported(() => resolveLinkDmRoute(requester(origin, "U0LUIS"), omni))).toBe("LINK_DM_UNSUPPORTED");
    expect(unsupported(() => resolveLinkDmRoute(requester(origin, "B0BOT"), slackNative))).toBe("LINK_DM_UNSUPPORTED");
    expect(unsupported(() => resolveLinkDmRoute(requester(origin, null), slackNative))).toBe("LINK_DM_UNSUPPORTED");
  });

  it("messages the WhatsApp sender's own number from a group and answers in place in a direct chat", () => {
    const fromGroup = resolveLinkDmRoute(
      requester({ channel: "whatsapp", accountId: "wa-main", chatId: "group:120363000000000000" }, "5511999999999"),
      omni,
    );
    expect(fromGroup).toEqual({ channel: "whatsapp", accountId: "wa-main", recipient: "5511999999999" });

    const fromDm = resolveLinkDmRoute(
      requester({ channel: "whatsapp", accountId: "wa-main", chatId: "5511999999999@s.whatsapp.net" }, "5511999999999"),
      omni,
    );
    expect(fromDm.recipient).toBe("5511999999999@s.whatsapp.net");
  });

  it("never targets a WhatsApp group", () => {
    const route = requester(
      { channel: "whatsapp", accountId: "wa-main", chatId: "120363000000000000@g.us" },
      "120363@g.us",
    );
    expect(unsupported(() => resolveLinkDmRoute(route, omni))).toBe("LINK_DM_UNSUPPORTED");
  });

  it("refuses channels without private delivery", () => {
    const route = requester({ channel: "telegram", accountId: "tg", chatId: "-100123" }, "42");
    expect(unsupported(() => resolveLinkDmRoute(route, omni))).toBe("LINK_DM_UNSUPPORTED");
  });
});

describe("linkRequestDmText", () => {
  it("hides the URL behind a label on Slack and shows it bare on WhatsApp", () => {
    const input = { approveUrl: "https://console.example/link/t", displayName: "Luís Filipe", expiresInMinutes: 10 };
    const slack = linkRequestDmText({ ...input, channel: "slack" });
    const whatsapp = linkRequestDmText({ ...input, channel: "whatsapp" });
    expect(slack).toStartWith("Oi, Luís!");
    expect(slack).toContain("[Abrir e aprovar o vínculo](https://console.example/link/t)");
    expect(whatsapp).toContain("\n\nhttps://console.example/link/t\n\n");
    expect(whatsapp).toContain("vale por 10 minutos e funciona uma vez");
  });
});
