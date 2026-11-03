import { describe, expect, test } from "bun:test";

import type { Diagnostic } from "../types";
import { parseWidgetTemplate, type AstNode } from "./parse";

function diagnostics(source: string) {
  return parseWidgetTemplate(source).diagnostics.map((d: Diagnostic) => ({ code: d.code, line: d.line, column: d.column }));
}

function only(source: string) {
  const result = parseWidgetTemplate(source);
  expect(result.diagnostics).toEqual([]);
  return result.variants[0]?.nodes ?? [];
}

/** Drops positions so trees compare by shape. */
function shape(nodes: readonly AstNode[]): unknown[] {
  return nodes.map((node) => {
    switch (node.k) {
      case "text":
        return node.v;
      case "expr":
        return { expr: node.path.join("."), filters: node.filters };
      case "if":
        return { if: `${node.not ? "!" : ""}${node.path.join(".")}`, then: shape(node.then), else: shape(node.else) };
      case "each":
        return { each: node.path.join("."), as: node.as, children: shape(node.children) };
      case "el":
        return {
          el: node.piece,
          attrs: Object.fromEntries(node.attrs.map((attr) => [attr.name, "lit" in attr.value ? attr.value.lit : `{${attr.value.ref.join(".")}}`])),
          children: shape(node.children),
        };
    }
  });
}

describe("parseWidgetTemplate grammar", () => {
  test("pieces, attributes, interpolation and filters", () => {
    const nodes = only(`<ravi-card>
  <ravi-row justify="between">
    <ravi-title>{titulo}</ravi-title>
    <ravi-field name="status"></ravi-field>
  </ravi-row>
  <ravi-text tone="secondary">{cliente} · {prazo | relative}</ravi-text>
  <ravi-text>{ valor | compact | currency }</ravi-text>
</ravi-card>`);
    expect(shape(nodes)).toEqual([
      {
        el: "ravi-card",
        attrs: {},
        children: [
          {
            el: "ravi-row",
            attrs: { justify: "between" },
            children: [
              { el: "ravi-title", attrs: {}, children: [{ expr: "titulo", filters: [] }] },
              { el: "ravi-field", attrs: { name: "status" }, children: [] },
            ],
          },
          {
            el: "ravi-text",
            attrs: { tone: "secondary" },
            children: [{ expr: "cliente", filters: [] }, " · ", { expr: "prazo", filters: ["relative"] }],
          },
          { el: "ravi-text", attrs: {}, children: [{ expr: "valor", filters: ["compact", "currency"] }] },
        ],
      },
    ]);
  });

  test("every node and attribute carries its line and column", () => {
    const nodes = only(`<ravi-card>
  <ravi-text tone="secondary">Prazo: {prazo | date}</ravi-text>
</ravi-card>`);
    const card = nodes[0];
    if (card?.k !== "el") throw new Error("expected the card");
    expect(card.pos).toEqual({ line: 1, column: 1 });
    const text = card.children[0];
    if (text?.k !== "el") throw new Error("expected the text");
    expect(text.pos).toEqual({ line: 2, column: 3 });
    expect(text.attrs[0]?.pos).toEqual({ line: 2, column: 14 });
    expect(text.attrs[0]?.valuePos).toEqual({ line: 2, column: 20 });
    const expr = text.children[1];
    if (expr?.k !== "expr") throw new Error("expected the interpolation");
    expect(expr.pos).toEqual({ line: 2, column: 38 });
    expect(expr.pathPos).toEqual({ line: 2, column: 39 });
  });

  test("whitespace: dropped between layout pieces, a word space in text, element content trimmed", () => {
    const nodes = only(`<ravi-row>
  <ravi-text>
    Total:   {valor}
    {#if desconto} ({desconto}){/if}
    {cliente}
    <ravi-badge>novo</ravi-badge>
  </ravi-text>
  {#if a}
    <ravi-button action="archive">
       Arquivar
    </ravi-button>
  {/if}
</ravi-row>`);
    expect(shape(nodes)).toEqual([
      {
        el: "ravi-row",
        attrs: {},
        children: [
          {
            el: "ravi-text",
            attrs: {},
            children: [
              "Total: ",
              { expr: "valor", filters: [] },
              " ",
              { if: "desconto", then: [" (", { expr: "desconto", filters: [] }, ")"], else: [] },
              " ",
              { expr: "cliente", filters: [] },
              " ",
              { el: "ravi-badge", attrs: {}, children: ["novo"] },
            ],
          },
          { if: "a", then: [{ el: "ravi-button", attrs: { action: "archive" }, children: ["Arquivar"] }], else: [] },
        ],
      },
    ]);
  });

  test("entities are literal text, so &#123; is a brace and not an interpolation", () => {
    expect(shape(only("<ravi-text>&#123;literal&#125; &amp; {x}</ravi-text>"))).toEqual([
      { el: "ravi-text", attrs: {}, children: ["{literal} & ", { expr: "x", filters: [] }] },
    ]);
  });

  test("comments are dropped", () => {
    expect(shape(only("<ravi-text><!-- note -->a</ravi-text>"))).toEqual([{ el: "ravi-text", attrs: {}, children: ["a"] }]);
  });

  test("bare boolean attributes read as true; field attributes keep the path", () => {
    expect(shape(only('<ravi-row wrap><ravi-image src="{capa}" alt="decorative"></ravi-image></ravi-row>'))).toEqual([
      { el: "ravi-row", attrs: { wrap: "true" }, children: [{ el: "ravi-image", attrs: { src: "{capa}", alt: "decorative" }, children: [] }] },
    ]);
  });
});

