// Starter files for `POST widgets/scaffold` (`ravi widgets init`): a small,
// accessible card built from a view's columns (described as the caller,
// schema only, never rows) or a generic starter. The card has a title (the
// first text column), a row with status and select fields, up to four more
// fields with visible labels, and a "done" button when there is a status
// column. The files always compile with the shared engine; people edit them
// from there.

import type { BasePropertyConfig } from "@/shared/bases/types";
import { normalizeColumnName } from "@/shared/widgets/matching";
import { messageLocale, type MessageLocale } from "@/shared/widgets/render/messages";
import { exampleFromTypes } from "@/shared/widgets/render/static";
import { compileWidget } from "@/shared/widgets/template/compile";
import {
  MAX_FIELD_LABEL_LENGTH,
  MAX_WIDGET_DESCRIPTION_LENGTH,
  MAX_WIDGET_NAME_LENGTH,
  RESERVED_FIELD_KEYS,
  WIDGET_FIELD_KEY_PATTERN,
} from "@/shared/widgets/template/manifest";
import {
  WIDGET_FIELD_TYPES,
  type Diagnostic,
  type LibraryFileText,
  type RenderColumnType,
  type WidgetFieldSpec,
  type WidgetFieldType,
} from "@/shared/widgets/types";

/** One view column as `describe` returns it (only what the scaffold reads). */
export type ScaffoldColumn = { key: string; name: string; type: RenderColumnType; config?: BasePropertyConfig };
export type ScaffoldView = { name: string; columns: readonly ScaffoldColumn[] };

/** Status and select fields shown side by side under the title. */
export const SCAFFOLD_MAX_ROW_FIELDS = 3;
/** Other fields shown with their labels. */
export const SCAFFOLD_MAX_DETAIL_FIELDS = 4;

const COVER_WORDS = /(?:^|_)(?:capa|cover|imagem|image|img|foto|photo|thumbnail|thumb|banner)(?:_|$)/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

const TEXT: Record<MessageLocale, { done: string; viewDescription: (view: string, labels: string) => string; starterDescription: string }> = {
  "pt-BR": {
    done: "Concluir",
    viewDescription: (view, labels) => `Cartão da visão "${view}": ${labels}.`,
    starterDescription: "Cartão inicial com título, status, responsável, prazo e valor.",
  },
  en: {
    done: "Mark as done",
    viewDescription: (view, labels) => `Card for the "${view}" view: ${labels}.`,
    starterDescription: "Starter card with title, status, owner, due date and amount.",
  },
};

/** The generic starter's columns, as a view would describe them. */
function starterColumns(locale: MessageLocale): ScaffoldColumn[] {
  const pt = locale === "pt-BR";
  const status = (name: string, group: "todo" | "in_progress" | "done", color: "gray" | "blue" | "green") => ({ id: name, name, color, group });
  return [
    { key: pt ? "titulo" : "title", name: pt ? "Título" : "Title", type: "text" },
    {
      key: "status",
      name: "Status",
      type: "status",
      config: {
        options: pt
          ? [status("A fazer", "todo", "gray"), status("Em andamento", "in_progress", "blue"), status("Concluído", "done", "green")]
          : [status("To do", "todo", "gray"), status("In progress", "in_progress", "blue"), status("Done", "done", "green")],
      },
    },
    { key: pt ? "responsavel" : "owner", name: pt ? "Responsável" : "Owner", type: "person" },
    { key: pt ? "prazo" : "due", name: pt ? "Prazo" : "Due date", type: "date" },
    { key: pt ? "valor" : "amount", name: pt ? "Valor" : "Amount", type: "number" },
  ];
}

/** The widget field type a column maps to, or null (the markdown body). */
export function scaffoldFieldType(type: RenderColumnType): WidgetFieldType | null {
  if ((WIDGET_FIELD_TYPES as readonly string[]).includes(type)) return type as WidgetFieldType;
  if (type === "created_time" || type === "updated_time") return "date";
  if (type === "created_by" || type === "updated_by") return "person";
  return null;
}

