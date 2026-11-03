import { describe, expect, test } from "bun:test";

import { PIECE_NAMES } from "../template/catalog";
import { compileWidget } from "../template/compile";
import type { CompiledWidget, RenderContext, RenderRecord, TemplateNode, VElement } from "../types";
import { el, expr, makeCtx, norm, ORDER_COLUMNS, orderRecord, orderWidget, text } from "./test-fixtures";
import { textContent, toHtml } from "./vnode";
import { PIECE_RENDERERS, renderWidget, widgetRecordTitle } from "./widget";

const ALL = { write: new Set(["status", "titulo", "valor"]), create: true, archive: true };
const NONE = { write: new Set<string>(), create: false, archive: false };

function render(widget: CompiledWidget, record: RenderRecord, ctx: Partial<RenderContext> = {}) {
  const nodes = renderWidget(widget, record, makeCtx(ctx));
  return { nodes, html: norm(toHtml(nodes)), text: norm(textContent(nodes, true)).replace(/\s+/g, " ").trim() };
}

function single(template: TemplateNode[], fields: CompiledWidget["fields"] = orderWidget().fields, actions: CompiledWidget["actions"] = []) {
  return orderWidget({ variants: { default: template }, fields, actions });
}

describe("catalog coverage", () => {
  test("every piece in the catalog has a renderer", () => {
    expect(PIECE_NAMES.length).toBeGreaterThan(0);
    for (const name of PIECE_NAMES) expect(PIECE_RENDERERS[name]).toBeFunction();
    expect(Object.keys(PIECE_RENDERERS).sort()).toEqual([...PIECE_NAMES].sort());
  });
});

describe("the proposta's order card", () => {
  test("semantic structure: article named by its title, heading level from context, record root", () => {
    const { nodes, html, text } = render(orderWidget(), orderRecord(), { can: NONE });
    expect(nodes).toHaveLength(1);
    const root = nodes[0] as VElement;
    expect(root.tag).toBe("article");
    expect(root.attrs["data-ravi-row"]).toBe("6f1c2a90-0000-4000-8000-0000000000aa");
    expect(root.attrs["aria-labelledby"]).toBe("r1-title1");
    expect(html).toContain('<h3 class="ravi-title" id="r1-title1">Pedido 123</h3>');
    expect(html).toContain('<p class="ravi-text ravi-tone-secondary">Cliente Exemplo · <time datetime="2026-10-18">em 2 dias</time></p>');
    expect(text).toBe("Pedido 123 Status: Em produção Cliente Exemplo · em 2 dias Responsável: Ana Souza Valor: R$ 12.400,00");
  });

  test("every field carries data-ravi-field and the raw value", () => {
    const { html } = render(orderWidget(), orderRecord(), { can: NONE });
    expect(html).toContain('data-ravi-field="status" data-ravi-value="Em produção"');
    expect(html).toContain('data-ravi-field="responsavel" data-ravi-value="user_ana"');
    expect(html).toContain('data-ravi-field="valor" data-ravi-value="12400"');
    expect(html).toContain('<span class="ravi-big">R$ 12.400,00</span>');
  });

  test("capabilities on, interactive: enabled button named '<label>: <record title>' and a status editor", () => {
    const { html } = render(orderWidget(), orderRecord(), { can: ALL, interactive: true });
    expect(html).toContain('<button type="button" class="ravi-button ravi-button-secondary" aria-label="Concluir: Pedido 123" data-ravi-action="0">Concluir</button>');
    expect(html).toContain('<select id="r1-f2-edit" class="ravi-input ravi-select" data-ravi-edit="status">');
    expect(html).toContain('<label for="r1-f2-edit" class="ravi-sr-only">Status</label>');
  });

  test("capabilities on, not interactive (prerender, preview): button disabled, no editor", () => {
    const { html } = render(orderWidget(), orderRecord(), { can: ALL, interactive: false });
    expect(html).toContain('aria-label="Concluir: Pedido 123" data-ravi-action="0" disabled aria-disabled="true">Concluir</button>');
    expect(html).not.toContain("<select");
    expect(html).toContain('<span class="ravi-pill ravi-option-blue">');
  });

  test("capabilities off: no button and no editor, interactive or not", () => {
    for (const interactive of [true, false]) {
      const { html } = render(orderWidget(), orderRecord(), { can: NONE, interactive });
      expect(html).not.toContain("<button");
      expect(html).not.toContain("<select");
      expect(html).not.toContain("data-ravi-action");
    }
  });

  test("the update button needs every set column writable", () => {
    const { html } = render(orderWidget(), orderRecord(), { can: { write: new Set(["titulo"]), create: true, archive: true } });
    expect(html).not.toContain("<button");
  });

  test("en locale", () => {
    const { text } = render(orderWidget(), orderRecord(), { can: NONE, locale: "en" });
    expect(text).toBe("Pedido 123 Status: Em produção Cliente Exemplo · in 2 days Responsável: Ana Souza Valor: R$12,400.00");
  });

  test("variants: compact renders its own template; a missing variant falls back to default", () => {
    const compact = render(orderWidget(), orderRecord(), { variant: "compact", can: NONE });
    expect(compact.html).toContain('<article class="ravi-card ravi-card-subtle" aria-labelledby="r1-title1"');
    expect(compact.html).toContain('<h3 class="ravi-title ravi-size-sm" id="r1-title1">Pedido 123</h3>');
    expect(compact.html).not.toContain("Cliente Exemplo");
    const detail = render(orderWidget(), orderRecord(), { variant: "detail", can: NONE });
    expect(detail.text).toContain("Cliente Exemplo · em 2 dias");
  });

  test("values are escaped", () => {
    const { html } = render(orderWidget(), orderRecord({ titulo: "<script>alert(1)</script>", cliente: '"><img src=x onerror=alert(1)>' }), { can: ALL });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('aria-label="Concluir: &lt;script&gt;alert(1)&lt;/script&gt;"');
  });
});

