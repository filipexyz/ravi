import { describe, expect, test } from "bun:test";

import { extractPageText } from "@/server/console/pages/read-extract";

import { buildPageChunks, htmlHeadings, pageBaseViews } from "./page";

const HTML = `<!doctype html><html><head><title>Política</title></head><body>
<p>Bem-vindo à loja.</p>
<h1 id="politica">Política</h1>
<p>Regras gerais.</p>
<h2 id="trocas">Trocas</h2>
<p>Até sete dias.</p>
<h3>Prazo de devolução da compra</h3>
<p>Trinta dias corridos.</p>
<h2>Frete</h2>
<p>Grátis acima de 200.</p>
<ravi-view view="view_pedidos"></ravi-view>
<div data-ravi-view="view_estoque"></div>
</body></html>`;

const location = { kind: "page" as const, siteId: "site", routeId: "route", host: "acme.ravi.page", path: "/politica", recordedAt: "2026-10-15T00:00:00.000Z" };

function chunks(html = HTML) {
  const extraction = extractPageText({ baseUrl: "https://acme.ravi.page", path: "index.html", source: html });
  return buildPageChunks({ markdown: extraction.markdown, headings: htmlHeadings(html), location, baseViews: pageBaseViews(html) });
}

describe("page chunks", () => {
  test("sections at h1–h3 with h: heading-path keys", () => {
    expect(chunks().map((chunk) => chunk.stableKey)).toEqual([
      "h:",
      "h:Política",
      "h:Política>Trocas",
      "h:Política>Trocas>Prazo de devolução da compra",
      "h:Política>Frete",
    ]);
  });

  test("anchors: the heading id, else a :~:text= fragment of its first six words", () => {
    const anchors = chunks().map((chunk) => (chunk.location as { anchor: string | null }).anchor);
    expect(anchors).toEqual([
      null,
      "politica",
      "trocas",
      `:~:text=${encodeURIComponent("Prazo de devolução da compra")}`,
      `:~:text=${encodeURIComponent("Frete")}`,
    ]);
    const trocas = chunks()[2]!;
    expect(trocas.location).toMatchObject({ kind: "page", siteId: "site", routeId: "route", host: "acme.ravi.page", path: "/politica", headingPath: ["Política", "Trocas"] });
    expect(trocas.text).toBe("Trocas\n\nAté sete dias.");
  });

  test("baseViews from <ravi-view view> and [data-ravi-view]", () => {
    expect(pageBaseViews(HTML)).toEqual(["view_pedidos", "view_estoque"]);
    for (const chunk of chunks()) expect(chunk.metadata).toEqual({ baseViews: ["view_pedidos", "view_estoque"] });
  });

  test("a section over 1200 chars splits at paragraphs into #2, #3", () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `<p>${`Parágrafo ${index} `.repeat(30)}</p>`).join("");
    const result = chunks(`<html><body><h2 id="longo">Longo</h2>${paragraphs}</body></html>`);
    expect(result.length).toBeGreaterThan(1);
    expect(result.map((chunk) => chunk.stableKey)).toEqual(result.map((_, index) => (index === 0 ? "h:Longo" : `h:Longo#${index + 1}`)));
    for (const chunk of result) expect(chunk.text.length).toBeLessThanOrEqual(1200);
  });
});