function cleanText(text: string, max: number) {
  return text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function asFieldKey(text: string) {
  return normalizeColumnName(text)
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 63);
}

function isUsableKey(key: string, used: ReadonlySet<string>) {
  return WIDGET_FIELD_KEY_PATTERN.test(key) && !RESERVED_FIELD_KEYS.includes(key) && !used.has(key);
}

/**
 * The column key when it is a valid widget field key, else one derived from
 * it or the name (`item_2` for a reserved or taken `item`, `field_<n>` when
 * nothing usable is left).
 */
function fieldKeyFor(column: ScaffoldColumn, used: Set<string>) {
  const candidates = [column.key, asFieldKey(column.key), asFieldKey(column.name)];
  let key = candidates.find((candidate) => isUsableKey(candidate, used));
  const base = (candidates.find((candidate) => WIDGET_FIELD_KEY_PATTERN.test(candidate)) ?? "field").slice(0, 56);
  for (let n = 2; !key; n += 1) {
    if (isUsableKey(`${base}_${n}`, used)) key = `${base}_${n}`;
  }
  used.add(key);
  return key;
}

function slugName(slug: string) {
  const words = slug.replace(/-+/g, " ").trim();
  return cleanText(words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}` : slug, MAX_WIDGET_NAME_LENGTH) || "Widget";
}

function hasDoneOption(column: ScaffoldColumn) {
  const options = column.config?.options;
  return !options || options.length === 0 || options.some((option) => option.group === "done");
}

type Placed = { column: ScaffoldColumn; key: string; type: WidgetFieldType };

/**
 * `widget.html`, `widget.json` and `example.json` for `slug`. With a view,
 * fields come from its columns (key, type, label; `image` for an obvious
 * cover url, `highlight` for the first number); without one, a generic
 * starter. `diagnostics` are notes on what was left out plus the compile
 * diagnostics of the files, which never include an error.
 */
export function scaffoldWidgetFiles(input: { slug: string; view: ScaffoldView | null; locale?: string | null }): {
  files: LibraryFileText[];
  diagnostics: Diagnostic[];
} {
  const locale = messageLocale(input.locale ?? "pt-BR");
  const text = TEXT[locale];
  const notes: Diagnostic[] = [];
  const note = (code: string, message: string) => notes.push({ severity: "warning", code, message, file: "widget.json" });

  let columns: ScaffoldColumn[] = [];
  if (input.view) {
    for (const column of input.view.columns) {
      if (scaffoldFieldType(column.type)) columns.push(column);
      else note("SCAFFOLD_COLUMN_SKIPPED", `Column ${column.key} (${column.type}) has no widget field type and is left out.`);
    }
    if (columns.length === 0) {
      note("SCAFFOLD_VIEW_EMPTY", "The view has no column a widget can show; these are the generic starter files.");
    }
  }
  const fromView = Boolean(input.view) && columns.length > 0;
  if (!fromView) columns = starterColumns(locale);

  const typed = columns.map((column) => ({ column, type: scaffoldFieldType(column.type) as WidgetFieldType }));
  const titleIndex = Math.max(
    0,
    typed.findIndex((entry) => entry.type === "text"),
  );
  if (fromView && typed[titleIndex]?.type !== "text") {
    note("SCAFFOLD_NO_TEXT_COLUMN", `The view has no text column; the card title shows ${typed[titleIndex]?.column.key}.`);
  }
  const coverIndex = typed.findIndex(
    (entry, index) =>
      index !== titleIndex && entry.type === "url" && (COVER_WORDS.test(normalizeColumnName(entry.column.key)) || COVER_WORDS.test(normalizeColumnName(entry.column.name))),
  );
  const rest = typed.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.index !== titleIndex && entry.index !== coverIndex);
  const rowEntries = [...rest.filter((entry) => entry.type === "status"), ...rest.filter((entry) => entry.type === "select")].slice(
    0,
    SCAFFOLD_MAX_ROW_FIELDS,
  );
  const inRow = new Set(rowEntries.map((entry) => entry.index));
  const detailEntries = rest.filter((entry) => !inRow.has(entry.index)).slice(0, SCAFFOLD_MAX_DETAIL_FIELDS);
  const shown = 1 + (coverIndex >= 0 ? 1 : 0) + rowEntries.length + detailEntries.length;
  if (fromView && shown < typed.length) {
    const left = rest.filter((entry) => !inRow.has(entry.index) && !detailEntries.includes(entry)).map((entry) => entry.column.key);
    note(
      "SCAFFOLD_COLUMNS_LEFT_OUT",
      `The card shows ${shown} of ${typed.length} columns; add the others to widget.json and widget.html when needed: ${left.join(", ")}.`,
    );
  }

  // Keys in the order the card shows them.
  const used = new Set<string>();
  const place = (entry: { column: ScaffoldColumn; type: WidgetFieldType }): Placed => ({ ...entry, key: fieldKeyFor(entry.column, used) });
  const title = place(typed[titleIndex]!);
  const cover = coverIndex >= 0 ? place(typed[coverIndex]!) : null;
  const row = rowEntries.map(place);
  const details = detailEntries.map(place);
  const highlight = [...row, ...details].find((entry) => entry.type === "number") ?? null;

  const fields: Record<string, WidgetFieldSpec> = {};
  const addField = (entry: Placed, extra: Partial<WidgetFieldSpec> = {}) => {
    const label = cleanText(entry.column.name, MAX_FIELD_LABEL_LENGTH);
    fields[entry.key] = { type: entry.type, ...extra, ...(label ? { label } : {}) };
  };
  addField(title, { required: true });
  if (cover) addField(cover, { role: "image" });
  for (const entry of [...row, ...details]) addField(entry, entry === highlight ? { role: "highlight" } : {});

  const status = row.find((entry) => entry.type === "status" && hasDoneOption(entry.column)) ?? null;

  const html = ["<ravi-card>"];
  if (cover) {
    html.push(`  {#if ${cover.key}}`, `    <ravi-image src="{${cover.key}}" alt="decorative" ratio="16:9"></ravi-image>`, "  {/if}");
  }
  html.push(`  <ravi-title>{${title.key}}</ravi-title>`);
  if (row.length) {
    html.push('  <ravi-row gap="sm" align="center" wrap="true">', ...row.map((entry) => `    <ravi-field name="${entry.key}"></ravi-field>`), "  </ravi-row>");
  }
  if (details.length) {
    html.push('  <ravi-stack gap="xs">', ...details.map((entry) => `    <ravi-field name="${entry.key}" label="visible"></ravi-field>`), "  </ravi-stack>");
  }
  if (status) html.push(`  <ravi-button action="update" set="${status.key}=@done" variant="primary">${text.done}</ravi-button>`);
  html.push("</ravi-card>", "");

  const labels = Object.entries(fields).map(([key, spec]) => spec.label ?? key);
  const viewName = input.view ? cleanText(input.view.name, 200) : "";
  const description = cleanText(
    fromView && viewName ? text.viewDescription(viewName, labels.join(", ")) : text.starterDescription,
    MAX_WIDGET_DESCRIPTION_LENGTH,
  );
  const manifest = { name: slugName(input.slug), description, fields, variants: ["default"] };

  const files: LibraryFileText[] = [
    { path: "widget.html", content: html.join("\n") },
    { path: "widget.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "example.json", content: `${JSON.stringify(exampleFromTypes(fields, { locale }), null, 2)}\n` },
  ];
  return { files, diagnostics: [...notes, ...compileWidget(files).diagnostics] };
}
