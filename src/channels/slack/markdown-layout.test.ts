import { describe, expect, it } from "bun:test";
import {
  planSlackMessageLayout,
  renderSlackMarkdownMessages,
  renderSlackMrkdwnParts,
  SLACK_MESSAGE_MARKDOWN_LIMIT,
  SLACK_MRKDWN_PART_LIMIT,
  splitSlackMarkdownUnits,
} from "./markdown-layout.js";

const TABLE = ["| # | Stage | Gate |", "|---|---|---|", "| 0 | Intake | G0 |", "| 1 | Study | G1 |"].join("\n");

function fencesBalanced(text: string): boolean {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!marker) continue;
    if (!open) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && line.trim() === marker) open = undefined;
  }
  return open === undefined;
}

function paragraph(index: number): string {
  return `Paragraph ${index}: ${"the agent explains one more part of the design in plain words. ".repeat(8)}`;
}

describe("splitSlackMarkdownUnits", () => {
  it("keeps fences, tables and standalone images whole, and headings apart", () => {
    const units = splitSlackMarkdownUnits(
      [
        "# Title",
        "Intro line",
        "",
        TABLE,
        "",
        "```ts",
        "const a = 1;",
        "",
        "const b = 2;",
        "```",
        "",
        "![chart](https://example.com/chart.png)",
      ].join("\n"),
    );

    expect(units.map((unit) => unit.kind)).toEqual(["markdown", "markdown", "markdown", "fence", "image"]);
    expect(units[0]).toMatchObject({ heading: true, text: "# Title" });
    expect(units[2]?.text).toBe(TABLE);
    expect(units[3]).toMatchObject({ language: "ts", body: ["const a = 1;", "", "const b = 2;"] });
    expect(units[4]).toMatchObject({ url: "https://example.com/chart.png", alt: "chart" });
  });

  it("closes a fence the agent left open, and keeps other fence markers inside it", () => {
    const units = splitSlackMarkdownUnits(["```text", "~~~", "inside", "~~~"].join("\n"));
    expect(units).toHaveLength(1);
    expect(units[0]?.text).toBe(["```text", "~~~", "inside", "~~~", "```"].join("\n"));
  });
});

describe("renderSlackMarkdownMessages", () => {
  it("sends a reply that fits as one markdown block, exactly as written", () => {
    const markdown = `## Feito\n\nDecisões centrais:\n- **Feed** em 2 Bases\n\n${TABLE}`;
    const [message, ...rest] = renderSlackMarkdownMessages(markdown);

    expect(rest).toEqual([]);
    expect(message?.blocks).toEqual([{ type: "markdown", text: markdown }]);
    expect(message?.text).toBe("Feito");
  });

  it("splits a long reply only between blocks, never inside a fence or a table", () => {
    const fence = ["```json", ...Array.from({ length: 80 }, (_, i) => `  "key${i}": "value number ${i}",`), "```"].join(
      "\n",
    );
    const blocks = Array.from({ length: 30 }, (_, i) => (i === 12 ? fence : i === 20 ? TABLE : paragraph(i)));
    const markdown = blocks.join("\n\n");
    expect(markdown.length).toBeGreaterThan(SLACK_MESSAGE_MARKDOWN_LIMIT);

    const messages = renderSlackMarkdownMessages(markdown);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      const text = String(message.blocks[0]?.text);
      expect(text.length).toBeLessThanOrEqual(SLACK_MESSAGE_MARKDOWN_LIMIT);
      expect(fencesBalanced(text)).toBe(true);
    }
    expect(messages.filter((message) => message.markdown.includes(fence))).toHaveLength(1);
    expect(messages.filter((message) => message.markdown.includes(TABLE))).toHaveLength(1);
  });

  it("reopens a fence too long for one message in every part", () => {
    const body = Array.from({ length: 600 }, (_, i) => `line ${i} of a very long log output from the agent`);
    const messages = renderSlackMarkdownMessages(["```log", ...body, "```"].join("\n"));

    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      const text = String(message.blocks[0]?.text);
      expect(text.startsWith("```log\n")).toBe(true);
      expect(text.endsWith("\n```")).toBe(true);
      expect(text.length).toBeLessThanOrEqual(SLACK_MESSAGE_MARKDOWN_LIMIT);
    }
  });

  it("turns an image alone on its line into an image block", () => {
    const [message] = renderSlackMarkdownMessages(
      "Before\n\n![Usage by week](https://example.com/usage.png)\n\nAfter, with an inline ![icon](https://example.com/i.png) link",
    );

    expect(message?.blocks).toEqual([
      { type: "markdown", text: "Before" },
      { type: "image", image_url: "https://example.com/usage.png", alt_text: "Usage by week" },
      { type: "markdown", text: "After, with an inline ![icon](https://example.com/i.png) link" },
    ]);
  });
});

