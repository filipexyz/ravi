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

    expect(prepared.text).toBe("@Ravi Bot olha isso");
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

    expect(prepared.text).toBe("oi @Ravi Bot");
    expect(prepared.mentions).toEqual([{ id: "91015272759397@lid", type: "user" }]);
  });

  it("prefixes explicit mentions when the message has no placeholder", () => {
    const prepared = prepareOmniMentionMessage({
      text: "olha isso",
      explicitTargets: ["Israel"],
      participants,
    });

    expect(prepared.text).toBe("@Israel Nunes olha isso");
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

    expect(prepared.text).toBe("@Luís Filipe confere");
    expect(prepared.mentions).toEqual([{ id: "5511947879044@s.whatsapp.net", type: "user" }]);
  });

  it("uses the native LID mention id when a group member has a distinct phone alias", () => {
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

    expect(prepared.text).toBe("@Luís Filipe confere");
    expect(prepared.mentions).toEqual([{ id: "178035101794451@lid", type: "user" }]);
    expect(prepared.resolved[0]).toMatchObject({
      id: "178035101794451@lid",
      displayName: "Luís Filipe",
    });
  });

  it("can emit native WhatsApp placeholders for outbound group delivery", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@Luis confere",
      participants: [
        {
          platformUserId: "178035101794451",
          normalizedPlatformUserId: "5511947879044",
          displayName: "Luís Filipe",
        },
      ],
      placeholderMode: "native",
    });

    expect(prepared.text).toBe("@178035101794451 confere");
    expect(prepared.mentions).toEqual([{ id: "178035101794451@lid", type: "user" }]);
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

    expect(prepared.text).toBe("oi @Ravi Bot e @910152727593970");
    expect(prepared.mentions).toEqual([{ id: "91015272759397@lid", type: "user" }]);
  });

  it("does not auto-resolve raw participant ids without a safe display label", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi @91015272759397",
      participants: [{ platformUserId: "91015272759397@lid" }],
    });

    expect(prepared.text).toBe("oi @91015272759397");
    expect(prepared.mentions).toEqual([]);
  });

  it("does not resolve inline ids that are not participants", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi @12345678901234",
      participants,
    });

    expect(prepared.text).toBe("oi @12345678901234");
    expect(prepared.mentions).toEqual([]);
  });

  it("can resolve inline phone placeholders as WhatsApp mentions when enabled", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@5511947879044, cola isso no terminal pra ver:",
      autoResolvePhoneNumbers: true,
    });

    expect(prepared.text).toBe("@5511947879044, cola isso no terminal pra ver:");
    expect(prepared.mentions).toEqual([{ id: "5511947879044@s.whatsapp.net", type: "user" }]);
    expect(prepared.resolved[0]).toMatchObject({
      id: "5511947879044@s.whatsapp.net",
      placeholder: "@5511947879044",
      source: "inline",
    });
  });

  it("keeps inline phone placeholders as plain text unless the WhatsApp fallback is enabled", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi @5511947879044",
    });

    expect(prepared.text).toBe("oi @5511947879044");
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

