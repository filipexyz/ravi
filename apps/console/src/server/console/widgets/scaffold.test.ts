import { describe, expect, test } from "bun:test";

import { BASE_PROPERTY_TYPES, BASE_SYSTEM_COLUMNS } from "@/shared/bases/types";
import { normalizeStaticRecord } from "@/shared/widgets/render/static";
import { compileWidget } from "@/shared/widgets/template/compile";
import { parseWidgetManifest } from "@/shared/widgets/template/manifest";
import type { Diagnostic, LibraryFileText } from "@/shared/widgets/types";

import { SCAFFOLD_MAX_DETAIL_FIELDS, SCAFFOLD_MAX_ROW_FIELDS, scaffoldWidgetFiles, type ScaffoldColumn } from "./scaffold";

// The scaffold's files must always compile: every case below checks that the
// shared compiler reports no error and that example.json fits the fields.

const file = (files: LibraryFileText[], path: string) => files.find((entry) => entry.path === path)?.content ?? "";
const errors = (diagnostics: Diagnostic[]) => diagnostics.filter((diagnostic) => diagnostic.severity === "error");
const codes = (diagnostics: Diagnostic[]) => diagnostics.map((diagnostic) => diagnostic.code);

function expectCompiles(files: LibraryFileText[]) {
  expect(files.map((entry) => entry.path)).toEqual(["widget.html", "widget.json", "example.json"]);
  const result = compileWidget(files);
  expect(errors(result.diagnostics)).toEqual([]);
  expect(result.widget).not.toBeNull();
  const manifest = parseWidgetManifest(file(files, "widget.json")).manifest!;
  expect(errors(normalizeStaticRecord(manifest.fields, JSON.parse(file(files, "example.json"))).diagnostics)).toEqual([]);
  return { widget: result.widget!, manifest, html: file(files, "widget.html") };
}

const status = (key: string, groups: Array<"todo" | "in_progress" | "done"> = ["todo", "done"]): ScaffoldColumn => ({
  key,
  name: key,
  type: "status",
  config: { options: groups.map((group) => ({ id: group, name: group, color: "blue", group })) },
});

const ORDERS: ScaffoldColumn[] = [
  { key: "amount", name: "Amount", type: "number" },
  { key: "name", name: "Name", type: "text" },
  { key: "stage", name: "Stage", type: "select", config: { options: [{ id: "lead", name: "Lead", color: "blue" }] } },
  status("phase"),
  { key: "cover", name: "Cover", type: "url" },
  { key: "due", name: "Due", type: "date" },
  { key: "notes", name: "Notes", type: "text" },
  { key: "owner", name: "Owner", type: "person" },
  { key: "created_by", name: "Created by", type: "created_by" },
  { key: "body", name: "Body", type: "body" },
];

