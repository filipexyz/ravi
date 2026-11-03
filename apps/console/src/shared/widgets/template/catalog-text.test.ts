import { describe, expect, test } from "bun:test";

import { FIELD_ROLES, TEMPLATE_FILTERS, WIDGET_FIELD_TYPES } from "../types";
import { PIECE_NAMES, PIECES } from "./catalog";
import { catalogJson, catalogText, EXAMPLE_WIDGET_FILES, type CatalogWidget } from "./catalog-text";
import { compileWidget } from "./compile";

const PEDIDO: CatalogWidget = {
  ref: "org/pedido-card",
  name: "Cartão de pedido",
  description: "Pedido com status | cliente e valor.",
  fields: {
    titulo: { type: "text", required: true, label: "Pedido" },
    valor: { type: "number", role: "highlight", required: false, label: "Valor" },
  },
  variants: ["default", "compact"],
};

describe("catalog example", () => {
  test("the example widget folder compiles without diagnostics", () => {
    const result = compileWidget(EXAMPLE_WIDGET_FILES);
    expect(result.diagnostics).toEqual([]);
    expect(result.widget?.actions.map((action) => action.verb)).toEqual(["update"]);
    expect(result.example).toHaveLength(1);
  });
});

describe("catalogText", () => {
  const text = catalogText({ widgets: [PEDIDO], locale: "pt-BR" });

  test("covers every piece, attribute, filter, type and role", () => {
    for (const piece of PIECE_NAMES) {
      expect(text).toContain(`\`${piece}\``);
      for (const attr of Object.keys(PIECES[piece]?.attrs ?? {})) expect(text).toContain(`\`${attr}\``);
    }
    for (const filter of TEMPLATE_FILTERS) expect(text).toContain(`\`${filter}\``);
    for (const type of WIDGET_FIELD_TYPES) expect(text).toContain(`| ${type} |`);
    for (const role of FIELD_ROLES) expect(text).toContain(`| ${role} |`);
  });

  test("explains page tags, refs, the fields map, set and accessibility", () => {
    expect(text).toContain('<ravi-view view="<view-uuid>" layout="list" widget="pedido-card"></ravi-view>');
    expect(text).toContain("`org/<slug>`");
    expect(text).toContain('fields="widgetField:column,…"');
    expect(text).toContain("`@todo`, `@in_progress`, `@done`");
    expect(text).toContain("## Example widget folder");
    expect(text).toContain("### Accessibility (checked at publish)");
    expect(text).toContain("Write names, labels and button text in pt-BR.");
  });

  test("lists the org's widgets with their fields, escaping table cells", () => {
    expect(text).toContain("### `org/pedido-card`: Cartão de pedido");
    expect(text).toContain("| `titulo` | text |  | yes | Pedido |");
    expect(text).toContain("| `valor` | number | highlight | no | Valor |");
    expect(text).toContain("Pedido com status | cliente e valor.");
    expect(text).toContain("Variants: default, compact.");
    expect(catalogText({ widgets: [] })).toContain("None yet.");
  });

  test("table rows never break on a stray pipe", () => {
    for (const line of text.split("\n").filter((row) => row.startsWith("| `ravi-"))) {
      expect(line.replace(/\\\|/g, "").split("|").length).toBe(6);
    }
  });
});

describe("catalogJson", () => {
  test("serves the catalog as data, from the same sources", () => {
    const json = catalogJson({ widgets: [PEDIDO] });
    expect(json.text).toBe(catalogText({ widgets: [PEDIDO] }));
    expect(json.pieces.map((piece) => piece.name)).toEqual(PIECE_NAMES);
    expect(json.pieces.find((piece) => piece.name === "ravi-image")?.attrs.find((attr) => attr.name === "src")).toMatchObject({
      fields: ["url"],
      literal: "https-url",
      required: true,
    });
    expect(json.filters.map((filter) => filter.name)).toEqual([...TEMPLATE_FILTERS]);
    expect(json.fieldTypes.find((entry) => entry.type === "date")).toEqual({
      type: "date",
      columns: ["date", "created_time", "updated_time"],
      displays: ["date", "relative", "datetime"],
    });
    expect(json.fieldTypes.find((entry) => entry.type === "text")?.columns).toBe("any");
    expect(json.roles.find((entry) => entry.role === "avatar")).toEqual({ role: "avatar", types: ["url", "person"], displays: ["circle", "square"] });
    expect(json.tokens.length).toBeGreaterThan(0);
    expect(json.tokens[0]).toEqual(expect.objectContaining({ path: expect.any(String), cssVar: expect.stringMatching(/^--/) }));
    expect(json.widgets).toEqual([PEDIDO]);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });
});
