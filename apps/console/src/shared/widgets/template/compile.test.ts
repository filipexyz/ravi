import { describe, expect, test } from "bun:test";

import type { LibraryFileText, TemplateNode } from "../types";
import { canonicalJson, compileWidget, looksLikeEmail, looksLikePhone } from "./compile";

// The proposal's example card (proposta.md), adapted to the final grammar,
// with the contract's widget.json (CONTRACT 4.1).
const PEDIDO_JSON = `{
  "name": "Cartão de pedido",
  "description": "Pedido com status, cliente, prazo, responsável e valor.",
  "fields": {
    "titulo": { "type": "text", "required": true, "label": "Pedido" },
    "status": { "type": "status" },
    "cliente": { "type": "text" },
    "prazo": { "type": "date" },
    "responsavel": { "type": "person", "label": "Responsável" },
    "valor": { "type": "number", "role": "highlight" },
    "capa": { "type": "url", "role": "image" }
  },
  "variants": ["default", "compact"]
}`;

const PEDIDO_HTML = `<ravi-card>
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

const files = (html: string, json = PEDIDO_JSON, example?: string): LibraryFileText[] => [
  { path: "widget.json", content: json },
  { path: "widget.html", content: html },
  ...(example === undefined ? [] : [{ path: "example.json", content: example }]),
];

const errors = (result: ReturnType<typeof compileWidget>) =>
  result.diagnostics.filter((d) => d.severity === "error").map((d) => ({ code: d.code, file: d.file, line: d.line, column: d.column }));

describe("compileWidget", () => {
  test("the proposal's card compiles to the expected tree and actions", () => {
    const ref = { itemId: "11111111-1111-4111-8111-111111111111", ref: "org/pedido-card", version: 3 };
    const result = compileWidget(files(PEDIDO_HTML), { ref });
    expect(result.diagnostics).toEqual([
      {
        severity: "warning",
        code: "TEMPLATE_VARIANT_MISSING",
        message: 'Variant "compact" has no <ravi-variant name="compact"> block in widget.html; it renders like default.',
        file: "widget.html",
        line: 1,
        column: 1,
      },
    ]);
    const widget = result.widget;
    if (!widget) throw new Error("expected a compiled widget");
    const expected: TemplateNode[] = [
      {
        k: "el",
        piece: "ravi-card",
        attrs: {},
        line: 1,
        children: [
          {
            k: "el",
            piece: "ravi-row",
            attrs: { justify: { lit: "between" } },
            line: 2,
            children: [
              { k: "el", piece: "ravi-title", attrs: {}, line: 3, children: [{ k: "expr", path: ["titulo"], filters: [] }] },
              { k: "el", piece: "ravi-field", attrs: { name: { lit: "status" } }, line: 4, children: [] },
            ],
          },
          {
            k: "el",
            piece: "ravi-text",
            attrs: { tone: { lit: "secondary" } },
            line: 6,
            children: [
              { k: "expr", path: ["cliente"], filters: [] },
              { k: "text", v: " · " },
              { k: "expr", path: ["prazo"], filters: ["relative"] },
            ],
          },
          {
            k: "el",
            piece: "ravi-row",
            attrs: { justify: { lit: "between" } },
            line: 7,
            children: [
              { k: "el", piece: "ravi-field", attrs: { name: { lit: "responsavel" } }, line: 8, children: [] },
              { k: "el", piece: "ravi-field", attrs: { name: { lit: "valor" } }, line: 9, children: [] },
            ],
          },
          {
            k: "el",
            piece: "ravi-button",
            attrs: { action: { lit: "update" }, set: { lit: "status=@done" }, "data-ravi-action": { lit: "0" } },
            line: 11,
            children: [{ k: "text", v: "Concluir" }],
          },
        ],
      },
    ];
    expect(widget.variants.default).toEqual(expected);
    expect(widget.variants.compact).toEqual(expected);
    expect(Object.keys(widget.variants)).toEqual(["default", "compact"]);
    expect(widget.actions).toEqual([
      { verb: "update", set: { status: { kind: "status_group", group: "done" } }, href: null, confirm: false, label: "Concluir" },
    ]);
    expect(widget).toMatchObject({ v: 1, ref, name: "Cartão de pedido", description: "Pedido com status, cliente, prazo, responsável e valor." });
    expect(widget.fields.responsavel).toEqual({ type: "person", required: false, label: "Responsável" });
    expect(widget.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.manifest?.variants).toEqual(["default", "compact"]);
    expect(result.example).toEqual([]);
  });

  test("missing files", () => {
    expect(errors(compileWidget([]))).toEqual([
      { code: "WIDGET_FILE_MISSING", file: "widget.json", line: undefined, column: undefined },
      { code: "WIDGET_FILE_MISSING", file: "widget.html", line: undefined, column: undefined },
    ]);
  });

  test("an invalid manifest still reports template syntax, but no field errors", () => {
    const result = compileWidget(files("<ravi-text>{nada}</ravi-text><div></div>", "{"));
    expect(result.widget).toBeNull();
    expect(errors(result).map((d) => d.code)).toEqual(["MANIFEST_JSON", "TEMPLATE_UNKNOWN_ELEMENT"]);
  });

  test("diagnostics come by file (widget.json, widget.html, example.json), then position", () => {
    const json = PEDIDO_JSON.replace('"variants"', '"extra": 1, "variants"');
    const result = compileWidget(files('<ravi-text>{b}</ravi-text>\n<ravi-text tone="x">{a}</ravi-text>', json, "[]"));
    expect(errors(result).map((d) => [d.file, d.line])).toEqual([
      ["widget.json", 13],
      ["widget.html", 2],
      ["example.json", 1],
    ]);
  });
});

describe("field checks", () => {
  const FIELDS = `{
  "name": "Teste",
  "description": "Teste",
  "fields": {
    "titulo": { "type": "text", "required": true },
    "status": { "type": "status" },
    "prazo": { "type": "date" },
    "tags": { "type": "multi_select" },
    "pessoas": { "type": "person" },
    "refs": { "type": "ref" },
    "valor": { "type": "number" },
    "progresso": { "type": "number", "role": "progress" },
    "site": { "type": "url" },
    "email": { "type": "email" }
  }
}`;
  const check = (html: string) => errors(compileWidget(files(html, FIELDS)));

  test("unknown fields in text, blocks, attributes and ravi-field, with line and column", () => {
    expect(
      check(`<ravi-card><ravi-title>{titlo}</ravi-title>
  {#if prazoo}x{/if}
  {#each tagz as item}{item}{/each}
  <ravi-image src="{capaa}" alt="decorative"></ravi-image>
  <ravi-field name="stats"></ravi-field>
</ravi-card>`),
    ).toEqual([
      { code: "TEMPLATE_UNKNOWN_FIELD", file: "widget.html", line: 1, column: 25 },
      { code: "TEMPLATE_UNKNOWN_FIELD", file: "widget.html", line: 2, column: 8 },
      { code: "TEMPLATE_UNKNOWN_FIELD", file: "widget.html", line: 3, column: 10 },
      { code: "TEMPLATE_UNKNOWN_FIELD", file: "widget.html", line: 4, column: 20 },
      { code: "TEMPLATE_UNKNOWN_FIELD", file: "widget.html", line: 5, column: 21 },
    ]);
  });

  test("the unknown-field message suggests the closest field", () => {
    const result = compileWidget(files("<ravi-card><ravi-title>{titlo}</ravi-title></ravi-card>", FIELDS));
    expect(result.diagnostics[0]?.message).toContain('did you mean "titulo"?');
  });

  test("filters accept their field types", () => {
    expect(check("<ravi-card><ravi-title>{titulo | initials}</ravi-title>{prazo | relative}{valor | compact}{pessoas | initials}</ravi-card>")).toEqual([]);
    expect(check("<ravi-card><ravi-title>{titulo}</ravi-title>{prazo | currency}{titulo | date}</ravi-card>")).toEqual([
      { code: "TEMPLATE_FILTER_TYPE", file: "widget.html", line: 1, column: 46 },
      { code: "TEMPLATE_FILTER_TYPE", file: "widget.html", line: 1, column: 64 },
    ]);
  });

  test("each over multi_select, person and ref, with item properties per type", () => {
    expect(
      check(`<ravi-card><ravi-title>{titulo}</ravi-title>
{#each tags as item}{item.name} {item.color} {item.id}{/each}
{#each pessoas as item}<ravi-avatar name="{item}"></ravi-avatar>{item.displayName | initials}{/each}
{#each refs as item}{item.type}:{item.id}{/each}
</ravi-card>`),
    ).toEqual([]);
    expect(
      check(`<ravi-card><ravi-title>{titulo}</ravi-title>
{#each status as item}{item}{/each}
{#each tags as item}{item.displayName}{/each}
{#each refs as titulo}{titulo}{/each}
</ravi-card>`),
    ).toEqual([
      { code: "TEMPLATE_EACH_TYPE", file: "widget.html", line: 2, column: 8 },
      { code: "TEMPLATE_ITEM_PATH", file: "widget.html", line: 3, column: 22 },
      { code: "TEMPLATE_EACH_ALIAS", file: "widget.html", line: 4, column: 1 },
    ]);
  });

  test("attributes take fields of their types", () => {
    expect(
      check(`<ravi-card><ravi-title>{titulo}</ravi-title>
<ravi-image src="{titulo}" alt="{tags}"></ravi-image>
<ravi-link href="{email}">e-mail</ravi-link>
<ravi-metric value="{prazo}"></ravi-metric>
<ravi-progress value="{progresso}" max="{site}"></ravi-progress>
</ravi-card>`),
    ).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_FIELD", file: "widget.html", line: 2, column: 18 },
      { code: "TEMPLATE_ATTRIBUTE_FIELD", file: "widget.html", line: 2, column: 33 },
      { code: "TEMPLATE_ATTRIBUTE_FIELD", file: "widget.html", line: 4, column: 21 },
      { code: "TEMPLATE_ATTRIBUTE_FIELD", file: "widget.html", line: 5, column: 41 },
    ]);
  });

  test("display depends on the field type and role", () => {
    const field = (name: string, display: string) => check(`<ravi-card><ravi-title>t</ravi-title><ravi-field name="${name}" display="${display}"></ravi-field></ravi-card>`);
    expect(field("status", "steps")).toEqual([]);
    expect(field("valor", "currency")).toEqual([]);
    expect(field("valor", "bar")).toEqual([]);
    expect(field("progresso", "ring")).toEqual([]);
    expect(field("prazo", "relative")).toEqual([]);
    expect(field("valor", "ring")).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", file: "widget.html", line: 1, column: 72 }]);
    expect(field("status", "bar")).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", file: "widget.html", line: 1, column: 73 }]);
    expect(field("titulo", "pill")).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", file: "widget.html", line: 1, column: 73 }]);
  });

  test("set is checked against the fields", () => {
    expect(
      check(`<ravi-card><ravi-title>{titulo}</ravi-title>
<ravi-button action="update" set="status=@done;valor=muito">Concluir</ravi-button>
<ravi-button action="update" set="pessoas=@me">Pegar</ravi-button>
</ravi-card>`),
    ).toEqual([
      { code: "SET_TYPE", file: "widget.html", line: 2, column: 54 },
      { code: "SET_ME", file: "widget.html", line: 3, column: 43 },
    ]);
  });
});

describe("variants", () => {
  const json = (variants: string[]) => PEDIDO_JSON.replace('["default", "compact"]', JSON.stringify(variants));

  test("each declared variant gets its block, else default with a warning", () => {
    const html = `<ravi-variant name="default">
  <ravi-card><ravi-title>{titulo}</ravi-title></ravi-card>
</ravi-variant>
<ravi-variant name="compact">
  <ravi-text>{titulo}</ravi-text>
</ravi-variant>`;
    const result = compileWidget(files(html, json(["default", "compact", "detail"])));
    expect(result.diagnostics.map((d) => [d.severity, d.code, d.line])).toEqual([["warning", "TEMPLATE_VARIANT_MISSING", 1]]);
    const widget = result.widget;
    if (!widget) throw new Error("expected a compiled widget");
    expect(widget.variants.compact).toEqual([{ k: "el", piece: "ravi-text", attrs: {}, line: 5, children: [{ k: "expr", path: ["titulo"], filters: [] }] }]);
    expect(widget.variants.detail).toEqual(widget.variants.default);
  });

  test("blocks for undeclared variants and a missing default block are errors", () => {
    const html = `<ravi-variant name="compact">
  <ravi-text>{titulo}</ravi-text>
</ravi-variant>
<ravi-variant name="detail">
  <ravi-text>{titulo}</ravi-text>
</ravi-variant>`;
    expect(errors(compileWidget(files(html, json(["default", "compact"]))))).toEqual([
      { code: "TEMPLATE_VARIANT_DEFAULT_MISSING", file: "widget.html", line: 1, column: 1 },
      { code: "TEMPLATE_VARIANT_UNDECLARED", file: "widget.html", line: 4, column: 1 },
    ]);
  });

  test("accessibility lint runs per variant (compact cards may skip the title)", () => {
    const html = `<ravi-variant name="default"><ravi-card><ravi-title>{titulo}</ravi-title></ravi-card></ravi-variant>
<ravi-variant name="compact"><ravi-card><ravi-text>{titulo}</ravi-text></ravi-card></ravi-variant>`;
    const result = compileWidget(files(html));
    expect(result.widget).not.toBeNull();
    expect(result.diagnostics.map((d) => [d.severity, d.code, d.line, d.column])).toEqual([["warning", "A11Y_CARD_TITLE", 2, 30]]);
  });
});

describe("actions", () => {
  test("document order across variants, identical actions share an index", () => {
    const html = `<ravi-variant name="default">
  <ravi-card>
    <ravi-title>{titulo}</ravi-title>
    <ravi-button action="update" set="status=@done" variant="primary">Concluir</ravi-button>
    <ravi-button action="open" href="{capa}">Ver capa</ravi-button>
    <ravi-button action="archive">Arquivar</ravi-button>
  </ravi-card>
</ravi-variant>
<ravi-variant name="compact">
  <ravi-card>
    <ravi-title>{titulo}</ravi-title>
    <ravi-button action="update" set="status=@done">  Concluir </ravi-button>
    <ravi-button action="create" set="titulo=Novo pedido;valor=0" confirm>Duplicar <ravi-badge>novo</ravi-badge>{titulo}</ravi-button>
    <ravi-button action="open">Detalhes</ravi-button>
  </ravi-card>
</ravi-variant>`;
    const result = compileWidget(files(html));
    expect(errors(result)).toEqual([]);
    const widget = result.widget;
    if (!widget) throw new Error("expected a compiled widget");
    expect(widget.actions).toEqual([
      { verb: "update", set: { status: { kind: "status_group", group: "done" } }, href: null, confirm: false, label: "Concluir" },
      { verb: "open", set: {}, href: "capa", confirm: false, label: "Ver capa" },
      { verb: "archive", set: {}, href: null, confirm: true, label: "Arquivar" },
      {
        verb: "create",
        set: { titulo: { kind: "literal", value: "Novo pedido" }, valor: { kind: "number", value: 0 } },
        href: null,
        confirm: true,
        label: "Duplicar novo",
      },
      { verb: "open", set: {}, href: null, confirm: false, label: "Detalhes" },
    ]);
    const indexes = (nodes: readonly TemplateNode[]): string[] =>
      nodes.flatMap((node) => {
        if (node.k !== "el") return [];
        const index = node.attrs["data-ravi-action"];
        return [...(index && "lit" in index ? [index.lit] : []), ...indexes(node.children)];
      });
    expect(indexes(widget.variants.default)).toEqual(["0", "1", "2"]);
    expect(indexes(widget.variants.compact ?? [])).toEqual(["0", "3", "4"]);
  });

  test("buttons inside blocks are actions too", () => {
    const html = `<ravi-card><ravi-title>{titulo}</ravi-title>{#if status}<ravi-button action="update" set="status=@todo">Reabrir</ravi-button>{:else}<ravi-button action="update" set="status=@in_progress">Começar</ravi-button>{/if}</ravi-card>`;
    const widget = compileWidget(files(html)).widget;
    expect(widget?.actions.map((action) => action.label)).toEqual(["Reabrir", "Começar"]);
  });
});

describe("hash", () => {
  test("stable across key order in widget.json and template formatting", () => {
    const a = compileWidget(files(PEDIDO_HTML)).widget;
    const reordered = JSON.stringify({
      variants: ["default", "compact"],
      fields: {
        capa: { role: "image", type: "url" },
        valor: { role: "highlight", type: "number" },
        responsavel: { label: "Responsável", type: "person" },
        prazo: { type: "date" },
        cliente: { type: "text" },
        status: { type: "status" },
        titulo: { label: "Pedido", required: true, type: "text" },
      },
      description: "Pedido com status, cliente, prazo, responsável e valor.",
      name: "Cartão de pedido",
    });
    const b = compileWidget(files(PEDIDO_HTML, reordered)).widget;
    const c = compileWidget(files(`\n\n${PEDIDO_HTML.replace(/\n {2}/g, "\n      ")}`)).widget;
    expect(a?.hash).toBeDefined();
    expect(b?.hash).toBe(a?.hash as string);
    expect(c?.hash).toBe(a?.hash as string);
  });

  test("changes when what renders changes", () => {
    const a = compileWidget(files(PEDIDO_HTML)).widget;
    const b = compileWidget(files(PEDIDO_HTML.replace("Concluir", "Fechar"))).widget;
    const c = compileWidget(files(PEDIDO_HTML, PEDIDO_JSON.replace('"label": "Pedido"', '"label": "Ordem"'))).widget;
    expect(b?.hash).not.toBe(a?.hash as string);
    expect(c?.hash).not.toBe(a?.hash as string);
  });

  test("canonicalJson sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: undefined, x: null }], c: "é" } })).toBe('{"a":{"c":"é","d":[3,{"x":null,"z":1}]},"b":1}');
  });
});

describe("example.json", () => {
  const compileExample = (example: string) => compileWidget(files(PEDIDO_HTML, PEDIDO_JSON, example));

  test("one record or { records }", () => {
    expect(compileExample('{ "titulo": "Pedido 1", "valor": 10 }').example).toEqual([{ titulo: "Pedido 1", valor: 10 }]);
    expect(compileExample('{ "records": [{ "titulo": "A" }, { "titulo": "B" }] }').example).toEqual([{ titulo: "A" }, { titulo: "B" }]);
  });

  test("shape errors", () => {
    expect(errors(compileExample('{\n  "titulo": "A",\n}'))).toEqual([{ code: "EXAMPLE_JSON", file: "example.json", line: 3, column: 1 }]);
    expect(errors(compileExample('[{ "titulo": "A" }]')).map((d) => d.code)).toEqual(["EXAMPLE_SHAPE"]);
    expect(errors(compileExample('{\n  "records": [1, 2]\n}'))).toEqual([{ code: "EXAMPLE_SHAPE", file: "example.json", line: 2, column: 3 }]);
    const many = JSON.stringify({ records: Array.from({ length: 21 }, (_, i) => ({ titulo: `P${i}` })) });
    expect(errors(compileExample(many)).map((d) => d.code)).toEqual(["EXAMPLE_TOO_MANY"]);
    expect(compileExample(many).example).toEqual([]);
  });

  test("warns when a value looks like a real e-mail or phone", () => {
    const result = compileExample(`{
  "records": [
    { "titulo": "Pedido 1", "cliente": "ana.souza@gmail.com" },
    { "titulo": "Pedido 2", "cliente": "Ligar (11) 98765-4321", "prazo": "2026-10-20" },
    { "titulo": "Pedido 3", "cliente": "ana@example.com", "capa": "https://example.com/12345678/capa.jpg" }
  ]
}`);
    expect(result.widget).not.toBeNull();
    expect(result.diagnostics.filter((d) => d.code === "EXAMPLE_PERSONAL_DATA").map((d) => [d.severity, d.line, d.message.split(";")[0]])).toEqual([
      ["warning", 3, "example.json records.0.cliente looks like a real e-mail address"],
      ["warning", 4, "example.json records.1.cliente looks like a real phone number"],
    ]);
  });

  test("personal-data heuristics", () => {
    expect(looksLikeEmail("contato: joao@empresa.com.br")).toBe(true);
    expect(looksLikeEmail("time@example.org")).toBe(false);
    expect(looksLikeEmail("a@b.test")).toBe(false);
    expect(looksLikePhone("+55 11 98765-4321")).toBe(true);
    expect(looksLikePhone("2026-10-20T12:30:00Z")).toBe(false);
    expect(looksLikePhone("R$ 1.890,50")).toBe(false);
    expect(looksLikePhone("Pedido 1042")).toBe(false);
    // Invented numbers: the last 8 digits are zeros.
    expect(looksLikePhone("+55 11 90000-0000")).toBe(false);
    expect(looksLikePhone("+5500000000000")).toBe(false);
    expect(looksLikePhone("(00) 0000-0000")).toBe(false);
    expect(looksLikePhone("+55 11 90000-0001")).toBe(true);
  });

  test("the personal-data hint is per kind, and the value it suggests passes the check", () => {
    const result = compileExample(`{ "records": [{ "titulo": "A", "cliente": "ana.souza@gmail.com" }, { "titulo": "B", "cliente": "+55 11 98765-4321" }] }`);
    const [email, phone] = result.diagnostics.filter((d) => d.code === "EXAMPLE_PERSONAL_DATA").map((d) => d.message);
    expect(email).toContain("example.com, example.org or example.net, or a .test or .example domain (e.g. ana@example.com)");
    expect(phone).toContain("last 8 digits are zeros (e.g. +55 11 90000-0000)");
    expect(phone).not.toContain("@");
    const suggested = (message: string | undefined) => /\(e\.g\. ([^)]+)\)/.exec(message ?? "")?.[1] ?? "";
    expect(suggested(email)).toBe("ana@example.com");
    expect(suggested(phone)).toBe("+55 11 90000-0000");
    expect(looksLikeEmail(suggested(email))).toBe(false);
    expect(looksLikePhone(suggested(phone))).toBe(false);
    const fixed = compileExample(`{ "records": [{ "titulo": "A", "cliente": "ana@example.com" }, { "titulo": "B", "cliente": "+55 11 90000-0000" }, { "titulo": "C", "cliente": "+5500000000000" }] }`);
    expect(fixed.diagnostics.filter((d) => d.code === "EXAMPLE_PERSONAL_DATA")).toEqual([]);
  });
});
