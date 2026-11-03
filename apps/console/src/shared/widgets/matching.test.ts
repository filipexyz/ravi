import { describe, expect, test } from "bun:test";

import { isCompatibleColumn, matchFields, normalizeColumnName, parseFieldsAttribute } from "./matching";
import type { RenderColumn, RenderColumnType, WidgetFieldSpec } from "./types";

const column = (key: string, type: RenderColumnType, name: string = key): RenderColumn => ({ key, name, type, config: {} });

const summary = (result: ReturnType<typeof matchFields>) => ({
  mapping: result.mapping,
  diagnostics: result.diagnostics.map((d) => [d.severity, d.code]),
});

describe("isCompatibleColumn", () => {
  test("the compatibility table", () => {
    const table: Array<[WidgetFieldSpec["type"], RenderColumnType[], RenderColumnType[]]> = [
      ["text", ["text", "number", "status", "person", "created_time", "body", "ref"], []],
      ["number", ["number"], ["text", "checkbox"]],
      ["checkbox", ["checkbox"], ["text"]],
      ["date", ["date", "created_time", "updated_time"], ["text", "created_by"]],
      ["select", ["select", "status"], ["multi_select", "text"]],
      ["status", ["status"], ["select"]],
      ["multi_select", ["multi_select"], ["select"]],
      ["url", ["url"], ["text", "email"]],
      ["email", ["email"], ["text"]],
      ["phone", ["phone"], ["text"]],
      ["person", ["person", "created_by", "updated_by"], ["text"]],
      ["ref", ["ref"], ["text"]],
    ];
    for (const [fieldType, compatible, incompatible] of table) {
      for (const columnType of compatible) expect([fieldType, columnType, isCompatibleColumn(fieldType, columnType)]).toEqual([fieldType, columnType, true]);
      for (const columnType of incompatible) expect([fieldType, columnType, isCompatibleColumn(fieldType, columnType)]).toEqual([fieldType, columnType, false]);
    }
  });
});

