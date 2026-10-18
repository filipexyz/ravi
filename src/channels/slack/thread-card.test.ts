import { describe, expect, it } from "bun:test";
import { validateSlackBlockKitMessage } from "./block-kit.js";
import { buildSlackThreadCard, splitSlackThreadBrief } from "./thread-card.js";

const LONG_BRIEF = [
  "Estudo do Ravi Knowledge para o Luis.",
  "O Luis pediu: estuda como funciona o **ravi knowledge**. Estude a skill ravi-system-knowledge, a ajuda do CLI e a implementação disponível. Explique em português o fluxo de indexação, busca, fontes e confiança, memória de contatos, propostas e aprovações. Use somente leitura, sem alterar configuração. Faça o estudo nesta thread e avise a sessão principal com close-thread --return.",
].join("\n");

function blockTexts(blocks: readonly Record<string, unknown>[]): string[] {
  return blocks.map((block) => {
    const text = block.text as { text?: string } | undefined;
    if (text?.text) return text.text;
    const elements = block.elements as { text?: string }[] | undefined;
    return elements?.map((element) => element.text ?? "").join("") ?? "";
  });
}

describe("Slack thread card", () => {
  it("shows the first line as title, a short summary and the open status", () => {
    const card = buildSlackThreadCard(LONG_BRIEF, { status: "open" });
    validateSlackBlockKitMessage(card);

    expect(card.text).toBe("Estudo do Ravi Knowledge para o Luis.");
    expect(card.blocks.map((block) => block.type)).toEqual(["header", "section", "context"]);
    const [title, summary, status] = blockTexts(card.blocks);
    expect(title).toBe("Estudo do Ravi Knowledge para o Luis.");
    expect(summary?.length).toBeLessThanOrEqual(300);
    expect(summary).toStartWith("O Luis pediu: estuda como funciona o *ravi knowledge*.");
    expect(summary).not.toContain("close-thread");
    expect(status).toBe(":large_green_circle: *Em andamento*  ·  instruções completas na thread");
    expect(card.fullBrief).toContain("close-thread --return");
    expect(card.fullBrief).toStartWith("*Instruções completas*\nEstudo do Ravi Knowledge para o Luis.");
  });

  it("keeps a short brief whole in the card, with nothing posted in the thread", () => {
    const card = buildSlackThreadCard("## Revisar a **PR 690**\nSó o prompt.", { status: "open" });

    expect(blockTexts(card.blocks)).toEqual([
      "Revisar a PR 690",
      "Só o prompt.",
      ":large_green_circle: *Em andamento*",
    ]);
    expect(card.fullBrief).toBeUndefined();
  });

  it("shows the result and the time when the thread closes", () => {
    const card = buildSlackThreadCard(LONG_BRIEF, {
      status: "closed",
      note: "Knowledge indexa fontes do **Console** e locais.",
      updatedAt: 1_713_000_000_000,
    });
    validateSlackBlockKitMessage(card);

    const texts = blockTexts(card.blocks);
    expect(texts[2]).toBe("*Resultado*\nKnowledge indexa fontes do *Console* e locais.");
    expect(texts[3]).toBe(
      ":white_check_mark: *Concluída*  ·  <!date^1713000000^{date_short_pretty} {time}|2024-04-13 09:20 UTC>  ·  instruções completas na thread",
    );
    // A card edit never re-posts the brief; only thread.create does.
    expect(card.fullBrief).toBeDefined();
  });

  it("labels progress on an open or reopened thread", () => {
    const open = buildSlackThreadCard("Investigar", { status: "open", note: "Metade feita" });
    const reopened = buildSlackThreadCard("Investigar", { status: "reopened" });

    expect(blockTexts(open.blocks)).toEqual([
      "Investigar",
      "*Progresso*\nMetade feita",
      ":large_green_circle: *Em andamento*",
    ]);
    expect(blockTexts(reopened.blocks)).toEqual(["Investigar", ":arrows_counterclockwise: *Reaberta*"]);
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
