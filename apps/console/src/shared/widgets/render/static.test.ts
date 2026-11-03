import { describe, expect, test } from "bun:test";

import type { WidgetFieldSpec } from "../types";
import { formatValue } from "./format";
import { exampleFromTypes, normalizeStaticRecord, normalizeStaticRecords, staticRecordList } from "./static";
import { makeCtx, norm, orderWidget } from "./test-fixtures";
import { toHtml } from "./vnode";
import { renderWidget } from "./widget";

const FIELDS: Record<string, WidgetFieldSpec> = {
  titulo: { type: "text", required: true, label: "Pedido" },
  valor: { type: "number" },
  pago: { type: "checkbox" },
  prazo: { type: "date" },
  criado: { type: "date" },
  periodo: { type: "date" },
  etapa: { type: "select" },
  status: { type: "status" },
  tags: { type: "multi_select" },
  dono: { type: "person" },
  time: { type: "person" },
  site: { type: "url" },
  contato: { type: "email" },
  fone: { type: "phone" },
  pedido: { type: "ref" },
};

describe("normalizeStaticRecord", () => {
  test("friendly shapes become render values and columns", () => {
    const { record, columns, users, diagnostics } = normalizeStaticRecord(FIELDS, {
      titulo: "Pedido 1",
      valor: 1200,
      pago: true,
      prazo: "2026-10-20",
      criado: "2026-10-16T12:00:00-03:00",
      periodo: { start: "2026-10-01", end: "2026-10-31" },
      etapa: "Nova",
      status: { name: "Em produção", color: "orange", group: "in_progress" },
      tags: ["Urgente", { name: "VIP", color: "purple" }],
      dono: "Ana Souza",
      time: [{ name: "Bia Lima", avatarUrl: "https://example.test/bia.png" }, "Caio Reis"],
      site: "https://example.test",
      contato: "pessoa@example.test",
      fone: "(00) 0000-0000",
      pedido: { type: "order", id: 42 },
      extra: "ignored",
    });
    expect(diagnostics).toEqual([]);
    expect(record).toMatchObject({ id: null, version: null });
    expect(record.values).toEqual({
      titulo: "Pedido 1",
      valor: 1200,
      pago: true,
      prazo: { start: "2026-10-20", end: null },
      criado: { start: "2026-10-16T15:00:00.000Z", end: null },
      periodo: { start: "2026-10-01", end: "2026-10-31" },
      etapa: "Nova",
      status: "Em produção",
      tags: ["Urgente", "VIP"],
      dono: [{ id: "Ana Souza", displayName: "Ana Souza", avatarUrl: null }],
      time: [
        { id: "Bia Lima", displayName: "Bia Lima", avatarUrl: "https://example.test/bia.png" },
        { id: "Caio Reis", displayName: "Caio Reis", avatarUrl: null },
      ],
      site: "https://example.test",
      contato: "pessoa@example.test",
      fone: "(00) 0000-0000",
      pedido: [{ type: "order", id: "42" }],
    });
    expect(columns.titulo).toEqual({ key: "titulo", name: "Pedido", type: "text", config: {} });
    expect(columns.criado?.config.includeTime).toBe(true);
    expect(columns.prazo?.config.includeTime).toBeUndefined();
    expect(columns.status?.config.options).toEqual([{ id: "Em produção", name: "Em produção", color: "orange", group: "in_progress" }]);
    expect(columns.tags?.config.options?.map((option) => option.name)).toEqual(["Urgente", "VIP"]);
    expect(columns.tags?.config.options?.[1]?.color).toBe("purple");
    expect(Object.keys(users).sort()).toEqual(["Ana Souza", "Bia Lima", "Caio Reis"]);
  });

  test("status without a group or color gets one; select colors are stable by name", () => {
    const { columns } = normalizeStaticRecords(FIELDS, [{ status: "Pago" }, { status: "Pendente" }, { status: "Em análise" }, { etapa: "Nova" }]);
    expect(columns.status?.config.options).toEqual([
      { id: "Pago", name: "Pago", color: "green", group: "done" },
      { id: "Pendente", name: "Pendente", color: "gray", group: "todo" },
      { id: "Em análise", name: "Em análise", color: "blue", group: "in_progress" },
    ]);
    const again = normalizeStaticRecord(FIELDS, { etapa: "Nova" }).columns.etapa?.config.options?.[0]?.color;
    expect(columns.etapa?.config.options?.[0]?.color).toBe(again);
  });

  test("absent values are skipped; absent checkboxes are false", () => {
    const { record, diagnostics } = normalizeStaticRecord(FIELDS, { titulo: "x", valor: null });
    expect(diagnostics).toEqual([]);
    expect(record.values).toEqual({ titulo: "x", pago: false });
  });

  test("wrong types are errors and the value is dropped", () => {
    const { record, diagnostics } = normalizeStaticRecord(FIELDS, {
      titulo: 12,
      valor: "1200",
      pago: "sim",
      prazo: "20/10/2026",
      etapa: ["a", "b"],
      status: { color: "green" },
      tags: [{ name: "x", color: "teal" }],
      dono: 3,
      pedido: { type: "order" },
    });
    expect(record.values).toEqual({ tags: ["x"] });
    expect(diagnostics.every((diagnostic) => diagnostic.severity === "error" && diagnostic.code === "STATIC_VALUE_INVALID")).toBe(true);
    const messages = diagnostics.map((diagnostic) => diagnostic.message);
    expect(messages).toContain('Field "titulo" (text) expects a string.');
    expect(messages).toContain('Field "valor" (number) expects a number.');
    expect(messages).toContain('Field "pago" (checkbox) expects true or false.');
    expect(messages.some((message) => message.startsWith('Field "prazo" (date) expects a date'))).toBe(true);
    expect(messages).toContain('Field "etapa" (select) expects one option, not a list.');
    expect(messages.some((message) => message.includes('"color" to be one of'))).toBe(true);
    expect(messages.some((message) => message.startsWith('Field "pedido" (ref)'))).toBe(true);
  });

  test("non-object data is an error", () => {
    expect(normalizeStaticRecord(FIELDS, [1, 2]).diagnostics[0]?.code).toBe("STATIC_DATA_INVALID");
    expect(normalizeStaticRecord(FIELDS, "x").diagnostics[0]?.code).toBe("STATIC_DATA_INVALID");
  });

  test("several records share columns; at most 20", () => {
    const many = normalizeStaticRecords(FIELDS, Array.from({ length: 22 }, (_, index) => ({ titulo: `P${index}` })));
    expect(many.records).toHaveLength(20);
    expect(many.diagnostics[0]?.message).toBe("Static data holds at most 20 records.");
    const two = normalizeStaticRecords(FIELDS, [{ valor: "x" }, { valor: "y" }]);
    expect(two.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'Record 1: field "valor" (number) expects a number.',
      'Record 2: field "valor" (number) expects a number.',
    ]);
  });

  test("staticRecordList reads one record or { records }", () => {
    expect(staticRecordList({ a: 1 })).toEqual([{ a: 1 }]);
    expect(staticRecordList({ records: [{ a: 1 }, { a: 2 }] })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(staticRecordList(null)).toEqual([]);
  });

  test("normalized static data renders like Bases data", () => {
    const widget = orderWidget();
    const { records, columns, users } = normalizeStaticRecords(widget.fields, [
      { titulo: "Pedido 9", status: { name: "Entregue", color: "green", group: "done" }, cliente: "Loja", prazo: "2026-10-17", responsavel: "Ana Souza", valor: 990 },
    ]);
    const ctx = makeCtx({ columns, users, interactive: false, can: { write: new Set(), create: false, archive: false } });
    const html = norm(toHtml(renderWidget(widget, records[0]!, ctx)));
    expect(html).toContain('data-ravi-row=""');
    expect(html).toContain('<span class="ravi-pill ravi-option-green"><span class="ravi-dot" aria-hidden="true"></span>Entregue</span>');
    expect(html).toContain('Loja · <time datetime="2026-10-17">amanhã</time>');
    expect(html).toContain('<span class="ravi-person-name">Ana Souza</span>');
    expect(html).toContain('data-ravi-field="responsavel" data-ravi-value="Ana Souza"');
    expect(html).toContain("990");
  });
});

