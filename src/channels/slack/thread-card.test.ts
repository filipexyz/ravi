import { describe, expect, it } from "bun:test";
import { validateSlackBlockKitMessage } from "./block-kit.js";
import {
  buildSlackThreadCard,
  parseSlackDecisionAnswerValue,
  SLACK_DECISION_ANSWER_ACTION_ID,
  slackThreadCardDecisions,
  SLACK_THREAD_CLOSE_ACTION_ID,
  SLACK_THREAD_STOP_ACTION_ID,
  splitSlackThreadBrief,
} from "./thread-card.js";

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
  it("prioritizes a pending question with accessible fallback and removes the cue after answer", () => {
    const waiting = buildSlackThreadCard("Publish report\nReview and publish.", {
      status: "waiting",
      note: "Which window?",
    });
    validateSlackBlockKitMessage(waiting);
    validateSlackBlockKitMessage({ text: waiting.text, blocks: waiting.fallbackBlocks });
    expect(cardTexts(waiting.blocks).subtitle).toBe("*Decisão pendente:* Which window?");
    expect(cardTexts(waiting.blocks).subtext).toContain("Aguardando decisão");
    expect(waiting.text).toContain("Which window?");
    expect(fallbackTexts(waiting.fallbackBlocks).join(" ")).toContain("Which window?");
    const answered = buildSlackThreadCard("Publish report\nReview and publish.", {
      status: "open",
      note: "Resposta registrada; entrega pendente.",
    });
    expect(cardTexts(answered.blocks).subtext).not.toContain("Aguardando decisão");
  });

  it("bounds and escapes the waiting notification so question text cannot ping Slack members", () => {
    const card = buildSlackThreadCard("Review report", {
      status: "waiting",
      note: "<!channel> <!here> <@U123> & " + "long question ".repeat(100),
    });
    expect(card.text).not.toContain("<!channel>");
    expect(card.text).not.toContain("<!here>");
    expect(card.text).not.toContain("<@U123>");
    expect(card.text).toContain("&lt;!channel&gt;");
    expect(card.text.length).toBeLessThanOrEqual("Review report — Aguardando decisão: ".length + 150);
    expect(buildSlackThreadCard("Review report", { status: "open", note: "<!channel>" }).text).toBe("Review report");
  });

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
    expect(card.fullBrief).toStartWith("**Instruções completas**\n\nEstudo do Ravi Knowledge para o Luis.");
  });

  it("keeps the same content as classic blocks for a Slack that rejects card", () => {
    const card = buildSlackThreadCard(LONG_BRIEF, { status: "closed", note: "Feito", requestedBy: "Ana" });
    validateSlackBlockKitMessage({ text: card.text, blocks: card.fallbackBlocks });
    const texts = cardTexts(card.blocks);

    expect(card.fallbackBlocks.map((block) => block.type)).toEqual(["header", "section", "section", "context"]);
    expect(fallbackTexts(card.fallbackBlocks)).toEqual([card.text, texts.subtitle, texts.body, texts.subtext]);
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
    const ampersands = cardTexts(buildSlackThreadCard("&".repeat(140), { status: "open" }).blocks).title ?? "";
    expect(ampersands.length).toBeLessThanOrEqual(150);
    expect(ampersands).toMatch(/^(&amp;)+…$/);
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

  it("renders shell-typed \\n in the brief and note as line breaks", () => {
    const brief = `Publicar Ravi Console Fleet no GitHub\\n\\n${"Luís autorizou criar o repositório privado. ".repeat(8)}`;
    const card = buildSlackThreadCard(brief, { status: "open", note: "Repo criado\\nfaltando o push" });
    const texts = cardTexts(card.blocks);

    expect(card.text).toBe("Publicar Ravi Console Fleet no GitHub");
    expect(texts.body).toStartWith("Luís autorizou");
    expect(texts.subtitle).toBe("*Progresso:* Repo criado\nfaltando o push");
    expect(card.fullBrief).toStartWith("**Instruções completas**\n\nPublicar Ravi Console Fleet no GitHub\n\nLuís");
    expect(JSON.stringify(card)).not.toContain("\\\\n");
  });

  describe("Fechar and Parar", () => {
    const BRIEF = "Estudar o Knowledge.\nLer a skill e explicar o fluxo.";

    function buttonsOf(blocks: readonly Record<string, unknown>[]) {
      const actions = blocks.find((block) => block.type === "actions") as
        | { block_id: string; elements: Array<Record<string, unknown>> }
        | undefined;
      return actions;
    }

    it("puts both buttons under the card of a Ravi thread, each behind Slack's own confirmation", () => {
      const card = buildSlackThreadCard(BRIEF, { status: "open", controls: true });

      validateSlackBlockKitMessage(card);
      validateSlackBlockKitMessage({ text: card.text, blocks: card.fallbackBlocks });
      expect(card.blocks.map((block) => block.type)).toEqual(["card", "actions"]);
      expect(card.fallbackBlocks.at(-1)?.type).toBe("actions");
      const actions = buttonsOf(card.blocks);
      expect(actions?.block_id).toBe("ravi_thread_controls");
      expect(actions?.elements.map((element) => element.action_id)).toEqual([
        SLACK_THREAD_CLOSE_ACTION_ID,
        SLACK_THREAD_STOP_ACTION_ID,
      ]);
      for (const element of actions?.elements ?? []) {
        expect(element.type).toBe("button");
        expect(element.confirm).toMatchObject({ confirm: { type: "plain_text" }, deny: { type: "plain_text" } });
        // The click names the thread by the card's own message, so the button carries nothing else.
        expect(element.value).toBe("thread");
      }
      expect(buttonsOf(card.fallbackBlocks)).toEqual(actions);
    });

    it("keeps them on every state that is not closed, and drops them from a closed one", () => {
      for (const status of ["open", "reopened", "waiting"] as const) {
        const card = buildSlackThreadCard(BRIEF, { status, controls: true, note: "x" });
        expect(buttonsOf(card.blocks)).toBeDefined();
        expect(buttonsOf(card.fallbackBlocks)).toBeDefined();
      }
      const closed = buildSlackThreadCard(BRIEF, { status: "closed", controls: true, note: "Resultado" });
      expect(buttonsOf(closed.blocks)).toBeUndefined();
      expect(buttonsOf(closed.fallbackBlocks)).toBeUndefined();
    });

    it("leaves every other card alone: a card built without `controls` has no buttons", () => {
      const card = buildSlackThreadCard(BRIEF, { status: "open" });

      expect(card.blocks).toHaveLength(1);
      expect(buttonsOf(card.blocks)).toBeUndefined();
      expect(buttonsOf(card.fallbackBlocks)).toBeUndefined();
    });
  });
});

