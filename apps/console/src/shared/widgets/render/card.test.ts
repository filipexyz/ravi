import { describe, expect, test } from "bun:test";

import type { VElement } from "../types";
import { DEFAULT_CARD_MAX_FIELDS, renderDefaultCard } from "./card";
import { makeCtx, norm, orderRecord } from "./test-fixtures";
import { textContent, toHtml } from "./vnode";

describe("renderDefaultCard", () => {
  test("article named by its title, cover image, fields with visible labels", () => {
    const nodes = renderDefaultCard(
      { record: orderRecord(), titleKey: "titulo", fieldKeys: ["status", "prazo", "responsavel", "valor"], coverKey: "capa" },
      makeCtx(),
    );
    const article = nodes[0] as VElement;
    const html = norm(toHtml(nodes));
    expect(article.tag).toBe("article");
    expect(article.attrs).toMatchObject({ class: "ravi-card ravi-default-card", "aria-labelledby": "r1-title", "data-ravi-row": orderRecord().id as string });
    expect(html).toContain('<img class="ravi-image ravi-cover" src="https://example.test/capa.png" alt="" referrerpolicy="no-referrer" loading="lazy">');
    expect(html).toContain('<h3 class="ravi-title" id="r1-title" data-ravi-field="titulo" data-ravi-value="Pedido 123">Pedido 123</h3>');
    expect(html).toContain('<span class="ravi-field-label">Status</span>');
    expect(html).toContain('<span class="ravi-field-label">Prazo</span>');
    expect(norm(textContent(nodes, true)).replace(/\s+/g, " ").trim()).toBe(
      "Pedido 123 Status Em produção Prazo 18 de out. Responsável Ana Souza Valor R$ 12.400,00",
    );
  });

  test("untitled rows, missing columns and no cover", () => {
    const nodes = renderDefaultCard(
      { record: orderRecord({ titulo: "  " }), titleKey: "titulo", fieldKeys: ["titulo", "nope", "cliente"], coverKey: null },
      makeCtx({ locale: "en", headingLevel: 4 }),
    );
    const html = toHtml(nodes);
    expect(html).toContain('<h4 class="ravi-title" id="r1-title" data-ravi-field="titulo" data-ravi-value="  ">Untitled</h4>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("nope");
    expect(html.match(/data-ravi-field=/g)?.length).toBe(2);
  });

  test("no title column", () => {
    const html = toHtml(renderDefaultCard({ record: orderRecord(), titleKey: null, fieldKeys: [], coverKey: null }, makeCtx()));
    expect(html).toContain('<h3 class="ravi-title" id="r1-title">Sem título</h3>');
    expect(html).not.toContain("ravi-card-fields");
  });

  test("editors when the viewer may write; at most DEFAULT_CARD_MAX_FIELDS fields", () => {
    const ctx = makeCtx({ can: { write: new Set(["status"]), create: false, archive: false } });
    const html = toHtml(renderDefaultCard({ record: orderRecord(), titleKey: "titulo", fieldKeys: ["status"], coverKey: null }, ctx));
    expect(html).toContain('<label for="r1-c0-edit" class="ravi-field-label">Status</label>');
    const many = Array.from({ length: 12 }, () => "cliente");
    const capped = toHtml(renderDefaultCard({ record: orderRecord(), titleKey: null, fieldKeys: many, coverKey: null }, makeCtx()));
    expect(capped.match(/data-ravi-field="cliente"/g)?.length).toBe(DEFAULT_CARD_MAX_FIELDS);
  });

  test("unsafe cover URLs are dropped", () => {
    const html = toHtml(renderDefaultCard({ record: orderRecord({ capa: "javascript:alert(1)" }), titleKey: "titulo", fieldKeys: [], coverKey: "capa" }, makeCtx()));
    expect(html).not.toContain("<img");
  });
});
