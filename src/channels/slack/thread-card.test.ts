import { describe, expect, it } from "bun:test";
import { validateSlackBlockKitMessage } from "./block-kit.js";
import { buildSlackThreadCard, splitSlackThreadBrief } from "./thread-card.js";

const LONG_BRIEF = [
  "Estudo do Ravi Knowledge para o Luis.",
  "O Luis pediu: estuda como funciona o **ravi knowledge**. Estude a skill ravi-system-knowledge, a ajuda do CLI e a implementação disponível. Explique em português o fluxo de indexação, busca, fontes e confiança, memória de contatos, propostas e aprovações. Use somente leitura, sem alterar configuração. Faça o estudo nesta thread e avise a sessão principal com close-thread --return.",
].join("\n");

type CardText = { type: string; text: string; verbatim?: boolean };

function cardOf(blocks: readonly Record<string, unknown>[]): Record<string, CardText | string> {
  expect(blocks).toHaveLength(1);
  return blocks[0] as Record<string, CardText | string>;
}

function cardTexts(blocks: readonly Record<string, unknown>[]): Record<string, string> {
  const card = cardOf(blocks);
  const texts: Record<string, string> = {};
  for (const field of ["title", "subtitle", "body", "subtext"]) {
    const value = card[field] as CardText | undefined;
    if (value) texts[field] = value.text;
  }
  return texts;
}

function fallbackTexts(blocks: readonly Record<string, unknown>[]): string[] {
  return blocks.map((block) => {
    const text = block.text as { text?: string } | undefined;
    if (text?.text) return text.text;
    const elements = block.elements as { text?: string }[] | undefined;
    return elements?.map((element) => element.text ?? "").join("") ?? "";
  });
}

describe("Slack thread card", () => {
  it("is one card block: title, a short summary and the open status", () => {
    const card = buildSlackThreadCard(LONG_BRIEF, { status: "open" });
    validateSlackBlockKitMessage(card);

    expect(card.text).toBe("Estudo do Ravi Knowledge para o Luis.");
    expect(cardOf(card.blocks)).toMatchObject({
      type: "card",
      title: { type: "mrkdwn", text: "Estudo do Ravi Knowledge para o Luis.", verbatim: false },
    });
    const texts = cardTexts(card.blocks);
    expect(texts.subtitle).toBeUndefined();
    expect(texts.body?.length).toBeLessThanOrEqual(200);
    expect(texts.body).toStartWith("O Luis pediu: estuda como funciona o *ravi knowledge*.");
    expect(texts.body).not.toContain("close-thread");
    expect(texts.subtext).toBe(":large_green_circle: *Em andamento*  ·  instruções completas na thread");
    expect(card.fullBrief).toContain("close-thread --return");
    expect(card.fullBrief).toStartWith("*Instruções completas*\nEstudo do Ravi Knowledge para o Luis.");
  });

  it("keeps the same content as classic blocks for a Slack that rejects card", () => {
    const card = buildSlackThreadCard(LONG_BRIEF, { status: "closed", note: "Feito", requestedBy: "Ana" });
    validateSlackBlockKitMessage({ text: card.text, blocks: card.fallbackBlocks });
    const texts = cardTexts(card.blocks);

    expect(card.fallbackBlocks.map((block) => block.type)).toEqual(["header", "section", "section", "context"]);
    expect(fallbackTexts(card.fallbackBlocks)).toEqual([card.text, texts.body, texts.subtitle, texts.subtext]);
  });

  it("keeps a short brief whole in the card, with nothing posted in the thread", () => {
    const card = buildSlackThreadCard("## Revisar a **PR 690**\nSó o prompt.", { status: "open" });

    expect(cardTexts(card.blocks)).toEqual({
      title: "Revisar a PR 690",
      body: "Só o prompt.",
      subtext: ":large_green_circle: *Em andamento*",
    });
    expect(card.fullBrief).toBeUndefined();
  });

  it("shows the result as subtitle and the time in the status line when the thread closes", () => {
    const card = buildSlackThreadCard(LONG_BRIEF, {
      status: "closed",
      note: "Knowledge indexa fontes do **Console** e locais.",
      updatedAt: 1_713_000_000_000,
    });
    validateSlackBlockKitMessage(card);

    const texts = cardTexts(card.blocks);
    expect(texts.subtitle).toBe("*Resultado:* Knowledge indexa fontes do *Console* e locais.");
    expect(texts.subtext).toBe(
      ":white_check_mark: *Concluída*  ·  <!date^1713000000^{date_short_pretty} {time}|2024-04-13 09:20 UTC>  ·  instruções completas na thread",
    );
    // A card edit never re-posts the brief; only thread.create does.
    expect(card.fullBrief).toBeDefined();
  });

  it("names who asked, escaped, in the status line", () => {
    const card = buildSlackThreadCard("Investigar & <ver>", { status: "open", requestedBy: "Ana <ops> & Co" });

    expect(cardTexts(card.blocks)).toEqual({
      title: "Investigar &amp; &lt;ver&gt;",
      subtext: ":large_green_circle: *Em andamento*  ·  pedido por Ana &lt;ops&gt; &amp; Co",
    });
  });

  it("labels progress on an open or reopened thread", () => {
    const open = buildSlackThreadCard("Investigar", { status: "open", note: "Metade feita" });
    const reopened = buildSlackThreadCard("Investigar", { status: "reopened" });

    expect(cardTexts(open.blocks)).toEqual({
      title: "Investigar",
      subtitle: "*Progresso:* Metade feita",
      subtext: ":large_green_circle: *Em andamento*",
    });
    expect(cardTexts(reopened.blocks)).toEqual({
      title: "Investigar",
      subtext: ":arrows_counterclockwise: *Reaberta*",
    });
  });

  it("keeps every card field within Slack's limits", () => {
    const link = "[detalhe](https://example.com/um/caminho/bem/comprido/para/crescer/na/conversao)";
    const card = buildSlackThreadCard(`${"Título ".repeat(30)}\n${`${link} `.repeat(20)}`, {
      status: "closed",
      note: `${link} `.repeat(20),
      requestedBy: "Nome ".repeat(30),
      updatedAt: 1_713_000_000_000,
    });
    const texts = cardTexts(card.blocks);

    expect(texts.title?.length).toBeLessThanOrEqual(150);
    expect(texts.subtitle?.length).toBeLessThanOrEqual(150);
    expect(texts.body?.length).toBeLessThanOrEqual(200);
    expect(texts.subtext?.length).toBeLessThanOrEqual(200);
    expect(texts.subtext).toStartWith(":white_check_mark: *Concluída*");
  });

  it("titles a one-paragraph brief with its first sentence", () => {
    const sentence = "Estudar o Knowledge.";
    const brief = `${sentence} ${"Detalhe longo do pedido. ".repeat(10)}`;

    expect(splitSlackThreadBrief(brief)).toEqual({ title: sentence, body: brief.slice(sentence.length).trim() });
  });

  it("cuts a header-sized title when the first sentence is too long", () => {
    const line = "palavra ".repeat(40).trim();
    const split = splitSlackThreadBrief(line);

    expect(split.title.length).toBe(150);
    expect(split.title).toEndWith("…");
    expect(split.body).toBe(line);
  });
});
