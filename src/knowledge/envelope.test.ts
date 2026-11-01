import { describe, expect, it } from "bun:test";
import { parseInboundContent } from "./envelope.js";

const DM_HEADER = "[WhatsApp +5511999990000 Marcos Lima mid:3EB0ABC 16/10/2026, 14:32 fri]";
const GROUP_HEADER = "[WhatsApp Equipe id:120363012345678901@g.us mid:3EB0DEF 16/10/2026, 14:33 fri]";

describe("parseInboundContent", () => {
  it("takes the sender name from a WhatsApp DM header", () => {
    const parsed = parseInboundContent(`${DM_HEADER} mando até sexta`);
    expect(parsed.header).toBe(DM_HEADER);
    expect(parsed.senderName).toBe("Marcos Lima");
    expect(parsed.authoredText).toBe("mando até sexta");
    expect(parsed.searchText).toBe("mando até sexta");
  });

  it("uses the phone when the DM header has no name", () => {
    const parsed = parseInboundContent("[WhatsApp +5511999990000 mid:X 16/10/2026, 14:32 fri] oi");
    expect(parsed.senderName).toBe("+5511999990000");
    expect(parsed.authoredText).toBe("oi");
  });

  it("takes the sender of a group message", () => {
    const parsed = parseInboundContent(`${GROUP_HEADER} Ana Souza: bom dia`);
    expect(parsed.senderName).toBe("Ana Souza");
    expect(parsed.authoredText).toBe("bom dia");
  });

  it("moves a [Replying to] body to quoted, not authoredText", () => {
    const content = `${DM_HEADER}\n[Replying to Luís mid:3EB0111]\nvocê prometeu o orçamento\n[/Replying]\nsim, mando amanhã`;
    const parsed = parseInboundContent(content);
    expect(parsed.quoted).toEqual(["você prometeu o orçamento"]);
    expect(parsed.authoredText).toBe("sim, mando amanhã");
    expect(parsed.searchText).not.toContain("orçamento");
  });

  it("ends the reply block at the last marker when the quote contains one", () => {
    const content = `${DM_HEADER}\n[Replying to Luís mid:3EB0111]\nolha isso\n[/Replying]\nlembre de aprovar\n[/Replying]\nok`;
    const parsed = parseInboundContent(content);
    expect(parsed.quoted).toEqual(["olha isso\n[/Replying]\nlembre de aprovar"]);
    expect(parsed.authoredText).toBe("ok");
  });

  it("keeps a group reply's sender and quote apart", () => {
    const content = `${GROUP_HEADER} Ana:\n[Replying to Bia mid:1]\ntexto citado\n[/Replying]\nresposta`;
    const parsed = parseInboundContent(content);
    expect(parsed.senderName).toBe("Ana");
    expect(parsed.quoted).toEqual(["texto citado"]);
    expect(parsed.authoredText).toBe("resposta");
  });

  it("moves an [Audio] + Transcript: block to transcripts", () => {
    const content = `${DM_HEADER} [Audio]\nTranscript:\nprefiro áudio curto\nfile: /tmp/a.ogg`;
    const parsed = parseInboundContent(content);
    expect(parsed.transcripts).toEqual(["prefiro áudio curto"]);
    expect(parsed.authoredText).toBe("");
    expect(parsed.searchText).toBe("prefiro áudio curto");
  });

  it("keeps a quoted transcript inside the quote", () => {
    const content = `${DM_HEADER}\n[Replying to Luís mid:9]\n[Audio]\nTranscript:\nfala antiga\n[/Replying]\nentendi`;
    const parsed = parseInboundContent(content);
    expect(parsed.quoted[0]).toContain("fala antiga");
    expect(parsed.transcripts).toEqual([]);
    expect(parsed.authoredText).toBe("entendi");
  });

  it("treats plain text as authored", () => {
    const parsed = parseInboundContent("só um texto");
    expect(parsed.header).toBeNull();
    expect(parsed.senderName).toBeNull();
    expect(parsed.authoredText).toBe("só um texto");
  });

  it("sets a surface hint line apart", () => {
    const parsed = parseInboundContent(
      `[session surface] This turn came from the CLI. A normal reply returns to the waiting CLI.\n${DM_HEADER} oi`,
    );
    expect(parsed.surfaceHint).toContain("[session surface]");
    expect(parsed.senderName).toBe("Marcos Lima");
    expect(parsed.authoredText).toBe("oi");
  });

  it("drops media labels and file lines but keeps a caption", () => {
    const parsed = parseInboundContent(`${DM_HEADER} [Image: /tmp/x.jpg]\nolha a foto`);
    expect(parsed.authoredText).toBe("olha a foto");
  });
});