describe("Responder on a card waiting for a decision", () => {
  const actionIds = (blocks: readonly Record<string, unknown>[]) =>
    blocks.flatMap((block) =>
      Array.isArray(block.elements) ? (block.elements as Array<{ action_id?: string; value?: string }>) : [],
    );

  it("offers Responder with only the decision id and revision", () => {
    const card = buildSlackThreadCard("Decide\nBrief", {
      status: "waiting",
      controls: true,
      note: "Sonnet ou Opus?",
      decisions: [{ id: "dec_abc123", revision: 3 }],
    });
    const responder = actionIds(card.blocks).find((b) => b.action_id === SLACK_DECISION_ANSWER_ACTION_ID);
    expect(responder?.value).toBe("dec_abc123:3");
    expect(parseSlackDecisionAnswerValue(responder?.value)).toEqual({ id: "dec_abc123", revision: 3 });
  });

  it("offers nothing when the card is not waiting or has no decision for a person", () => {
    for (const card of [
      buildSlackThreadCard("Decide\nBrief", {
        status: "open",
        controls: true,
        decisions: [{ id: "dec_x", revision: 1 }],
      }),
      buildSlackThreadCard("Decide\nBrief", {
        status: "closed",
        controls: true,
        decisions: [{ id: "dec_x", revision: 1 }],
      }),
      buildSlackThreadCard("Decide\nBrief", { status: "waiting", controls: true, note: "?" }),
    ])
      expect(actionIds(card.blocks).some((b) => b.action_id === SLACK_DECISION_ANSWER_ACTION_ID)).toBe(false);
  });

  it("parses only a decision id and a positive revision", () => {
    for (const value of ["", "dec_x", "dec_x:0", "dec_x:-1", "x:1", "dec_x:1:2", "dec_ x:1", 5, null])
      expect(parseSlackDecisionAnswerValue(value)).toBeNull();
  });
});

describe("Responder for each decision a person owns", () => {
  it("offers one button per decision, each with its own action id, value and key", () => {
    const card = buildSlackThreadCard("Decide\nBrief", {
      status: "waiting",
      controls: true,
      note: "?",
      decisions: [
        { id: "dec_one", revision: 1, key: "modelo" },
        { id: "dec_two", revision: 4, key: "prazo" },
      ],
    });
    const block = card.blocks.find((b) => b.block_id === "ravi_decision_actions") as {
      elements: Array<{ action_id: string; value: string; text: { text: string } }>;
    };
    expect(block.elements.map((e) => e.action_id)).toEqual(["ravi_decision_answer", "ravi_decision_answer_2"]);
    expect(block.elements.map((e) => e.value)).toEqual(["dec_one:1", "dec_two:4"]);
    expect(block.elements.map((e) => e.text.text)).toEqual(["Responder: modelo", "Responder: prazo"]);
  });

  it("caps the buttons at five", () => {
    const card = buildSlackThreadCard("Decide\nBrief", {
      status: "waiting",
      decisions: Array.from({ length: 7 }, (_, i) => ({ id: `dec_${i}`, revision: 1, key: `k${i}` })),
    });
    const block = card.blocks.find((b) => b.block_id === "ravi_decision_actions") as { elements: unknown[] };
    expect(block.elements).toHaveLength(5);
  });
});

describe("which pending decisions the card offers", () => {
  const pending = (ownerType: string, key: string, id = `dec_${key}`) => ({ id, revision: 1, key, ownerType });

  it("offers a person's question behind an agent's, named so it is never an unnamed button", () => {
    expect(slackThreadCardDecisions([pending("agent", "deploy"), pending("human", "modelo")])).toEqual([
      { id: "dec_modelo", revision: 1, key: "modelo" },
    ]);
  });

  it("leaves a lone person's question unnamed and offers nothing for agents or unassigned owners", () => {
    expect(slackThreadCardDecisions([pending("human", "modelo")])).toEqual([{ id: "dec_modelo", revision: 1 }]);
    expect(slackThreadCardDecisions([pending("agent", "a"), pending("unassigned", "b")])).toEqual([]);
  });

  it("names the button of a lone person's question behind an agent's", () => {
    const card = buildSlackThreadCard("Decide\nBrief", {
      status: "waiting",
      decisions: slackThreadCardDecisions([pending("agent", "deploy"), pending("human", "modelo")]),
    });
    const block = card.blocks.find((b) => b.block_id === "ravi_decision_actions") as {
      elements: Array<{ text: { text: string } }>;
    };
    expect(block.elements.map((e) => e.text.text)).toEqual(["Responder: modelo"]);
  });
});