describe("compiled by the template compiler", () => {
  const PROPOSTA_HTML = `<ravi-card>
  <ravi-row justify="between">
    <ravi-title>{titulo}</ravi-title>
    <ravi-field name="status"></ravi-field>
  </ravi-row>
  <ravi-text tone="secondary">{cliente} · {prazo | relative}</ravi-text>
  <ravi-row justify="between">
    <ravi-field name="responsavel"></ravi-field>
    <ravi-field name="valor"></ravi-field>
  </ravi-row>
  <ravi-button action="update" set="status=@done">Concluir</ravi-button>
</ravi-card>
`;
  const PROPOSTA_JSON = JSON.stringify({
    name: "Cartão de pedido",
    description: "Pedido com status, cliente, prazo, responsável e valor.",
    fields: orderWidget().fields,
    variants: ["default"],
  });

  test("the proposta's widget.html renders like the hand-built tree", () => {
    const { widget, diagnostics } = compileWidget([
      { path: "widget.html", content: PROPOSTA_HTML },
      { path: "widget.json", content: PROPOSTA_JSON },
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(widget).not.toBeNull();
    for (const ctx of [{ can: ALL }, { can: ALL, interactive: false }, { can: NONE }, { can: NONE, locale: "en" }]) {
      expect(render(widget!, orderRecord(), ctx).html).toBe(render(orderWidget(), orderRecord(), ctx).html);
    }
    expect(render(widget!, orderRecord(), { can: ALL }).html).toContain('aria-label="Concluir: Pedido 123" data-ravi-action="0">Concluir</button>');
  });
});

describe("pieces", () => {
  test("titles: explicit level; text inside rows and titles is a span", () => {
    const widget = single([
      el("ravi-stack", { gap: "sm" }, el("ravi-title", { level: "2", size: "lg" }, expr("titulo")), el("ravi-row", {}, el("ravi-text", { size: "xs", weight: "bold", lines: "2" }, text("Oi")))),
    ]);
    const { html } = render(widget, orderRecord(), { headingLevel: 5 });
    expect(html).toContain('<h2 class="ravi-title ravi-size-lg" id="r1-title1">Pedido 123</h2>');
    expect(html).toContain('<span class="ravi-text ravi-size-xs ravi-weight-bold ravi-lines-2">Oi</span>');
    expect(html).toContain('<div class="ravi-stack ravi-gap-sm" data-ravi-row=');
  });

  test("grid, divider and badges", () => {
    const widget = single([
      el(
        "ravi-grid",
        { columns: "3", gap: "lg" },
        el("ravi-badge", { tone: "success" }, text("Pago")),
        el("ravi-divider"),
        el("ravi-badge", { color: "purple" }, text("VIP")),
      ),
    ]);
    const { html } = render(widget, orderRecord());
    expect(html).toContain('<div class="ravi-grid ravi-cols-3 ravi-gap-lg" data-ravi-row=');
    expect(html).toContain('<span class="ravi-badge ravi-tone-success">Pago</span>');
    expect(html).toContain('<hr class="ravi-divider">');
    expect(html).toContain('<span class="ravi-badge ravi-option-purple">VIP</span>');
  });

  test("images: field or https literal src, alt from field, literal or decorative; unsafe sources render nothing", () => {
    const image = (attrs: Record<string, string | string[]>, values = {}) => render(single([el("ravi-stack", {}, el("ravi-image", attrs))]), orderRecord(values)).html;
    expect(image({ src: ["capa"], alt: ["titulo"], ratio: "16:9" })).toContain(
      '<img class="ravi-image ravi-ratio-16-9" src="https://example.test/capa.png" alt="Pedido 123" referrerpolicy="no-referrer" loading="lazy">',
    );
    expect(image({ src: "https://example.test/logo.png", alt: "decorative", fit: "contain" })).toContain('class="ravi-image ravi-fit-contain" src="https://example.test/logo.png" alt=""');
    expect(image({ src: "https://example.test/x.png", alt: "Logo da loja" })).toContain('alt="Logo da loja"');
    expect(image({ src: "http://example.test/x.png", alt: "x" })).not.toContain("<img");
    expect(image({ src: ["capa"], alt: "x" }, { capa: "javascript:alert(1)" })).not.toContain("<img");
    expect(image({ src: ["capa"], alt: "x", ratio: "1:1" }, { capa: "data:image/png;base64,AA" })).toContain('<div class="ravi-image ravi-ratio-1-1 ravi-image-empty" aria-hidden="true"></div>');
  });

  test("avatars: person picture or initials, named", () => {
    const widget = single([el("ravi-row", {}, el("ravi-avatar", { name: ["responsavel"] }))]);
    expect(render(widget, orderRecord()).html).toContain('<span class="ravi-avatar"><span aria-hidden="true">AS</span><span class="ravi-sr-only">Ana Souza</span></span>');
    expect(render(widget, orderRecord({ responsavel: ["user_bia"] })).html).toContain('<img class="ravi-avatar" src="https://example.test/bia.png" alt="Bia Lima"');
    const withSrc = single([el("ravi-row", {}, el("ravi-avatar", { name: ["titulo"], src: ["capa"] }))]);
    expect(render(withSrc, orderRecord()).html).toContain('src="https://example.test/capa.png" alt="Pedido 123"');
    expect(render(widget, orderRecord({ responsavel: [] })).html).not.toContain("ravi-avatar");
  });

  test("links: url, e-mail and phone fields or literals; unsafe href renders text", () => {
    const fields = { ...orderWidget().fields, site: { type: "url" as const }, email: { type: "email" as const }, fone: { type: "phone" as const } };
    const columns = {
      ...ORDER_COLUMNS,
      site: { key: "site", name: "Site", type: "url" as const, config: {} },
      email: { key: "email", name: "E-mail", type: "email" as const, config: {} },
      fone: { key: "fone", name: "Fone", type: "phone" as const, config: {} },
    };
    const widget = single(
      [
        el(
          "ravi-text",
          {},
          el("ravi-link", { href: ["site"] }, text("Site")),
          text(" "),
          el("ravi-link", { href: ["email"] }, text("E-mail")),
          text(" "),
          el("ravi-link", { href: ["fone"] }, text("Ligar")),
          text(" "),
          el("ravi-link", { href: "mailto:contato@example.test" }, text("Contato")),
          text(" "),
          el("ravi-link", { href: "javascript:alert(1)" }, text("Mau")),
        ),
      ],
      fields,
    );
    const { html } = render(widget, orderRecord({ site: "https://example.test/p", email: "pessoa@example.test", fone: "+55 00 0000-0000" }), { columns });
    expect(html).toContain('<a class="ravi-link" href="https://example.test/p" rel="noopener noreferrer">Site</a>');
    expect(html).toContain('<a class="ravi-link" href="mailto:pessoa@example.test" rel="noopener noreferrer">E-mail</a>');
    expect(html).toContain('<a class="ravi-link" href="tel:+550000000000" rel="noopener noreferrer">Ligar</a>');
    expect(html).toContain('href="mailto:contato@example.test"');
    expect(html).toContain('<span class="ravi-link-text">Mau</span>');
    expect(html).not.toContain("javascript");
  });

  test("metric and progress", () => {
    const fields = { ...orderWidget().fields, feito: { type: "number" as const, label: "Concluído" }, meta: { type: "number" as const } };
    const columns = {
      ...ORDER_COLUMNS,
      feito: { key: "feito", name: "Feito", type: "number" as const, config: {} },
      meta: { key: "meta", name: "Meta", type: "number" as const, config: {} },
    };
    const widget = single(
      [
        el(
          "ravi-stack",
          {},
          el("ravi-metric", { value: ["valor"], label: "Total" }),
          el("ravi-progress", { value: ["feito"] }),
          el("ravi-progress", { value: ["feito"], max: "10" }),
          el("ravi-progress", { value: ["feito"], max: ["meta"] }),
        ),
      ],
      fields,
    );
    const { html } = render(widget, orderRecord({ feito: 4, meta: 8 }), { columns });
    expect(html).toContain('<div class="ravi-metric" data-ravi-field="valor" data-ravi-value="12400"><span class="ravi-metric-label">Total</span> <span class="ravi-metric-value">R$ 12.400,00</span></div>');
    expect(html).toContain('aria-label="Concluído" aria-valuemin="0" aria-valuemax="100" aria-valuenow="4" aria-valuetext="4%"');
    expect(html).toContain('aria-valuemax="10" aria-valuenow="4" aria-valuetext="40%"');
    expect(html).toContain('aria-valuemax="8" aria-valuenow="4" aria-valuetext="50%"');
    expect(html).toContain('<div class="ravi-progress" data-ravi-field="feito" data-ravi-value="4">');
  });

  test("field piece: label, display and editable attributes", () => {
    const widget = single([
      el(
        "ravi-stack",
        {},
        el("ravi-field", { name: "status", label: "visible", display: "steps" }),
        el("ravi-field", { name: "status", editable: "false" }),
        el("ravi-field", { name: "prazo", display: "relative" }),
      ),
    ]);
    const { html } = render(widget, orderRecord(), { can: ALL });
    expect(html).toContain('<label for="r1-f1-edit" class="ravi-field-label">Status</label>');
    expect(html.match(/<select/g)?.length).toBe(1);
    expect(html).toContain('data-ravi-field="prazo" data-ravi-value="2026-10-18"><span class="ravi-sr-only">Prazo: </span><span class="ravi-field-value"><span class="ravi-text-value"><time datetime="2026-10-18">em 2 dias</time></span>');
    const readOnly = render(widget, orderRecord(), { can: NONE }).html;
    expect(readOnly).toContain('<span class="ravi-field-label">Status</span> <div class="ravi-field-value"><ol class="ravi-steps">');
    expect(readOnly).toContain('aria-current="step">Em produção</li>');
  });
});

describe("blocks and interpolation", () => {
  test("if, else and negation follow field emptiness (0 is a value, false is not)", () => {
    const fields = { ...orderWidget().fields, pago: { type: "checkbox" as const } };
    const columns = { ...ORDER_COLUMNS, pago: { key: "pago", name: "Pago", type: "checkbox" as const, config: {} } };
    const widget = single(
      [
        el(
          "ravi-text",
          {},
          { k: "if", path: ["cliente"], not: false, then: [text("tem cliente")], else: [text("sem cliente")] },
          text(" / "),
          { k: "if", path: ["pago"], not: true, then: [text("a pagar")], else: [] },
          text(" / "),
          { k: "if", path: ["valor"], not: false, then: [text("tem valor")], else: [] },
        ),
      ],
      fields,
    );
    expect(render(widget, orderRecord({ pago: false }), { columns }).text).toBe("tem cliente / a pagar / tem valor");
    expect(render(widget, orderRecord({ cliente: "", pago: true, valor: 0 }), { columns }).text).toBe("sem cliente / / tem valor");
  });

  test("each over multi_select, person and ref with item properties and filters", () => {
    const fields = {
      titulo: { type: "text" as const, required: true },
      tags: { type: "multi_select" as const },
      time: { type: "person" as const },
      refs: { type: "ref" as const },
    };
    const columns = {
      titulo: { key: "titulo", name: "Título", type: "text" as const, config: {} },
      tags: { key: "tags", name: "Tags", type: "multi_select" as const, config: { options: [{ id: "t0000001", name: "Urgente", color: "red" as const }, { id: "t0000002", name: "VIP", color: "purple" as const }] } },
      time: { key: "time", name: "Time", type: "person" as const, config: {} },
      refs: { key: "refs", name: "Refs", type: "ref" as const, config: {} },
    };
    const widget = single(
      [
        el(
          "ravi-stack",
          {},
          el("ravi-row", {}, { k: "each", path: ["tags"], as: "tag", children: [el("ravi-badge", { color: "gray" }, expr("tag.name"), text(" ("), expr("tag.color"), text(")"))] }),
          el("ravi-row", {}, { k: "each", path: ["time"], as: "p", children: [el("ravi-avatar", { name: ["p"] }), el("ravi-text", {}, expr("p.displayName"), text(" "), expr("p", "initials"))] }),
          el("ravi-text", {}, { k: "each", path: ["refs"], as: "r", children: [expr("r.type"), text("#"), expr("r.id"), text(" ")] }),
        ),
      ],
      fields,
    );
    const { html, text: content } = render(
      widget,
      { id: "row1", version: 1, values: { titulo: "T", tags: ["t0000001", "t0000002"], time: ["user_ana", "user_bia"], refs: [{ type: "order", id: "42" }] } },
      { columns },
    );
    expect(html).toContain('<span class="ravi-badge ravi-option-gray">Urgente (red)</span>');
    expect(html).toContain('<span class="ravi-badge ravi-option-gray">VIP (purple)</span>');
    expect(html).toContain('<img class="ravi-avatar" src="https://example.test/bia.png" alt="Bia Lima"');
    // Initials show; the name stays for screen readers and agents.
    expect(content).toContain("Ana Souza Ana Souza Ana Souza");
    expect(html).toContain('Ana Souza <span><span aria-hidden="true">AS</span><span class="ravi-sr-only">Ana Souza</span></span>');
    expect(content).toContain("Bia Lima Bia Lima");
    expect(content).toContain("order#42");
  });

  test("interpolation uses the theme display; filters override it", () => {
    const widget = single([el("ravi-text", {}, expr("valor"), text(" | "), expr("valor", "compact"), text(" | "), expr("prazo"), text(" | "), expr("prazo", "relative"), text(" | "), expr("responsavel", "initials"))]);
    const rules = { ...makeCtx().fields, types: { ...makeCtx().fields.types, date: "relative" as const } };
    expect(render(widget, orderRecord()).text).toBe("R$ 12.400,00 | R$ 12,4 mil | 18 de out. | em 2 dias | Ana Souza");
    expect(render(widget, orderRecord(), { fields: rules }).text).toBe("R$ 12.400,00 | R$ 12,4 mil | em 2 dias | em 2 dias | Ana Souza");
  });

  test("several roots are wrapped in one element carrying data-ravi-row", () => {
    const widget = single([el("ravi-title", {}, expr("titulo")), el("ravi-text", {}, expr("cliente"))]);
    const { nodes, html } = render(widget, orderRecord());
    expect(nodes).toHaveLength(1);
    expect(html.startsWith('<div class="ravi-record" data-ravi-row="6f1c2a90-0000-4000-8000-0000000000aa"><h3 class="ravi-title"')).toBe(true);
    const staticRecord = render(widget, { id: null, version: null, values: { titulo: "X" } });
    expect(staticRecord.html).toContain('data-ravi-row=""');
  });
});

describe("buttons", () => {
  const actions: CompiledWidget["actions"] = [
    { verb: "update", set: { status: { kind: "status_group", group: "done" } }, href: null, confirm: true, label: "Concluir" },
    { verb: "update", set: { status: { kind: "status_group", group: "todo" } }, href: null, confirm: false, label: "Reabrir" },
    { verb: "archive", set: {}, href: null, confirm: true, label: "Arquivar" },
    { verb: "create", set: { status: { kind: "status_group", group: "todo" } }, href: null, confirm: false, label: "Novo pedido" },
    { verb: "open", set: {}, href: "capa", confirm: false, label: "Ver capa" },
    { verb: "open", set: {}, href: null, confirm: false, label: "Detalhes" },
  ];
  const template = [
    el(
      "ravi-card",
      {},
      el("ravi-title", {}, expr("titulo")),
      el("ravi-row", {}, el("ravi-button", { action: "update", set: "status=@todo" }, text("Reabrir")), el("ravi-button", { action: "update", set: "status=@done", variant: "primary", confirm: "true" }, text("Concluir"))),
      el("ravi-button", { action: "archive", variant: "danger" }, text("Arquivar")),
      el("ravi-button", { action: "create", set: "status=@todo" }, text("Novo pedido")),
      el("ravi-button", { action: "open", href: ["capa"] }, text("Ver capa")),
      el("ravi-button", { action: "open", variant: "ghost" }, text("Detalhes")),
    ),
  ];
  const widget = orderWidget({ variants: { default: template }, actions });

  test("each button maps to its action and shows only when allowed", () => {
    const all = render(widget, orderRecord(), { can: ALL });
    expect(all.html).toContain('aria-label="Reabrir: Pedido 123" data-ravi-action="1">Reabrir</button>');
    expect(all.html).toContain('class="ravi-button ravi-button-primary" aria-label="Concluir: Pedido 123" aria-haspopup="dialog" data-ravi-action="0">Concluir</button>');
    expect(all.html).toContain('class="ravi-button ravi-button-danger" aria-label="Arquivar: Pedido 123" aria-haspopup="dialog" data-ravi-action="2">Arquivar</button>');
    expect(all.html).toContain('aria-label="Novo pedido: Pedido 123" data-ravi-action="3">Novo pedido</button>');
    expect(all.html).toContain('<a class="ravi-button ravi-button-secondary" href="https://example.test/capa.png" aria-label="Ver capa: Pedido 123" data-ravi-action="4" rel="noopener noreferrer">Ver capa</a>');
    expect(all.html).toContain('class="ravi-button ravi-button-ghost" aria-label="Detalhes: Pedido 123" aria-haspopup="dialog" data-ravi-action="5">Detalhes</button>');

    const none = render(widget, orderRecord(), { can: NONE });
    expect(none.html).not.toContain('data-ravi-action="0"');
    expect(none.html).not.toContain('data-ravi-action="1"');
    expect(none.html).not.toContain('data-ravi-action="2"');
    expect(none.html).not.toContain('data-ravi-action="3"');
    expect(none.html).toContain('data-ravi-action="4"');
    expect(none.html).toContain('data-ravi-action="5"');
  });

  test("open without href needs a record id when interactive; open with an unsafe href is hidden", () => {
    const staticRecord = { id: null, version: null, values: { ...orderRecord().values, capa: "javascript:alert(1)" } };
    const { html } = render(widget, staticRecord, { can: NONE });
    expect(html).not.toContain('data-ravi-action="4"');
    expect(html).not.toContain('data-ravi-action="5"');
  });

  test("links stay links when not interactive; buttons are disabled", () => {
    const { html } = render(widget, orderRecord(), { can: ALL, interactive: false });
    expect(html).toContain('href="https://example.test/capa.png"');
    expect(html.match(/ disabled aria-disabled="true"/g)?.length).toBe(5);
  });

  test("an index stored on the node wins", () => {
    const indexed = orderWidget({ variants: { default: [el("ravi-card", {}, el("ravi-title", {}, expr("titulo")), el("ravi-button", { action: "2" }, text("Arquivar")))] }, actions });
    expect(render(indexed, orderRecord(), { can: ALL }).html).toContain('data-ravi-action="2"');
  });

  test("record title: first ravi-title, else the first required text field; no title, no aria-label", () => {
    expect(widgetRecordTitle(widget, orderRecord(), makeCtx())).toBe("Pedido 123");
    const untitled = orderWidget({ variants: { default: [el("ravi-card", {}, el("ravi-button", { action: "archive" }, text("Arquivar")))] }, actions });
    expect(widgetRecordTitle(untitled, orderRecord(), makeCtx())).toBe("Pedido 123");
    expect(render(untitled, orderRecord(), { can: ALL }).html).toContain('aria-label="Arquivar: Pedido 123"');
    const html = render(untitled, orderRecord({ titulo: "", cliente: "" }), { can: ALL }).html;
    expect(html).toContain('<button type="button" class="ravi-button ravi-button-secondary" aria-haspopup="dialog" data-ravi-action="2">Arquivar</button>');
  });
});

describe("whitespace inside blocks", () => {
  const fields: CompiledWidget["fields"] = {
    titulo: { type: "text", required: true },
    cliente: { type: "text" },
    tags: { type: "multi_select" },
    time: { type: "person" },
  };
  const columns = {
    titulo: ORDER_COLUMNS.titulo!,
    cliente: ORDER_COLUMNS.cliente!,
    tags: {
      key: "tags",
      name: "Tags",
      type: "multi_select" as const,
      config: { options: [{ id: "t0000001", name: "Urgente", color: "red" as const }, { id: "t0000002", name: "VIP", color: "purple" as const }] },
    },
    time: { key: "time", name: "Time", type: "person" as const, config: {} },
  };
  const record = { id: "row1", version: 1, values: { titulo: "Pedido 1", cliente: "Ana", tags: ["t0000001", "t0000002"], time: ["user_ana", "user_bia"] } };
  const compiled = (html: string) => {
    const manifest = JSON.stringify({ name: "Teste", description: "Teste de espaços.", fields });
    const { widget, diagnostics } = compileWidget([
      { path: "widget.html", content: html },
      { path: "widget.json", content: manifest },
    ]);
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    return widget!;
  };
  const shown = (html: string, values: Record<string, unknown> = {}) =>
    render(compiled(html), { ...record, values: { ...record.values, ...values } }, { columns, can: ALL });

  test("text around an {#if} keeps its spaces, in the title and in the names built from it", () => {
    const html = `<ravi-card><ravi-title>{titulo}{#if cliente} · {cliente}{/if}</ravi-title><ravi-text>Cliente: {#if cliente}{cliente}{:else}nenhum{/if} (ver)</ravi-text></ravi-card>`;
    const { html: out, text } = shown(html);
    expect(out).toContain('id="r1-title1">Pedido 1 · Ana</h3>');
    expect(text).toBe("Pedido 1 · Ana Cliente: Ana (ver)");
    expect(shown(html, { cliente: "" }).text).toBe("Pedido 1 Cliente: nenhum (ver)");
    expect(render(compiled(`<ravi-card><ravi-title>{titulo}{#if cliente} ({cliente}){/if}</ravi-title></ravi-card>`), record, { columns }).text).toBe("Pedido 1 (Ana)");
  });

  test("an empty {#if} between words leaves one space", () => {
    expect(shown(`<ravi-text>Pedido {#if cliente}de {cliente}{/if} pronto</ravi-text>`, { cliente: "" }).text).toBe("Pedido pronto");
  });

  test("text inside an {#each} keeps the spaces and separators between items", () => {
    expect(shown(`<ravi-text>Resp: {#each time as p}{p.name}, {/each}</ravi-text>`).text).toBe("Resp: Ana Souza, Bia Lima,");
    expect(shown(`<ravi-text>{#each tags as tag}{tag.name} {/each}</ravi-text>`).html).toContain('">Urgente VIP</p>');
    const badges = shown(`<ravi-text>{#each tags as tag}<ravi-badge>{tag.name}</ravi-badge> {/each}</ravi-text>`).html;
    expect(badges).toContain('<span class="ravi-badge">Urgente</span> <span class="ravi-badge">VIP</span></p>');
  });
});

describe("people shown as initials", () => {
  const initialsRules = { ...makeCtx().fields, types: { ...makeCtx().fields.types, person: "initials" as const } };
  const actions: CompiledWidget["actions"] = [{ verb: "update", set: { status: { kind: "status_group", group: "done" } }, href: null, confirm: false, label: "Concluir" }];

  test("a theme that shows people as initials keeps the name for screen readers, agents and attributes", () => {
    const widget = single(
      [
        el(
          "ravi-card",
          {},
          el("ravi-title", {}, expr("responsavel")),
          el("ravi-text", {}, text("Responsável: "), expr("responsavel")),
          el("ravi-image", { src: ["capa"], alt: ["responsavel"] }),
          el("ravi-button", { action: "update", set: "status=@done" }, text("Concluir")),
        ),
      ],
      orderWidget().fields,
      actions,
    );
    const { html, text: content } = render(widget, orderRecord(), { fields: initialsRules, can: ALL });
    expect(html).toContain('<p class="ravi-text">Responsável: <span><span aria-hidden="true">AS</span><span class="ravi-sr-only">Ana Souza</span></span></p>');
    expect(html).toContain('alt="Ana Souza"');
    expect(html).toContain('aria-label="Concluir: Ana Souza"');
    expect(content).toBe("Ana Souza Responsável: Ana Souza Ana Souza Concluir");
  });

  test("the initials filter keeps the full text too, for people and for text", () => {
    const widget = single([el("ravi-text", {}, expr("responsavel", "initials"), text(" / "), expr("cliente", "initials"))]);
    const { html, text: content } = render(widget, orderRecord());
    expect(html).toContain('<span><span aria-hidden="true">CE</span><span class="ravi-sr-only">Cliente Exemplo</span></span>');
    expect(content).toBe("Ana Souza / Cliente Exemplo");
    expect(render(widget, orderRecord({ responsavel: [], cliente: "" })).html).toContain('">/</p>');
  });
});

describe("dates are <time datetime>", () => {
  test("field displays and interpolations carry the ISO value; ranges get one per end", () => {
    const widget = single([
      el(
        "ravi-stack",
        {},
        el("ravi-field", { name: "prazo" }),
        el("ravi-text", {}, expr("prazo")),
        el("ravi-text", {}, expr("prazo", "relative")),
        el("ravi-text", {}, expr("prazo", "date")),
      ),
    ]);
    const { html } = render(widget, orderRecord());
    expect(html).toContain('<span class="ravi-text-value"><time datetime="2026-10-18">18 de out.</time></span>');
    expect(html).toContain('<p class="ravi-text"><time datetime="2026-10-18">18 de out.</time></p>');
    expect(html).toContain('<p class="ravi-text"><time datetime="2026-10-18">em 2 dias</time></p>');
    const range = render(widget, orderRecord({ prazo: { start: "2026-10-18", end: "2026-10-20" } })).html;
    expect(range).toContain('<time datetime="2026-10-18">18 de out.</time> – <time datetime="2026-10-20">20 de out.</time>');
    const instant = render(widget, orderRecord({ prazo: "2026-10-16T14:00:00Z" })).html;
    expect(instant).toContain('<time datetime="2026-10-16T14:00:00.000Z">há 1 hora</time>');
    expect(render(widget, orderRecord({ prazo: null })).html).not.toContain("<time");
  });
});

describe("accessible names that never come out empty", () => {
  const actions: CompiledWidget["actions"] = [
    { verb: "archive", set: {}, href: null, confirm: true, label: "" },
    { verb: "update", set: { status: { kind: "status_group", group: "done" } }, href: null, confirm: false, label: "" },
  ];
  const card = (...children: TemplateNode[]) => orderWidget({ variants: { default: [el("ravi-card", {}, el("ravi-title", {}, expr("titulo")), ...children)] }, actions });

  test("a button named by an image takes its alt, before the record title", () => {
    const widget = card(el("ravi-button", { action: "archive" }, el("ravi-image", { src: ["capa"], alt: "Arquivar pedido" })));
    const { html } = render(widget, orderRecord(), { can: ALL });
    expect(html).toContain('aria-label="Arquivar pedido: Pedido 123" aria-haspopup="dialog" data-ravi-action="0"><img class="ravi-image"');
  });

  test("a button whose text renders empty shows the action's verb; its name never starts with ': '", () => {
    const pronto = { k: "if", path: ["cliente"], not: true, then: [text("Concluir")], else: [] } as TemplateNode;
    const widget = card(el("ravi-button", { action: "update", set: "status=@done" }, pronto), el("ravi-button", { action: "archive" }, expr("cliente")));
    const { html } = render(widget, orderRecord({ cliente: "" }), { can: ALL });
    expect(html).toContain('aria-label="Concluir: Pedido 123" data-ravi-action="1">Concluir</button>');
    const empty = render(widget, orderRecord(), { can: ALL }).html;
    expect(empty).toContain('aria-label="Alterar: Pedido 123" data-ravi-action="1">Alterar</button>');
    expect(empty).toContain('aria-label="Cliente Exemplo: Pedido 123"');
    const archive = render(widget, orderRecord({ cliente: "" }), { can: ALL }).html;
    expect(archive).toContain('aria-label="Arquivar: Pedido 123" aria-haspopup="dialog" data-ravi-action="0">Arquivar</button>');
    expect(archive).not.toContain('aria-label=":');
  });

  test("a link whose text renders empty shows its address; an empty badge is left out", () => {
    const fields = { ...orderWidget().fields, site: { type: "url" as const } };
    const columns = { ...ORDER_COLUMNS, site: { key: "site", name: "Site", type: "url" as const, config: {} } };
    const widget = single([el("ravi-text", {}, el("ravi-link", { href: ["site"] }, expr("cliente")), el("ravi-badge", { tone: "danger" }, expr("cliente")))], fields);
    const { html } = render(widget, orderRecord({ cliente: "", site: "https://example.test/loja/" }), { columns });
    expect(html).toContain('<a class="ravi-link" href="https://example.test/loja/" rel="noopener noreferrer">example.test/loja</a>');
    expect(html).not.toContain("ravi-badge");
  });

  test("an empty title reads 'Sem título' like the default card, so the article and its buttons keep a name", () => {
    const widget = card(el("ravi-button", { action: "archive" }, text("Arquivar")));
    const { html } = render(widget, orderRecord({ titulo: "" }), { can: ALL });
    expect(html).toContain('<article class="ravi-card" aria-labelledby="r1-title1" data-ravi-row="6f1c2a90-0000-4000-8000-0000000000aa"><h3 class="ravi-title" id="r1-title1">Sem título</h3>');
    expect(html).toContain('aria-label="Arquivar: Sem título"');
    expect(widgetRecordTitle(widget, orderRecord({ titulo: "" }), makeCtx({ locale: "en" }))).toBe("Untitled");
  });
});