describe("blocks", () => {
  test("if/else and each nest across elements and wrap elements", () => {
    const nodes = only(`<ravi-card>
  {#if !capa}
    <ravi-title>{titulo}</ravi-title>
  {:else}
    <ravi-image src="{capa}" alt="{titulo}"></ravi-image>
  {/if}
  <ravi-row>
    {#each etiquetas as item}
      {#if item.color}
        <ravi-badge>{item.name}</ravi-badge>
      {/if}
    {/each}
  </ravi-row>
  {#each pessoas as pessoa}
    <ravi-stack>
      {#each tags as tag}<ravi-text>{pessoa.name}: {tag}</ravi-text>{/each}
    </ravi-stack>
  {/each}
</ravi-card>`);
    expect(shape(nodes)).toEqual([
      {
        el: "ravi-card",
        attrs: {},
        children: [
          {
            if: "!capa",
            then: [{ el: "ravi-title", attrs: {}, children: [{ expr: "titulo", filters: [] }] }],
            else: [{ el: "ravi-image", attrs: { src: "{capa}", alt: "{titulo}" }, children: [] }],
          },
          {
            el: "ravi-row",
            attrs: {},
            children: [
              {
                each: "etiquetas",
                as: "item",
                children: [{ if: "item.color", then: [{ el: "ravi-badge", attrs: {}, children: [{ expr: "item.name", filters: [] }] }], else: [] }],
              },
            ],
          },
          {
            each: "pessoas",
            as: "pessoa",
            children: [
              {
                el: "ravi-stack",
                attrs: {},
                children: [
                  {
                    each: "tags",
                    as: "tag",
                    children: [
                      {
                        el: "ravi-text",
                        attrs: {},
                        children: [{ expr: "pessoa.name", filters: [] }, ": ", { expr: "tag", filters: [] }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("a block must close in the parent it opened in", () => {
    expect(diagnostics(`<ravi-row>
  {#if a}<ravi-text>x</ravi-text>
</ravi-row>
{/if}`)).toEqual([
      { code: "TEMPLATE_BLOCK_UNCLOSED", line: 2, column: 3 },
      { code: "TEMPLATE_BLOCK_UNEXPECTED", line: 4, column: 1 },
    ]);
  });

  test("mismatched and misplaced block delimiters", () => {
    expect(diagnostics("<ravi-text>{#if a}{#each b as item}{/if}</ravi-text>")).toEqual([
      { code: "TEMPLATE_BLOCK_UNCLOSED", line: 1, column: 19 },
    ]);
    expect(diagnostics("<ravi-text>{#if a}x{:else}y{:else}z{/if}</ravi-text>")).toEqual([
      { code: "TEMPLATE_BLOCK_UNEXPECTED", line: 1, column: 28 },
    ]);
    expect(diagnostics("<ravi-text>{#each a as item}{:else}{/each}</ravi-text>")).toEqual([
      { code: "TEMPLATE_BLOCK_UNEXPECTED", line: 1, column: 29 },
    ]);
    expect(diagnostics("<ravi-text>{:else}</ravi-text>")).toEqual([{ code: "TEMPLATE_BLOCK_UNEXPECTED", line: 1, column: 12 }]);
    expect(diagnostics("<ravi-text>{/each}</ravi-text>")).toEqual([{ code: "TEMPLATE_BLOCK_UNEXPECTED", line: 1, column: 12 }]);
  });

  test("blocks nest at most 8 deep, counted across elements", () => {
    const open = (n: number) => Array.from({ length: n }, (_, i) => `{#if f${i}}`).join("");
    const close = (n: number) => "{/if}".repeat(n);
    expect(diagnostics(`<ravi-text>${open(8)}x${close(8)}</ravi-text>`)).toEqual([]);
    expect(diagnostics(`<ravi-stack>${open(5)}<ravi-text>${open(4)}x${close(4)}</ravi-text>${close(5)}</ravi-stack>`)).toEqual([
      { code: "TEMPLATE_BLOCK_DEPTH", line: 1, column: 1 + "<ravi-stack>".length + open(5).length + "<ravi-text>".length + open(3).length },
    ]);
  });

  test("item exists only inside each, with the known properties", () => {
    expect(diagnostics("<ravi-text>{item}</ravi-text>")).toEqual([{ code: "TEMPLATE_ITEM_PATH", line: 1, column: 13 }]);
    expect(diagnostics("<ravi-text>{#each tags as item}{item.zzz}{/each}</ravi-text>")).toEqual([
      { code: "TEMPLATE_ITEM_PATH", line: 1, column: 33 },
    ]);
    expect(diagnostics("<ravi-text>{#each a as item}{#each item as x}{/each}{/each}</ravi-text>")).toEqual([
      { code: "TEMPLATE_EACH_TYPE", line: 1, column: 36 },
    ]);
    expect(diagnostics("<ravi-text>{#each a as item}{#each b as item}{/each}{/each}</ravi-text>")).toEqual([
      { code: "TEMPLATE_EACH_ALIAS", line: 1, column: 29 },
    ]);
    expect(diagnostics("<ravi-text>{#each a as Item}{/each}</ravi-text>")).toEqual([
      { code: "TEMPLATE_EACH_ALIAS", line: 1, column: 12 },
      { code: "TEMPLATE_BLOCK_UNEXPECTED", line: 1, column: 29 },
    ]);
  });

  test("expression syntax", () => {
    expect(diagnostics("<ravi-text>{a + b}</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 12 }]);
    expect(diagnostics("<ravi-text>{cliente.nome}</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 13 }]);
    expect(diagnostics("<ravi-text>{}</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 12 }]);
    expect(diagnostics("<ravi-text>{a</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 12 }]);
    expect(diagnostics("<ravi-text>a }</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 14 }]);
    expect(diagnostics("<ravi-text>{#for a}</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 12 }]);
    expect(diagnostics("<ravi-text>{#if a > 1}x{/if}</ravi-text>")).toEqual([
      { code: "TEMPLATE_EXPRESSION", line: 1, column: 12 },
      { code: "TEMPLATE_BLOCK_UNEXPECTED", line: 1, column: 24 },
    ]);
    expect(diagnostics("<ravi-text>{#if a}x{:else if b}y{/if}</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 20 }]);
    expect(diagnostics("<ravi-text>{a | date | date | date}</ravi-text>")).toEqual([{ code: "TEMPLATE_EXPRESSION", line: 1, column: 12 }]);
    expect(diagnostics("<ravi-text>{prazo | ago}</ravi-text>")).toEqual([{ code: "TEMPLATE_UNKNOWN_FILTER", line: 1, column: 21 }]);
  });
});

describe("elements and closing", () => {
  test("self-closing pieces are an error found in the source", () => {
    expect(diagnostics(`<ravi-card>
  <ravi-title>{t}</ravi-title>
  <ravi-field name="status" />
  <ravi-divider/>
</ravi-card>`)).toEqual([
      { code: "TEMPLATE_SELF_CLOSING", line: 3, column: 3 },
      { code: "TEMPLATE_SELF_CLOSING", line: 4, column: 3 },
    ]);
  });

  test("unclosed and stray closing tags", () => {
    expect(diagnostics("<ravi-card>\n  <ravi-title>a\n</ravi-card>")).toEqual([{ code: "TEMPLATE_UNCLOSED_ELEMENT", line: 2, column: 3 }]);
    expect(diagnostics("<ravi-stack>\n  </ravi-row>\n</ravi-stack>")).toEqual([{ code: "TEMPLATE_STRAY_CLOSING_TAG", line: 2, column: 3 }]);
    expect(diagnostics("<ravi-stack>a")).toEqual([{ code: "TEMPLATE_UNCLOSED_ELEMENT", line: 1, column: 1 }]);
  });

  test("only catalog pieces; content inside unknown elements is still checked", () => {
    expect(diagnostics('<div>\n  <ravi-text style="color: red">a</ravi-text>\n</div>')).toEqual([
      { code: "TEMPLATE_UNKNOWN_ELEMENT", line: 1, column: 1 },
      { code: "TEMPLATE_FORBIDDEN_ATTRIBUTE", line: 2, column: 14 },
    ]);
    expect(diagnostics("<ravi-cardz>a</ravi-cardz>")).toEqual([{ code: "TEMPLATE_UNKNOWN_ELEMENT", line: 1, column: 1 }]);
    expect(diagnostics('<ravi-view view="x"></ravi-view><ravi-text>a</ravi-text>')).toEqual([
      { code: "TEMPLATE_UNKNOWN_ELEMENT", line: 1, column: 1 },
    ]);
    expect(diagnostics("<script>{x}</script><ravi-text>a</ravi-text>")).toEqual([{ code: "TEMPLATE_UNKNOWN_ELEMENT", line: 1, column: 1 }]);
    expect(diagnostics("<!DOCTYPE html>\n<ravi-text>a</ravi-text>")).toEqual([{ code: "TEMPLATE_UNKNOWN_ELEMENT", line: 1, column: 1 }]);
  });

  test("an empty template is an error", () => {
    expect(diagnostics("  \n <!-- nothing --> \n")).toEqual([{ code: "TEMPLATE_EMPTY", line: 1, column: 1 }]);
  });

  test("content model: inline content, controls never nest, childless pieces", () => {
    expect(diagnostics("<ravi-text><ravi-card>x</ravi-card></ravi-text>")).toEqual([
      { code: "TEMPLATE_CONTENT_NOT_ALLOWED", line: 1, column: 12 },
    ]);
    expect(diagnostics('<ravi-button action="archive"><ravi-link href="https://a.example">x</ravi-link></ravi-button>')).toEqual([
      { code: "TEMPLATE_CONTENT_NOT_ALLOWED", line: 1, column: 31 },
    ]);
    expect(diagnostics('<ravi-title><ravi-badge>novo</ravi-badge> {titulo} <ravi-link href="{site}">site</ravi-link></ravi-title>')).toEqual([]);
    expect(diagnostics('<ravi-image src="{capa}" alt="decorative">legenda</ravi-image>')).toEqual([
      { code: "TEMPLATE_CHILDREN_NOT_ALLOWED", line: 1, column: 1 },
    ]);
  });

  test("pieces nest at most 32 deep", () => {
    const deep = (n: number) => `${"<ravi-stack>".repeat(n)}x${"</ravi-stack>".repeat(n)}`;
    expect(diagnostics(deep(32))).toEqual([]);
    expect(diagnostics(deep(33))).toEqual([{ code: "TEMPLATE_ELEMENT_DEPTH", line: 1, column: 1 + 32 * "<ravi-stack>".length }]);
  });
});

describe("attributes", () => {
  test("forbidden attributes: style, class, id, on*, aria-*, data-*", () => {
    expect(
      diagnostics('<ravi-text class="a" id="b" onclick="c" aria-label="d" data-x="e" style="f" role="g">t</ravi-text>').map((d) => d.code),
    ).toEqual(Array(7).fill("TEMPLATE_FORBIDDEN_ATTRIBUTE"));
  });

  test("unknown, duplicate and required attributes", () => {
    expect(diagnostics('<ravi-row gapp="sm">a</ravi-row>')).toEqual([{ code: "TEMPLATE_UNKNOWN_ATTRIBUTE", line: 1, column: 11 }]);
    expect(diagnostics('<ravi-divider tone="x"></ravi-divider>')).toEqual([{ code: "TEMPLATE_UNKNOWN_ATTRIBUTE", line: 1, column: 15 }]);
    expect(diagnostics('<ravi-row gap="sm" gap="md">a</ravi-row>')).toEqual([{ code: "TEMPLATE_DUPLICATE_ATTRIBUTE", line: 1, column: 20 }]);
    expect(diagnostics("<ravi-field></ravi-field>")).toEqual([{ code: "TEMPLATE_REQUIRED_ATTRIBUTE", line: 1, column: 1 }]);
    expect(diagnostics("<ravi-metric></ravi-metric>")).toEqual([{ code: "TEMPLATE_REQUIRED_ATTRIBUTE", line: 1, column: 1 }]);
  });

  test("closed values", () => {
    expect(diagnostics('<ravi-text tone="blue">a</ravi-text>')).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 18 }]);
    expect(diagnostics('<ravi-grid columns="5">a</ravi-grid>')).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 21 }]);
    expect(diagnostics("<ravi-text tone>a</ravi-text>")).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 12 }]);
    expect(diagnostics('<ravi-badge color="red">a</ravi-badge><ravi-badge tone="danger">b</ravi-badge>')).toEqual([]);
    expect(diagnostics('<ravi-badge tone="danger" color="red">a</ravi-badge>')).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_CONFLICT", line: 1, column: 27 },
    ]);
  });

  test("a field only where the attribute takes one, exactly one whole {path}", () => {
    expect(diagnostics('<ravi-text tone="{cor}">a</ravi-text>')).toEqual([{ code: "TEMPLATE_ATTRIBUTE_FIELD", line: 1, column: 18 }]);
    expect(diagnostics('<ravi-image src="https://cdn.example/{id}.png" alt="x"></ravi-image>')).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_INTERPOLATION", line: 1, column: 18 },
    ]);
    expect(diagnostics('<ravi-image src="{capa | date}" alt="x"></ravi-image>')).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_FIELD", line: 1, column: 18 },
    ]);
    expect(diagnostics('<ravi-field name="{status}"></ravi-field>')).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 19 }]);
    expect(diagnostics('<ravi-image src=" { capa } " alt="{titulo}"></ravi-image>')).toEqual([]);
  });

  test("literal URLs: https for images; https, mailto and tel for links", () => {
    expect(diagnostics('<ravi-image src="https://cdn.example/a.png" alt="Logo"></ravi-image>')).toEqual([]);
    expect(diagnostics('<ravi-image src="http://cdn.example/a.png" alt="Logo"></ravi-image>')).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 18 },
    ]);
    expect(diagnostics('<ravi-link href="mailto:time@example.com">e-mail</ravi-link><ravi-link href="tel:+5511">tel</ravi-link>')).toEqual([]);
    expect(diagnostics('<ravi-link href="javascript:alert(1)">x</ravi-link>')).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 18 }]);
    expect(diagnostics('<ravi-progress value="{p}" max="0"></ravi-progress>')).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 33 }]);
    expect(diagnostics(`<ravi-metric value="{v}" label="${"x".repeat(81)}"></ravi-metric>`)).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 33 },
    ]);
  });

  test("button attributes follow the action", () => {
    expect(diagnostics('<ravi-button action="archive" set="a=b">x</ravi-button>')).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_CONFLICT", line: 1, column: 31 },
    ]);
    expect(diagnostics('<ravi-button action="update" href="{site}" set="a=b">x</ravi-button>')).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_CONFLICT", line: 1, column: 30 },
    ]);
    expect(diagnostics('<ravi-button action="open" confirm>x</ravi-button>')).toEqual([
      { code: "TEMPLATE_ATTRIBUTE_CONFLICT", line: 1, column: 28 },
    ]);
    expect(diagnostics('<ravi-button action="update">x</ravi-button>')).toEqual([{ code: "TEMPLATE_REQUIRED_ATTRIBUTE", line: 1, column: 1 }]);
    expect(diagnostics("<ravi-button>x</ravi-button>")).toEqual([{ code: "TEMPLATE_REQUIRED_ATTRIBUTE", line: 1, column: 1 }]);
    expect(diagnostics('<ravi-button action="delete">x</ravi-button>')).toEqual([{ code: "TEMPLATE_ATTRIBUTE_VALUE", line: 1, column: 22 }]);
  });
});