describe("planSlackMessageLayout", () => {
  const skill = [
    "---",
    "name: ravi-living-docs",
    "description: Feed de atualizações",
    "---",
    "",
    "# Ravi Living Docs",
    "",
    TABLE,
    "",
    "~~~text",
    "PR -> item -> derivados",
    "~~~",
    ...Array.from({ length: 50 }, (_, i) => `- regra ${i}`),
  ];

  it("pulls a long markdown fence out as a document, titled from its frontmatter", () => {
    const markdown = ["Feito. Rascunho abaixo.", "", "```markdown", ...skill, "```", "", "Revisa e me diz."].join("\n");
    const plan = planSlackMessageLayout(markdown);

    expect(plan.documents).toHaveLength(1);
    expect(plan.documents[0]).toMatchObject({ title: "ravi-living-docs", filename: "ravi-living-docs.md" });
    expect(plan.documents[0]?.content).toBe(skill.join("\n"));
    expect(plan.body.split("\n\n")).toEqual([
      "Feito. Rascunho abaixo.",
      plan.documents[0]?.placeholder,
      "Revisa e me diz.",
    ]);
  });

  it("keeps a text fence as a code block in its document", () => {
    const fence = ["```text", ...skill, "```"].join("\n");
    const plan = planSlackMessageLayout(`Draft:\n\n${fence}`);

    expect(plan.documents[0]).toMatchObject({ title: "ravi-living-docs", filename: "ravi-living-docs.txt" });
    expect(plan.documents[0]?.content).toBe(fence);
    expect(plan.documents[0]?.inline).toBe(fence);
  });

  it("leaves short fences, and everything when documents are off, in the message", () => {
    const short = "Look:\n\n```markdown\n# Small\n\nOnly a few lines.\n```";
    expect(planSlackMessageLayout(short)).toEqual({ body: short, documents: [] });

    const long = ["```markdown", ...skill, "```"].join("\n");
    expect(planSlackMessageLayout(long, { allowDocuments: false })).toEqual({ body: long, documents: [] });
  });

  it("makes the whole reply the document when it cannot fit one message, keeping its opening", () => {
    const markdown = [
      "# Relatório semanal",
      "Resumo: três entregas e um bloqueio.",
      ...Array.from({ length: 40 }, (_, i) => paragraph(i)),
    ].join("\n\n");
    const plan = planSlackMessageLayout(markdown);

    expect(plan.documents).toEqual([
      expect.objectContaining({ title: "Relatório semanal", filename: "relatorio-semanal.md", content: markdown }),
    ]);
    expect(plan.body).toBe(
      `# Relatório semanal\n\nResumo: três entregas e um bloqueio.\n\n${plan.documents[0]?.placeholder}`,
    );
  });
});

describe("renderSlackMrkdwnParts", () => {
  it("converts to mrkdwn in parts Slack will not cut, with every fence closed", () => {
    const fence = ["```", ...Array.from({ length: 60 }, (_, i) => `row ${i}`), "```"].join("\n");
    const markdown = [
      ...Array.from({ length: 6 }, (_, i) => paragraph(i)),
      fence,
      "**Done**",
      ...Array.from({ length: 6 }, (_, i) => paragraph(i + 6)),
    ].join("\n\n");
    const parts = renderSlackMrkdwnParts(markdown);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(SLACK_MRKDWN_PART_LIMIT + 200);
      expect(fencesBalanced(part)).toBe(true);
    }
    expect(parts.join("\n\n")).toContain("*Done*");
  });
});
