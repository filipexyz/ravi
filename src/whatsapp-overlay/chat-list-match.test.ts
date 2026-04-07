import { describe, expect, it } from "bun:test";
import { matchOmniChatFromRow } from "./chat-list-match.js";

describe("whatsapp overlay chat-list row matcher", () => {
  it("matches a chat by exact chatId candidate first", () => {
    const match = matchOmniChatFromRow(
      {
        title: "qualquer",
        chatIdCandidate: "120363424772797713@g.us",
      },
      [
        {
          externalId: "120363424772797713@g.us",
          name: "Ravi - Dev",
        },
      ],
    );

    expect(match?.name).toBe("Ravi - Dev");
  });

  it("uses preview and time to disambiguate a short generic title", () => {
    const match = matchOmniChatFromRow(
      {
        title: "namas",
        preview: "manda o arquivo final",
        timeLabel: "19:42",
      },
      [
        {
          externalId: "120363400000000001@g.us",
          name: "Ravi - Dev",
          lastMessagePreview: "manda o arquivo final",
          lastMessageAt: "2026-03-29T18:42:00.000Z",
        },
        {
          externalId: "120363400000000002@g.us",
          name: "Namas",
          lastMessagePreview: "manda o arquivo final",
          lastMessageAt: "2026-03-29T19:42:00.000Z",
        },
      ],
    );

    expect(match?.name).toBe("Namas");
    expect(match?.externalId).toBe("120363400000000002@g.us");
  });

  it("fails closed for a short generic title without preview or time support", () => {
    const match = matchOmniChatFromRow(
      {
        title: "ravi",
      },
      [
        {
          externalId: "120363400000000001@g.us",
          name: "Ravi - Dev",
        },
        {
          externalId: "120363400000000002@g.us",
          name: "Ravi - Audit",
        },
      ],
    );

    expect(match).toBeNull();
  });

  it("fails closed for a single-token title when preview support is weak", () => {
    const match = matchOmniChatFromRow(
      {
        title: "ravi",
        preview: "ravi 12:43 O shell comeu as aspas da mensagem",
        timeLabel: "12:43",
      },
      [
        {
          externalId: "120363424772797713@g.us",
          name: "Ravi - Dev",
          lastMessagePreview:
            "Luís Filipe: [Image] tem algo esquisito acontecendo ainda... quando não é um grupo, como o ravi (é dm) ele ta mostrando errado e as vezes nem detecta...",
          lastMessageAt: "2026-03-30T00:12:52.000Z",
        },
      ],
    );

    expect(match).toBeNull();
  });

  it("prefers the most recent chat when chatId variants collide", () => {
    const match = matchOmniChatFromRow(
      {
        title: "qualquer",
        chatIdCandidate: "551153047744@s.whatsapp.net",
      },
      [
        {
          externalId: "238289734901889@lid",
          canonicalId: "551153047744@s.whatsapp.net",
          name: "Ravi",
          updatedAt: "2026-03-01T12:00:00.000Z",
        },
        {
          externalId: "238289734901889@lid",
          canonicalId: "551153047744@s.whatsapp.net",
          name: "Ravi",
          updatedAt: "2026-03-29T12:00:00.000Z",
        },
      ],
    );

    expect(match?.updatedAt).toBe("2026-03-29T12:00:00.000Z");
  });

  it("prefers the most recent viable candidate for ambiguous generic titles", () => {
    const match = matchOmniChatFromRow(
      {
        title: "namas",
        preview: "manda o arquivo final",
      },
      [
        {
          externalId: "120363400000000001@g.us",
          name: "Namas",
          lastMessagePreview: "manda o arquivo final",
          lastMessageAt: "2026-03-28T19:42:00.000Z",
        },
        {
          externalId: "120363400000000002@g.us",
          name: "Namas",
          lastMessagePreview: "manda o arquivo final",
          lastMessageAt: "2026-03-29T19:42:00.000Z",
        },
      ],
    );

    expect(match?.externalId).toBe("120363400000000002@g.us");
  });
});
