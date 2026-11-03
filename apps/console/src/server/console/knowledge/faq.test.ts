import { describe, expect, test } from "bun:test";
import { DomUtils, parseDocument } from "htmlparser2";

import { faqAnchor, isEffectivelyPublic, renderFaqHtml } from "./faq";

const entries = [
  { anchor: "voces-dao-desconto-pra-ong", question: "Vocês dão desconto pra ONG?", answer: "Sim, 20%.\n\nFale com a gente.", updatedAt: "2026-10-17T12:00:00Z" },
  { anchor: "xss", question: "<script>alert(1)</script>", answer: "<img src=x onerror=alert(1)> & \"quotes\"", updatedAt: "2026-10-17T12:00:00Z" },
];

describe("renderFaqHtml", () => {
  const html = renderFaqHtml(entries, { projectName: "Acme <b>" });
  const document = parseDocument(html);

  test("is PT-BR with one h2[id] per entry", () => {
    const root = DomUtils.findOne((node) => node.name === "html", document.children);
    expect(root?.attribs.lang).toBe("pt-BR");
    const headings = DomUtils.findAll((node) => node.name === "h2", document.children);
    expect(headings.map((node) => node.attribs.id)).toEqual(["voces-dao-desconto-pra-ong", "xss"]);
    expect(DomUtils.findAll((node) => node.name === "section", document.children)).toHaveLength(2);
    expect(DomUtils.textContent(DomUtils.findOne((node) => node.name === "title", document.children)!)).toBe("Perguntas frequentes");
  });

  test("escapes everything and has no script or external asset", () => {
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp; &quot;quotes&quot;");
    expect(DomUtils.findAll((node) => node.name === "script" || node.name === "link" || node.name === "img", document.children)).toHaveLength(0);
    expect(DomUtils.findAll((node) => "src" in node.attribs || "href" in node.attribs || node.name.startsWith("on"), document.children)).toHaveLength(0);
  });

  test("splits answer paragraphs", () => {
    expect(html).toContain("<p>Sim, 20%.</p><p>Fale com a gente.</p>");
  });
});

describe("faqAnchor", () => {
  test("slugs the folded question, at most 48 chars, numbered on collision", () => {
    expect(faqAnchor("Vocês dão desconto pra ONG?", new Set())).toBe("voces-dao-desconto-pra-ong");
    expect(faqAnchor("Vocês dão desconto pra ONG?", new Set(["voces-dao-desconto-pra-ong"]))).toBe("voces-dao-desconto-pra-ong-2");
    expect(faqAnchor("x", new Set(["x", "x-2"]))).toBe("x-3");
    const long = faqAnchor("a".repeat(30) + " " + "b".repeat(30), new Set());
    expect(long.length).toBeLessThanOrEqual(48);
    const longTaken = faqAnchor("a".repeat(30) + " " + "b".repeat(30), new Set([long]));
    expect(longTaken.length).toBeLessThanOrEqual(48);
    expect(longTaken.endsWith("-2")).toBe(true);
    expect(faqAnchor("???", new Set())).toBe("pergunta");
  });
});

describe("isEffectivelyPublic", () => {
  test("needs both the site default and the route public", () => {
    expect(isEffectivelyPublic("public", "public")).toBe(true);
    expect(isEffectivelyPublic("private", "public")).toBe(false);
    expect(isEffectivelyPublic("public", "private")).toBe(false);
  });
});
