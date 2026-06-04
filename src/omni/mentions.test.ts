import { describe, expect, it } from "bun:test";
import {
  extractInboundMentionTargets,
  mentionPlaceholderForId,
  normalizeInboundMentionText,
  prepareOmniMentionMessage,
} from "./mentions.js";

const participants = [
  { platformUserId: "91015272759397@lid", displayName: "Ravi Bot" },
  { platformUserId: "5511947879044@s.whatsapp.net", displayName: "Luís Filipe" },
  { platformUserId: "5511999999999@s.whatsapp.net", displayName: "Israel Nunes" },
];

describe("Omni mention preparation", () => {
  it("resolves inline participant names to native WhatsApp mention payloads", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@ravi olha isso",
      participants,
    });

    expect(prepared.text).toBe("@91015272759397 olha isso");
    expect(prepared.mentions).toEqual([{ id: "91015272759397@lid", type: "user" }]);
    expect(prepared.resolved[0]).toMatchObject({
      id: "91015272759397@lid",
      displayName: "Ravi Bot",
      source: "inline",
    });
  });

  it("resolves exact full display names with spaces", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi @Ravi Bot",
      participants,
    });

    expect(prepared.text).toBe("oi @91015272759397");
    expect(prepared.mentions).toEqual([{ id: "91015272759397@lid", type: "user" }]);
  });

  it("prefixes explicit mentions when the message has no placeholder", () => {
    const prepared = prepareOmniMentionMessage({
      text: "olha isso",
      explicitTargets: ["Israel"],
      participants,
    });

    expect(prepared.text).toBe("@5511999999999 olha isso");
    expect(prepared.mentions).toEqual([{ id: "5511999999999@s.whatsapp.net", type: "user" }]);
  });

  it("uses explicit raw JIDs without requiring participant metadata", () => {
    const prepared = prepareOmniMentionMessage({
      text: "teste",
      explicitTargets: ["91015272759397@lid"],
    });

    expect(prepared.text).toBe("@91015272759397 teste");
    expect(prepared.mentions).toEqual([{ id: "91015272759397@lid", type: "user" }]);
  });

  it("normalizes accents and unique first names", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@Luis confere",
      participants,
    });

    expect(prepared.text).toBe("@5511947879044 confere");
    expect(prepared.mentions).toEqual([{ id: "5511947879044@s.whatsapp.net", type: "user" }]);
  });

  it("prefers a trusted phone alias when the group member id is a raw WhatsApp LID", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@Luis confere",
      participants: [
        {
          platformUserId: "178035101794451",
          normalizedPlatformUserId: "5511947879044",
          displayName: "Luís Filipe",
        },
      ],
    });

    expect(prepared.text).toBe("@5511947879044 confere");
    expect(prepared.mentions).toEqual([{ id: "5511947879044@s.whatsapp.net", type: "user" }]);
    expect(prepared.resolved[0]).toMatchObject({
      id: "5511947879044@s.whatsapp.net",
      displayName: "Luís Filipe",
    });
  });

  it("does not resolve partial inline names", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@Luisalgo confere @Lu",
      participants,
    });

    expect(prepared.text).toBe("@Luisalgo confere @Lu");
    expect(prepared.mentions).toEqual([]);
  });

  it("resolves exact numeric participant ids and ignores wrong-length suffixes", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi @91015272759397 e @910152727593970",
      participants,
    });

    expect(prepared.text).toBe("oi @91015272759397 e @910152727593970");
    expect(prepared.mentions).toEqual([{ id: "91015272759397@lid", type: "user" }]);
  });

  it("does not resolve inline ids that are not participants", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi @12345678901234",
      participants,
    });

    expect(prepared.text).toBe("oi @12345678901234");
    expect(prepared.mentions).toEqual([]);
  });

  it("fails explicit ambiguous names instead of guessing", () => {
    expect(() =>
      prepareOmniMentionMessage({
        text: "oi",
        explicitTargets: ["Luis"],
        participants: [
          { platformUserId: "5511111111111@s.whatsapp.net", displayName: "Luis" },
          { platformUserId: "5522222222222@s.whatsapp.net", displayName: "Luis" },
        ],
      }),
    ).toThrow("ambiguous");
  });

  it("formats mention placeholders from JIDs", () => {
    expect(mentionPlaceholderForId("91015272759397@lid")).toBe("@91015272759397");
    expect(mentionPlaceholderForId("5511999999999@s.whatsapp.net")).toBe("@5511999999999");
  });

  it("renders inbound numeric WhatsApp mention placeholders as known names", () => {
    const normalized = normalizeInboundMentionText({
      text: "@91015272759397 viu quem marquei?",
      rawPayload: {
        mentionedJids: ["91015272759397@lid"],
        mentionedContacts: [{ jid: "91015272759397@lid", name: "ravi" }],
      },
    });

    expect(normalized.text).toBe("@ravi viu quem marquei?");
    expect(normalized.replacements).toEqual([
      {
        placeholder: "@91015272759397",
        replacement: "@ravi",
        id: "91015272759397@lid",
        displayName: "ravi",
      },
    ]);
  });

  it("uses nested WhatsApp contextInfo mentionedJid with a name resolver", () => {
    const normalized = normalizeInboundMentionText({
      text: "oi @5511947879044",
      rawPayload: {
        message: {
          extendedTextMessage: {
            contextInfo: {
              mentionedJid: ["5511947879044@s.whatsapp.net"],
            },
          },
        },
      },
      resolveName: (id) => (id === "5511947879044@s.whatsapp.net" ? "Luis Filipe" : null),
    });

    expect(normalized.text).toBe("oi @Luis Filipe");
  });

  it("extracts formal inbound mention targets from WhatsApp raw payload", () => {
    const targets = extractInboundMentionTargets({
      mentionedJids: ["91015272759397@lid"],
      mentionedContacts: [{ jid: "91015272759397@lid", name: "Ravi Bot" }],
      message: {
        extendedTextMessage: {
          contextInfo: {
            mentionedJid: ["5511947879044@s.whatsapp.net"],
          },
        },
      },
    });

    expect(targets).toEqual([
      { id: "91015272759397@lid", displayName: "Ravi Bot" },
      { id: "5511947879044@s.whatsapp.net", displayName: undefined },
    ]);
  });
});