describe("widget scaffold", () => {
  test("the generic starter compiles in pt-BR and en, with a done button on its status", () => {
    const pt = scaffoldWidgetFiles({ slug: "pedido-card", view: null });
    expect(errors(pt.diagnostics)).toEqual([]);
    const ptWidget = expectCompiles(pt.files);
    expect(ptWidget.manifest).toMatchObject({ name: "Pedido card", variants: ["default"] });
    expect(Object.keys(ptWidget.manifest.fields)).toEqual(["titulo", "status", "responsavel", "prazo", "valor"]);
    expect(ptWidget.manifest.fields.titulo).toMatchObject({ type: "text", required: true, label: "Título" });
    expect(ptWidget.manifest.fields.valor).toMatchObject({ type: "number", role: "highlight" });
    expect(ptWidget.html).toContain('<ravi-button action="update" set="status=@done" variant="primary">Concluir</ravi-button>');
    expect(ptWidget.widget.actions).toHaveLength(1);

    const en = scaffoldWidgetFiles({ slug: "task", view: null, locale: "en-US" });
    const enWidget = expectCompiles(en.files);
    expect(Object.keys(enWidget.manifest.fields)).toEqual(["title", "status", "owner", "due", "amount"]);
    expect(enWidget.html).toContain(">Mark as done</ravi-button>");
    expect(JSON.parse(file(en.files, "example.json")).title).toBe("Example title");
  });

  test("from a view: first text column as title, cover image, status and select row, four labeled fields", () => {
    const { files, diagnostics } = scaffoldWidgetFiles({ slug: "orders-card", view: { name: "Open orders", columns: ORDERS }, locale: "en" });
    const { manifest, html } = expectCompiles(files);
    expect(Object.keys(manifest.fields)).toEqual(["name", "cover", "phase", "stage", "amount", "due", "notes", "owner"]);
    expect(manifest.fields.name).toEqual({ type: "text", required: true, label: "Name" });
    expect(manifest.fields.cover).toEqual({ type: "url", role: "image", required: false, label: "Cover" });
    expect(manifest.fields.amount).toEqual({ type: "number", role: "highlight", required: false, label: "Amount" });
    expect(manifest.fields.owner).toEqual({ type: "person", required: false, label: "Owner" });
    expect(manifest.description).toBe('Card for the "Open orders" view: Name, Cover, phase, Stage, Amount, Due, Notes, Owner.');
    expect(html).toContain("<ravi-title>{name}</ravi-title>");
    expect(html).toContain('<ravi-image src="{cover}" alt="decorative" ratio="16:9"></ravi-image>');
    expect(html.indexOf('name="phase"')).toBeLessThan(html.indexOf('name="stage"'));
    expect(html.match(/label="visible"/g)).toHaveLength(SCAFFOLD_MAX_DETAIL_FIELDS);
    expect(html).toContain('set="phase=@done"');
    expect(codes(diagnostics)).toEqual(["SCAFFOLD_COLUMN_SKIPPED", "SCAFFOLD_COLUMNS_LEFT_OUT"]);
    expect(diagnostics.find((diagnostic) => diagnostic.code === "SCAFFOLD_COLUMNS_LEFT_OUT")?.message).toContain("created_by");
  });

  test("the row holds at most three status and select fields, statuses first", () => {
    const columns: ScaffoldColumn[] = [
      { key: "title", name: "Title", type: "text" },
      { key: "kind", name: "Kind", type: "select" },
      { key: "size", name: "Size", type: "select" },
      status("phase"),
      status("review"),
    ];
    const { html } = expectCompiles(scaffoldWidgetFiles({ slug: "x", view: { name: "V", columns } }).files);
    const row = html.slice(html.indexOf("<ravi-row"), html.indexOf("</ravi-row>"));
    expect(row.match(/<ravi-field /g)).toHaveLength(SCAFFOLD_MAX_ROW_FIELDS);
    expect(row.indexOf('"phase"')).toBeLessThan(row.indexOf('"review"'));
    expect(row.indexOf('"review"')).toBeLessThan(row.indexOf('"kind"'));
    expect(row).not.toContain('"size"');
    // The leftover select is one of the labeled fields.
    expect(html).toContain('<ravi-field name="size" label="visible"></ravi-field>');
  });

  test("no button without a status column, or when the status has no done option", () => {
    const plain = scaffoldWidgetFiles({ slug: "x", view: { name: "V", columns: [{ key: "title", name: "Title", type: "text" }] } });
    expect(expectCompiles(plain.files).html).not.toContain("ravi-button");
    const noDone = scaffoldWidgetFiles({
      slug: "x",
      view: { name: "V", columns: [{ key: "title", name: "Title", type: "text" }, status("phase", ["todo", "in_progress"])] },
    });
    expect(expectCompiles(noDone.files).html).not.toContain("ravi-button");
  });

  test("a view without a text column titles the card with its first column", () => {
    const { files, diagnostics } = scaffoldWidgetFiles({
      slug: "x",
      view: { name: "V", columns: [{ key: "total", name: "Total", type: "number" }, { key: "due", name: "Due", type: "date" }] },
    });
    const { manifest, html } = expectCompiles(files);
    expect(html).toContain("<ravi-title>{total}</ravi-title>");
    expect(manifest.fields.total).toEqual({ type: "number", required: true, label: "Total" });
    expect(codes(diagnostics)).toContain("SCAFFOLD_NO_TEXT_COLUMN");
  });

  test("a view with nothing to show falls back to the starter, with a warning", () => {
    const { files, diagnostics } = scaffoldWidgetFiles({ slug: "x", view: { name: "V", columns: [{ key: "body", name: "Body", type: "body" }] } });
    expect(Object.keys(expectCompiles(files).manifest.fields)).toContain("titulo");
    expect(codes(diagnostics)).toEqual(["SCAFFOLD_COLUMN_SKIPPED", "SCAFFOLD_VIEW_EMPTY"]);
  });

  test("every column type maps to a field that compiles", () => {
    for (const type of [...BASE_PROPERTY_TYPES, ...BASE_SYSTEM_COLUMNS]) {
      if (type === "approval" || type === "agent") continue;
      const columns: ScaffoldColumn[] = [{ key: "title", name: "Title", type: "text" }, { key: `col_${type}`, name: `Col ${type}`, type }];
      const { manifest } = expectCompiles(scaffoldWidgetFiles({ slug: "x", view: { name: "V", columns } }).files);
      expect(Object.keys(manifest.fields)).toEqual(["title", `col_${type}`]);
    }
  });

  test("approval and agent columns have no widget field yet and are left out with a warning", () => {
    for (const type of ["approval", "agent"] as const) {
      const columns: ScaffoldColumn[] = [{ key: "title", name: "Title", type: "text" }, { key: `col_${type}`, name: `Col ${type}`, type }];
      const { files, diagnostics } = scaffoldWidgetFiles({ slug: "x", view: { name: "V", columns } });
      expect(Object.keys(expectCompiles(files).manifest.fields)).toEqual(["title"]);
      expect(codes(diagnostics)).toEqual(["SCAFFOLD_COLUMN_SKIPPED"]);
    }
  });

  test("keys that are not widget field keys become valid, unique ones; labels stay the column names", () => {
    const columns: ScaffoldColumn[] = [
      { key: "item", name: "Item", type: "text" },
      { key: "Preço Total", name: "Preço Total", type: "number" },
      { key: "1st", name: "1st", type: "text" },
      { key: "dup", name: "Dup", type: "text" },
      { key: "DUP", name: "dup", type: "date" },
      { key: `x${"a".repeat(80)}`, name: "Long\u0007 name\nhere", type: "text" },
    ];
    const { files } = scaffoldWidgetFiles({ slug: "x", view: { name: "V\u0000iew", columns } });
    const { manifest } = expectCompiles(files);
    const keys = Object.keys(manifest.fields);
    expect(keys.slice(0, 3)).toEqual(["item_2", "preco_total", "st"]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => /^[a-z][a-z0-9_]{0,62}$/.test(key))).toBe(true);
    expect(manifest.fields.preco_total?.label).toBe("Preço Total");
    expect(Object.values(manifest.fields).map((spec) => spec.label)).toContain("dup");
    expect(manifest.description).toContain('"V iew"');
  });
});