describe("exampleFromTypes", () => {
  test("obviously fake values for every type that normalize without errors", () => {
    const example = exampleFromTypes({ ...FIELDS, capa: { type: "url", role: "image" }, nota: { type: "number", role: "rating" } });
    const { diagnostics, record, columns } = normalizeStaticRecord({ ...FIELDS, capa: { type: "url", role: "image" }, nota: { type: "number", role: "rating" } }, example);
    expect(diagnostics).toEqual([]);
    expect(example.titulo).toBe("Pedido de exemplo");
    expect(example.contato).toBe("pessoa@example.test");
    expect(example.fone).toBe("(00) 0000-0000");
    expect(example.capa).toBe("https://example.test/imagem.png");
    expect(example.nota).toBe(4);
    expect(formatValue(columns.dono!, record.values.dono, makeCtx())).toBe("Pessoa Exemplo");
    for (const value of Object.values(example)) {
      const json = JSON.stringify(value);
      if (json.includes("@")) expect(json).toContain("@example.test");
      for (const url of json.match(/https?:\/\/[^"]+/g) ?? []) expect(new URL(url).hostname).toBe("example.test");
    }
    // Phones are all zeros: never a number that could ring someone.
    expect(String(example.fone).replace(/\D/g, "")).toMatch(/^0+$/);
  });

  test("en examples", () => {
    const example = exampleFromTypes({ titulo: { type: "text", label: "Order" }, dono: { type: "person" }, status: { type: "status" } }, { locale: "en" });
    expect(example).toEqual({
      titulo: "Example order",
      dono: { name: "Example Person" },
      status: { name: "In progress", color: "blue", group: "in_progress" },
    });
  });
});
