import { describe, expect, test } from "bun:test";

import type { WidgetFieldSpec, WidgetVariant } from "../types";
import { lintTemplateAccessibility } from "./a11y";
import { parseWidgetTemplate } from "./parse";

function lint(source: string, variant: WidgetVariant = "default", fields?: Record<string, WidgetFieldSpec>) {
  const parsed = parseWidgetTemplate(source);
  expect(parsed.diagnostics).toEqual([]);
  return lintTemplateAccessibility(parsed.variants[0]?.nodes ?? [], { variant, fields }).map((d) => ({
    severity: d.severity,
    code: d.code,
    line: d.line,
    column: d.column,
  }));
}

describe("lintTemplateAccessibility", () => {
  test("a well-formed card passes", () => {
    expect(
      lint(`<ravi-card>
  <ravi-image src="{capa}" alt="decorative"></ravi-image>
  <ravi-title>{titulo}</ravi-title>
  <ravi-avatar name="{responsavel}"></ravi-avatar>
  <ravi-badge tone="success">{status}</ravi-badge>
  <ravi-link href="{site}">Abrir site</ravi-link>
  <ravi-button action="archive">Arquivar</ravi-button>
</ravi-card>`),
    ).toEqual([]);
  });

  test("images need alt, avatars need name", () => {
    expect(
      lint(`<ravi-card><ravi-title>t</ravi-title>
  <ravi-image src="{capa}"></ravi-image>
  <ravi-avatar src="{foto}"></ravi-avatar>
</ravi-card>`),
    ).toEqual([
      { severity: "error", code: "A11Y_IMAGE_ALT", line: 2, column: 3 },
      { severity: "error", code: "A11Y_AVATAR_NAME", line: 3, column: 3 },
    ]);
  });

  test("buttons and links need text; block delimiters and whitespace are not text", () => {
    expect(
      lint(`<ravi-stack>
  <ravi-button action="archive">  </ravi-button>
  <ravi-button action="archive">{#if a}{/if}</ravi-button>
  <ravi-link href="{site}"></ravi-link>
  <ravi-button action="archive">{#if a}Arquivar{:else}Remover{/if}</ravi-button>
  <ravi-button action="archive">{acao}</ravi-button>
  <ravi-link href="{site}"><ravi-image src="{logo}" alt="Site da empresa"></ravi-image></ravi-link>
  <ravi-link href="{site}"><ravi-image src="{logo}" alt="decorative"></ravi-image></ravi-link>
</ravi-stack>`),
    ).toEqual([
      { severity: "error", code: "A11Y_BUTTON_TEXT", line: 2, column: 3 },
      { severity: "error", code: "A11Y_BUTTON_TEXT", line: 3, column: 3 },
      { severity: "error", code: "A11Y_LINK_TEXT", line: 4, column: 3 },
      { severity: "error", code: "A11Y_LINK_TEXT", line: 8, column: 3 },
    ]);
  });

  test("with the widget's fields, buttons, links and colored badges need text every record has", () => {
    const fields: Record<string, WidgetFieldSpec> = {
      titulo: { type: "text", required: true },
      rotulo: { type: "text" },
      site: { type: "url" },
      logo: { type: "url" },
      pago: { type: "checkbox" },
      tags: { type: "multi_select" },
      time: { type: "person", required: true },
    };
    expect(
      lint(
        `<ravi-stack>
  <ravi-button action="archive">{rotulo}</ravi-button>
  <ravi-button action="archive">{#if !pronto}Concluir{/if}</ravi-button>
  <ravi-link href="{site}">{rotulo}</ravi-link>
  <ravi-badge tone="danger">{rotulo}</ravi-badge>
  <ravi-button action="archive"><ravi-image src="{logo}" alt="Arquivar"></ravi-image></ravi-button>
  <ravi-badge color="red">{#each tags as tag}{tag.name}{/each}</ravi-badge>
  <ravi-button action="archive">{titulo}</ravi-button>
  <ravi-button action="archive">{pago}</ravi-button>
  <ravi-button action="archive">Arquivar {rotulo}</ravi-button>
  <ravi-button action="archive">{#if rotulo}{rotulo}{:else}Arquivar{/if}</ravi-button>
  {#if rotulo}<ravi-link href="{site}">{rotulo}</ravi-link>{/if}
  {#if !rotulo}{:else}<ravi-badge tone="info">{rotulo}</ravi-badge>{/if}
  <ravi-badge color="red">{#each time as p}{p.name}{/each}</ravi-badge>
  {#if logo}<ravi-link href="{site}"><ravi-image src="{logo}" alt="{titulo}"></ravi-image></ravi-link>{/if}
  <ravi-text tone="secondary">{rotulo}</ravi-text>
</ravi-stack>`,
        "default",
        fields,
      ),
    ).toEqual([
      { severity: "error", code: "A11Y_BUTTON_TEXT", line: 2, column: 3 },
      { severity: "error", code: "A11Y_BUTTON_TEXT", line: 3, column: 3 },
      { severity: "error", code: "A11Y_LINK_TEXT", line: 4, column: 3 },
      { severity: "error", code: "A11Y_COLOR_ONLY", line: 5, column: 3 },
      { severity: "error", code: "A11Y_BUTTON_TEXT", line: 6, column: 3 },
      { severity: "error", code: "A11Y_COLOR_ONLY", line: 7, column: 3 },
    ]);
  });

  test("a link whose text is its own optional href passes; buttons and badges stay strict", () => {
    const fields: Record<string, WidgetFieldSpec> = { site: { type: "url" }, rotulo: { type: "text" } };
    expect(
      lint(
        `<ravi-stack>
  <ravi-link href="{site}">{site}</ravi-link>
  <ravi-link href="{site}">{rotulo}</ravi-link>
  <ravi-link href="https://ravi.bot">{site}</ravi-link>
  <ravi-badge tone="info">{site}</ravi-badge>
  <ravi-button action="archive">{site}</ravi-button>
</ravi-stack>`,
        "default",
        fields,
      ),
    ).toEqual([
      { severity: "error", code: "A11Y_LINK_TEXT", line: 3, column: 3 },
      { severity: "error", code: "A11Y_LINK_TEXT", line: 4, column: 3 },
      { severity: "error", code: "A11Y_COLOR_ONLY", line: 5, column: 3 },
      { severity: "error", code: "A11Y_BUTTON_TEXT", line: 6, column: 3 },
    ]);
  });

  test("the message says why text that may be empty is refused", () => {
    const parsed = parseWidgetTemplate(`<ravi-button action="archive">{rotulo}</ravi-button>`);
    const [diagnostic] = lintTemplateAccessibility(parsed.variants[0]?.nodes ?? [], { variant: "default", fields: { rotulo: { type: "text" } } });
    expect(diagnostic?.message).toContain("An optional field or an {#if} without {:else} can leave it empty");
  });

  test("color is never the only signal", () => {
    expect(
      lint(`<ravi-stack>
  <ravi-badge color="red"></ravi-badge>
  <ravi-text tone="danger"> </ravi-text>
  <ravi-badge></ravi-badge>
  <ravi-text tone="danger">Atrasado</ravi-text>
</ravi-stack>`),
    ).toEqual([
      { severity: "error", code: "A11Y_COLOR_ONLY", line: 2, column: 3 },
      { severity: "error", code: "A11Y_COLOR_ONLY", line: 3, column: 3 },
    ]);
  });

  test("explicit heading levels never skip going down", () => {
    expect(
      lint(`<ravi-stack>
  <ravi-title level="2">a</ravi-title>
  <ravi-title level="3">b</ravi-title>
  <ravi-title level="2">c</ravi-title>
  <ravi-title>implicit</ravi-title>
  <ravi-title level="4">d</ravi-title>
</ravi-stack>`),
    ).toEqual([{ severity: "error", code: "A11Y_HEADING_SKIP", line: 6, column: 3 }]);
  });

  test("cards need a title; a nested card's title does not name the outer one; compact only warns", () => {
    const source = `<ravi-card>
  <ravi-card><ravi-title>inner</ravi-title></ravi-card>
</ravi-card>
<ravi-card>{#if a}<ravi-title>{a}</ravi-title>{/if}</ravi-card>`;
    expect(lint(source)).toEqual([{ severity: "error", code: "A11Y_CARD_TITLE", line: 1, column: 1 }]);
    expect(lint(source, "compact")).toEqual([{ severity: "warning", code: "A11Y_CARD_TITLE", line: 1, column: 1 }]);
  });
});