describe("variant blocks", () => {
  test("top-level blocks in source order", () => {
    const result = parseWidgetTemplate(`<ravi-variant name="compact">
  <ravi-text>{titulo}</ravi-text>
</ravi-variant>
<ravi-variant name="default">
  <ravi-title>{titulo}</ravi-title>
</ravi-variant>`);
    expect(result.diagnostics).toEqual([]);
    expect(result.hasVariantBlocks).toBe(true);
    expect(result.variants.map((variant) => [variant.name, variant.pos, shape(variant.nodes)])).toEqual([
      ["compact", { line: 1, column: 1 }, [{ el: "ravi-text", attrs: {}, children: [{ expr: "titulo", filters: [] }] }]],
      ["default", { line: 4, column: 1 }, [{ el: "ravi-title", attrs: {}, children: [{ expr: "titulo", filters: [] }] }]],
    ]);
  });

  test("without blocks the whole file is default", () => {
    const result = parseWidgetTemplate("<ravi-text>a</ravi-text>");
    expect(result.hasVariantBlocks).toBe(false);
    expect(result.variants.map((variant) => [variant.name, variant.pos])).toEqual([["default", null]]);
  });

  test("content outside blocks, nested, unknown, duplicate and empty blocks", () => {
    expect(diagnostics(`<ravi-variant name="default"><ravi-text>a</ravi-text></ravi-variant>
  solto
<ravi-text>b</ravi-text>`)).toEqual([
      { code: "TEMPLATE_OUTSIDE_VARIANT", line: 2, column: 3 },
      { code: "TEMPLATE_OUTSIDE_VARIANT", line: 3, column: 1 },
    ]);
    expect(diagnostics('<ravi-variant name="default"><ravi-card><ravi-variant name="compact"></ravi-variant></ravi-card></ravi-variant>')).toEqual([
      { code: "TEMPLATE_VARIANT_NESTED", line: 1, column: 41 },
    ]);
    expect(diagnostics('<ravi-variant name="wide"><ravi-text>a</ravi-text></ravi-variant>')).toEqual([
      { code: "TEMPLATE_VARIANT_NAME", line: 1, column: 21 },
    ]);
    expect(
      diagnostics('<ravi-variant name="default"><ravi-text>a</ravi-text></ravi-variant><ravi-variant name="default"><ravi-text>b</ravi-text></ravi-variant>'),
    ).toEqual([{ code: "TEMPLATE_VARIANT_DUPLICATE", line: 1, column: 69 }]);
    expect(diagnostics('<ravi-variant name="default" tone="x"><ravi-text>a</ravi-text></ravi-variant>')).toEqual([
      { code: "TEMPLATE_UNKNOWN_ATTRIBUTE", line: 1, column: 30 },
    ]);
    expect(diagnostics('<ravi-variant name="default"> </ravi-variant>')).toEqual([{ code: "TEMPLATE_EMPTY", line: 1, column: 1 }]);
  });
});