describe("matchFields", () => {
  test("precedence: explicit, same key, name or label, the only unused column of the type", () => {
    const fields: Record<string, WidgetFieldSpec> = {
      titulo: { type: "text", required: true, label: "Pedido" },
      status: { type: "status" },
      responsavel: { type: "person", label: "Responsável" },
      valor: { type: "number" },
      prazo: { type: "date" },
    };
    const columns = [
      column("nome_cliente", "text", "Nome do cliente"),
      column("pedido", "text", "Pedido"),
      column("status", "status"),
      column("dono", "person", "Responsável"),
      column("total", "number", "Total"),
      column("entrega", "date", "Entrega"),
      column("created_time", "created_time", "Criado em"),
    ];
    expect(summary(matchFields({ fields, columns, explicit: { titulo: "nome_cliente" } }))).toEqual({
      mapping: { titulo: "nome_cliente", status: "status", responsavel: "dono", valor: "total", prazo: "entrega" },
      diagnostics: [],
    });
    // Without the explicit map, the label "Pedido" finds the "Pedido" column.
    expect(matchFields({ fields, columns }).mapping.titulo).toBe("pedido");
  });

  test("same key needs a compatible type, then falls through", () => {
    const fields: Record<string, WidgetFieldSpec> = { valor: { type: "number", required: true } };
    expect(summary(matchFields({ fields, columns: [column("valor", "text"), column("total", "number")] }))).toEqual({
      mapping: { valor: "total" },
      diagnostics: [],
    });
  });

  test("names match lowercased, without accents and with spaces as _", () => {
    expect(normalizeColumnName("  Responsável  Técnico ")).toBe("responsavel_tecnico");
    const fields: Record<string, WidgetFieldSpec> = {
      responsavel_tecnico: { type: "person" },
      data_entrega: { type: "date", label: "Data de Entrega" },
    };
    const columns = [
      column("p1", "person", "Responsável Técnico"),
      column("p2", "person", "Outro"),
      column("d1", "date", "Data de entrega"),
      column("d2", "date", "Criado"),
    ];
    expect(matchFields({ fields, columns }).mapping).toEqual({ responsavel_tecnico: "p1", data_entrega: "d1" });
  });

  test("the type fallback needs exactly one unused column of the exact type", () => {
    const fields: Record<string, WidgetFieldSpec> = { quando: { type: "date" }, outro: { type: "date" } };
    // created_time is compatible with date but not the same exact type.
    expect(matchFields({ fields, columns: [column("criado", "created_time")] }).mapping).toEqual({});
    expect(matchFields({ fields, columns: [column("a", "date"), column("b", "date")] }).mapping).toEqual({});
    expect(matchFields({ fields: { quando: { type: "date" } }, columns: [column("a", "date")] }).mapping).toEqual({ quando: "a" });
    // A column already taken by an earlier rule is not unused.
    expect(
      matchFields({ fields: { quando: { type: "date" }, entrega: { type: "date" } }, columns: [column("entrega", "date"), column("x", "text")] }).mapping,
    ).toEqual({ entrega: "entrega" });
  });

  test("required fields without a match are errors, optional ones warnings; diagnostics list candidates", () => {
    const result = matchFields({
      fields: { titulo: { type: "text", required: true }, valor: { type: "number" }, capa: { type: "url" } },
      columns: [column("a", "text"), column("b", "text"), column("total", "number"), column("n2", "number")],
    });
    expect(summary(result)).toEqual({
      mapping: {},
      diagnostics: [
        ["error", "WIDGET_FIELD_MISSING"],
        ["warning", "WIDGET_FIELD_MISSING"],
        ["warning", "WIDGET_FIELD_MISSING"],
      ],
    });
    expect(result.diagnostics[0]?.message).toContain("Candidates: a: text, b: text, total: number, n2: number.");
    expect(result.diagnostics[1]?.message).toContain("Candidates: total: number, n2: number.");
    expect(result.diagnostics[2]?.message).toContain("The view has no column a url field accepts.");
  });

  test("explicit mappings to missing or incompatible columns are errors, without fallback", () => {
    const fields: Record<string, WidgetFieldSpec> = { valor: { type: "number" }, prazo: { type: "date" } };
    const columns = [column("valor", "number"), column("prazo", "date"), column("nome", "text")];
    expect(summary(matchFields({ fields, columns, explicit: { valor: "totl", prazo: "nome", extra: "nome" } }))).toEqual({
      mapping: {},
      diagnostics: [
        ["error", "WIDGET_FIELD_UNKNOWN"],
        ["error", "WIDGET_FIELD_COLUMN_MISSING"],
        ["error", "WIDGET_FIELD_INCOMPATIBLE"],
      ],
    });
  });
});

describe("parseFieldsAttribute", () => {
  test("pairs with spaces", () => {
    expect(parseFieldsAttribute("titulo:cliente_nome, valor : total")).toEqual({
      map: { titulo: "cliente_nome", valor: "total" },
      diagnostics: [],
    });
    expect(parseFieldsAttribute("  ")).toEqual({ map: {}, diagnostics: [] });
  });

  test("syntax and duplicates", () => {
    const codes = (text: string) => parseFieldsAttribute(text).diagnostics.map((d) => d.code);
    expect(codes("titulo")).toEqual(["FIELDS_ATTRIBUTE_SYNTAX"]);
    expect(codes("titulo:,valor:total")).toEqual(["FIELDS_ATTRIBUTE_SYNTAX"]);
    expect(codes("a:b,,c:d")).toEqual(["FIELDS_ATTRIBUTE_SYNTAX"]);
    expect(codes("Titulo:nome")).toEqual(["FIELDS_ATTRIBUTE_SYNTAX"]);
    expect(codes("a:b,a:c")).toEqual(["FIELDS_ATTRIBUTE_DUPLICATE"]);
    expect(parseFieldsAttribute("a:b,a:c").map).toEqual({ a: "b" });
  });
});