describe("explicit mention targets already written in the text", () => {
  // Incident 2026-11-24: `ravi whatsapp group send <grupo> "@5511987860700 oi" --mention 5511987860700`
  // went out as "@5511987860700 @5511987860700 oi" with two mention entries for the same person.
  const groupSendOptions = { autoResolvePhoneNumbers: true, placeholderMode: "native" } as const;

  it("does not repeat a phone placeholder the text already has (group send with --mention <phone>)", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@5511987860700 oi, tudo bem?",
      explicitTargets: ["5511987860700"],
      ...groupSendOptions,
    });

    expect(prepared.text).toBe("@5511987860700 oi, tudo bem?");
    expect(prepared.mentions).toEqual([{ id: "5511987860700@s.whatsapp.net", type: "user" }]);
    expect(prepared.resolved).toHaveLength(1);
  });

  it("treats a phone JID target and the same phone written in the text as one mention", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi @5511987860700, confere?",
      explicitTargets: ["5511987860700@s.whatsapp.net"],
      ...groupSendOptions,
    });

    expect(prepared.text).toBe("oi @5511987860700, confere?");
    expect(prepared.mentions).toEqual([{ id: "5511987860700@s.whatsapp.net", type: "user" }]);
  });

  it("treats a formatted phone target and the same phone written in the text as one mention", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@5511987860700 oi",
      explicitTargets: ["+55 11 98786-0700"],
      ...groupSendOptions,
    });

    expect(prepared.text).toBe("@5511987860700 oi");
    expect(prepared.mentions).toHaveLength(1);
  });

  it("does not repeat the placeholder even when inline phone auto-resolution is off", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@5511987860700 oi",
      explicitTargets: ["5511987860700"],
    });

    expect(prepared.text).toBe("@5511987860700 oi");
    expect(prepared.mentions).toHaveLength(1);
  });

  it("does not repeat the placeholder for a formatted phone target when inline auto-resolution is off", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@5511987860700 oi",
      explicitTargets: ["+55 11 98786-0700"],
    });

    expect(prepared.text).toBe("@5511987860700 oi");
    expect(prepared.mentions).toHaveLength(1);
  });

  it("does not repeat a placeholder for a target written as a name that the text already has", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@Israel Nunes olha isso",
      explicitTargets: ["Israel"],
      participants,
    });

    expect(prepared.text).toBe("@Israel Nunes olha isso");
    expect(prepared.mentions).toEqual([{ id: "5511999999999@s.whatsapp.net", type: "user" }]);
  });

  it("still prefixes the placeholder when the text does not mention the target", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi, tudo bem?",
      explicitTargets: ["5511987860700"],
      ...groupSendOptions,
    });

    expect(prepared.text).toBe("@5511987860700 oi, tudo bem?");
    expect(prepared.mentions).toHaveLength(1);
  });

  it("keeps two different people as two mentions", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@5511987860700 e @5511911112222 oi",
      explicitTargets: ["5511987860700", "5511911112222"],
      ...groupSendOptions,
    });

    expect(prepared.text).toBe("@5511987860700 e @5511911112222 oi");
    expect(prepared.mentions.map((mention) => mention.id).sort()).toEqual([
      "5511911112222@s.whatsapp.net",
      "5511987860700@s.whatsapp.net",
    ]);
  });

  it("adds a second explicit person that the text does not mention, without repeating the first", () => {
    const prepared = prepareOmniMentionMessage({
      text: "@5511987860700 oi",
      explicitTargets: ["5511987860700", "5511911112222"],
      ...groupSendOptions,
    });

    expect(prepared.text).toBe("@5511911112222 @5511987860700 oi");
    expect(prepared.mentions).toHaveLength(2);
  });
});

