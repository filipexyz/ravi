import { describe, expect, test } from "bun:test";

import { humanizeFieldKey, MAX_WIDGET_FIELDS, parseWidgetManifest } from "./manifest";

const codes = (text: string | undefined) => parseWidgetManifest(text).diagnostics.map((d) => [d.code, d.line]);

describe("parseWidgetManifest", () => {
  test("the contract example parses and normalizes labels and required", () => {
    const { manifest, diagnostics } = parseWidgetManifest(`{
  "name": "Cartão de pedido",
  "description": "Pedido com status, cliente, prazo, responsável e valor.",
  "fields": {
    "titulo": { "type": "text", "required": true, "label": "Pedido" },
    "status": { "type": "status" },
    "responsavel_tecnico": { "type": "person", "description": "Quem atende" },
    "valor": { "type": "number", "role": "highlight" },
    "capa": { "type": "url", "role": "image" }
  },
  "variants": ["default", "compact"]
}`);
    expect(diagnostics).toEqual([]);
    expect(manifest).toEqual({
      name: "Cartão de pedido",
      description: "Pedido com status, cliente, prazo, responsável e valor.",
      fields: {
        titulo: { type: "text", required: true, label: "Pedido" },
        status: { type: "status", required: false, label: "Status" },
        responsavel_tecnico: { type: "person", required: false, label: "Responsavel tecnico", description: "Quem atende" },
        valor: { type: "number", role: "highlight", required: false, label: "Valor" },
        capa: { type: "url", role: "image", required: false, label: "Capa" },
      },
      variants: ["default", "compact"],
    });
  });

  test("variants default to [default]", () => {
    expect(parseWidgetManifest('{"name":"A","description":"B","fields":{}}').manifest?.variants).toEqual(["default"]);
  });

  test("missing file and invalid JSON report the position", () => {
    expect(parseWidgetManifest(undefined).diagnostics).toEqual([
      expect.objectContaining({ code: "WIDGET_FILE_MISSING", file: "widget.json", severity: "error" }),
    ]);
    expect(parseWidgetManifest('{\n  "name": "A",\n  "fields": {,}\n}').diagnostics).toEqual([
      expect.objectContaining({ code: "MANIFEST_JSON", line: 3, column: 14 }),
    ]);
    expect(codes("[]")).toEqual([["MANIFEST_SHAPE", 1]]);
  });

  test("unknown keys are errors, at the key's line", () => {
    expect(
      codes(`{
  "name": "A",
  "description": "B",
  "fields": { "x": { "type": "text", "labl": "X" } },
  "actions": []
}`),
    ).toEqual([
      ["MANIFEST_UNKNOWN_KEY", 5],
      ["MANIFEST_UNKNOWN_KEY", 4],
    ]);
  });

  test("key diagnostics carry the key's column", () => {
    expect(parseWidgetManifest('{"name":"A","description":"B",\n  "fields": { "x": { "type": "money" } }}').diagnostics).toEqual([
      expect.objectContaining({ code: "MANIFEST_FIELD_TYPE", line: 2, column: 22 }),
    ]);
  });

  test("name, description and fields are required and bounded", () => {
    expect(codes("{}")).toEqual([
      ["MANIFEST_NAME", 1],
      ["MANIFEST_DESCRIPTION", 1],
      ["MANIFEST_FIELDS", 1],
    ]);
    expect(codes(JSON.stringify({ name: "x".repeat(121), description: " ", fields: [] }, null, 1))).toEqual([
      ["MANIFEST_NAME", 2],
      ["MANIFEST_DESCRIPTION", 3],
      ["MANIFEST_FIELDS", 4],
    ]);
    expect(codes(JSON.stringify({ name: "A\nB", description: "x".repeat(1025), fields: {} }))).toEqual([
      ["MANIFEST_NAME", 1],
      ["MANIFEST_DESCRIPTION", 1],
    ]);
  });

  test("field keys, count, types and roles", () => {
    const fields = Object.fromEntries(Array.from({ length: MAX_WIDGET_FIELDS + 1 }, (_, i) => [`f${i}`, { type: "text" }]));
    expect(codes(JSON.stringify({ name: "A", description: "B", fields }))).toEqual([["MANIFEST_TOO_MANY_FIELDS", 1]]);
    expect(
      codes(`{"name":"A","description":"B","fields":{
  "Titulo": { "type": "text" },
  "item": { "type": "text" },
  "a": "text",
  "b": { "type": "money" },
  "c": { "type": "text", "role": "image" },
  "d": { "type": "url", "role": "hero" },
  "e": { "type": "number", "required": "yes" },
  "f": { "type": "text", "label": "${"x".repeat(81)}" },
  "g": { "type": "text", "description": "${"x".repeat(201)}" },
  "h": { "role": "progress" }
}}`),
    ).toEqual([
      ["MANIFEST_FIELD_KEY", 2],
      ["MANIFEST_FIELD_KEY", 3],
      ["MANIFEST_FIELD_SHAPE", 4],
      ["MANIFEST_FIELD_TYPE", 5],
      ["MANIFEST_FIELD_ROLE", 6],
      ["MANIFEST_FIELD_ROLE", 7],
      ["MANIFEST_FIELD_REQUIRED", 8],
      ["MANIFEST_FIELD_LABEL", 9],
      ["MANIFEST_FIELD_DESCRIPTION", 10],
      ["MANIFEST_FIELD_TYPE", 11],
    ]);
  });

  test("every role accepts exactly the types of FIELD_ROLE_TYPES", () => {
    const ok = (type: string, role: string) =>
      parseWidgetManifest(JSON.stringify({ name: "A", description: "B", fields: { x: { type, role } } })).diagnostics.length === 0;
    expect(ok("person", "avatar")).toBe(true);
    expect(ok("url", "avatar")).toBe(true);
    expect(ok("number", "rating")).toBe(true);
    expect(ok("text", "highlight")).toBe(false);
    expect(ok("date", "progress")).toBe(false);
  });

  test("variants: a subset that includes default", () => {
    const variants = (value: unknown) => codes(JSON.stringify({ name: "A", description: "B", fields: {}, variants: value }));
    expect(variants(["default", "compact", "detail"])).toEqual([]);
    expect(variants(["compact"])).toEqual([["MANIFEST_VARIANTS", 1]]);
    expect(variants(["default", "wide"])).toEqual([["MANIFEST_VARIANTS", 1]]);
    expect(variants(["default", "default"])).toEqual([["MANIFEST_VARIANTS", 1]]);
    expect(variants([])).toEqual([["MANIFEST_VARIANTS", 1]]);
    expect(variants("default")).toEqual([["MANIFEST_VARIANTS", 1]]);
  });

  test("humanizeFieldKey", () => {
    expect(humanizeFieldKey("data_de_entrega")).toBe("Data de entrega");
    expect(humanizeFieldKey("valor")).toBe("Valor");
  });
});