describe("the same person written as @lid and as a phone", () => {
  // Review of #975 (N2). Omni's chat model gives the LID as bare digits (`platformUserId`) and the phone as an alias
  // (`normalizedPlatformUserId`). A `<phone>@s.whatsapp.net` target did not match that bare-digit identity, so the same
  // person was mentioned twice, once per form.
  const LID = "91015272759397";
  const PHONE = "5511987860700";
  const send = { autoResolvePhoneNumbers: true, placeholderMode: "native" } as const;
  const bareLidMember = { platformUserId: LID, normalizedPlatformUserId: PHONE, displayName: "Gus Kurozawa" };

  it("unites a @lid in the text with the same person's phone JID in --mention (bare-digit LID, phone alias)", () => {
    const prepared = prepareOmniMentionMessage({
      text: `@${LID} oi`,
      explicitTargets: [`${PHONE}@s.whatsapp.net`],
      participants: [bareLidMember],
      ...send,
    });

    expect(prepared.text).toBe(`@${LID} oi`);
    expect(prepared.mentions).toEqual([{ id: `${LID}@lid`, type: "user" }]);
  });

  it("unites a phone in the text with the same person's @lid in --mention", () => {
    const prepared = prepareOmniMentionMessage({
      text: `@${PHONE} oi`,
      explicitTargets: [`${LID}@lid`],
      participants: [bareLidMember],
      ...send,
    });

    expect(prepared.mentions).toEqual([{ id: `${LID}@lid`, type: "user" }]);
    expect(prepared.text.match(new RegExp(`@${LID}`, "g"))).toHaveLength(1);
  });

  it("unites two --mention targets that are the same person as @lid and as phone JID", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi",
      explicitTargets: [`${LID}@lid`, `${PHONE}@s.whatsapp.net`],
      participants: [bareLidMember],
      ...send,
    });

    expect(prepared.mentions).toEqual([{ id: `${LID}@lid`, type: "user" }]);
    expect(prepared.text).toBe(`@${LID} oi`);
  });

  it("unites them when the member's phone is stored with formatting, and mentions the member by the @lid", () => {
    const prepared = prepareOmniMentionMessage({
      text: `@${PHONE} oi`,
      explicitTargets: [`${LID}@lid`],
      participants: [{ platformUserId: `${LID}@lid`, phoneNumber: "+55 11 98786-0700", displayName: "Gus Kurozawa" }],
      ...send,
    });

    expect(prepared.mentions).toEqual([{ id: `${LID}@lid`, type: "user" }]);
    expect(prepared.text).toBe(`@${LID} oi`);
  });

  it("does not take a bare-digit LID for a phone when the member's phone is stored with formatting", () => {
    const prepared = prepareOmniMentionMessage({
      text: `@${LID} oi`,
      participants: [{ platformUserId: LID, phoneNumber: "+55 11 98786-0700", displayName: "Gus Kurozawa" }],
      ...send,
    });

    expect(prepared.mentions).toEqual([{ id: `${LID}@lid`, type: "user" }]);
  });

  it("mentions a member by the native @lid id when only the phone JID is given", () => {
    const prepared = prepareOmniMentionMessage({
      text: "oi",
      explicitTargets: [`${PHONE}@s.whatsapp.net`],
      participants: [bareLidMember],
      ...send,
    });

    expect(prepared.mentions).toEqual([{ id: `${LID}@lid`, type: "user" }]);
    expect(prepared.text).toBe(`@${LID} oi`);
  });

  it("unites ids that two passes resolved differently (display mode, member without a safe name)", () => {
    // The inline pass skips a member with no usable display name in display mode, so `@<phone>` falls to the phone
    // fallback while the explicit `@lid` target resolves through the metadata. They are still one person.
    const prepared = prepareOmniMentionMessage({
      text: `@${PHONE} oi`,
      explicitTargets: [`${LID}@lid`],
      participants: [{ platformUserId: `${LID}@lid`, phoneJid: `${PHONE}@s.whatsapp.net` }],
      autoResolvePhoneNumbers: true,
    });

    expect(prepared.mentions).toHaveLength(1);
  });

  it("keeps two different members as two mentions", () => {
    const prepared = prepareOmniMentionMessage({
      text: `@${LID} e @5511911112222 oi`,
      explicitTargets: [`${PHONE}@s.whatsapp.net`, "5511911112222"],
      participants: [
        bareLidMember,
        { platformUserId: "100000000000002", normalizedPlatformUserId: "5511911112222", displayName: "Outro Membro" },
      ],
      ...send,
    });

    expect(prepared.mentions.map((mention) => mention.id).sort()).toEqual(["100000000000002@lid", `${LID}@lid`]);
  });

  // Known limit, documented in the skill: without metadata that links the two forms nothing can tell they are one person.
  it("cannot unite a @lid and a phone when no metadata links them", () => {
    const prepared = prepareOmniMentionMessage({
      text: `@${LID}@lid oi`,
      explicitTargets: [PHONE],
      ...send,
    });

    expect(prepared.mentions).toHaveLength(2);
  });
});
