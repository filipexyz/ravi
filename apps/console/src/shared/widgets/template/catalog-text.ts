// The widget catalog agents read (`GET widgets/catalog`, `ravi widgets
// catalog`): how to put a widget in a page, the org's widgets with their
// fields, and everything needed to write a new one. Generated from the piece
// catalog and the shared types so it never drifts; the OSS prints it as is.

import { compatibleColumnTypes } from "../matching";
import {
  allDisplays,
  displaysForField,
  EACH_FIELD_TYPES,
  FILTERS,
  ITEM_PROPERTIES,
  MAX_BLOCK_DEPTH,
  PIECE_NAMES,
  PIECES,
  type AttrSpec,
  type FilterSpec,
  type PieceSpec,
} from "./catalog";
import {
  MAX_FIELD_DESCRIPTION_LENGTH,
  MAX_FIELD_LABEL_LENGTH,
  MAX_WIDGET_DESCRIPTION_LENGTH,
  MAX_WIDGET_FIELDS,
  MAX_WIDGET_NAME_LENGTH,
} from "./manifest";
import { THEME_TOKENS, type ThemeTokenSpec } from "../theme/tokens";
import {
  FIELD_ROLE_DISPLAYS,
  FIELD_ROLE_TYPES,
  FIELD_ROLES,
  FIELD_TYPE_DISPLAYS,
  TEMPLATE_FILTERS,
  WIDGET_FIELD_TYPES,
  type FieldRole,
  type LibraryFileText,
  type RenderColumnType,
  type TemplateFilter,
  type WidgetFieldSpec,
  type WidgetFieldType,
  type WidgetVariant,
} from "../types";

export type CatalogWidget = {
  ref: string;
  name: string;
  description: string;
  fields: Record<string, WidgetFieldSpec>;
  variants: WidgetVariant[];
  /** True when the current version has `widget.js` ("com código"). */
  script?: boolean;
};

export type CatalogInput = {
  widgets: CatalogWidget[];
  /** Theme locale: the language for labels and button text. */
  locale?: string;
};

export type WidgetCatalogJson = {
  text: string;
  pieces: Array<Omit<PieceSpec, "attrs"> & { name: string; attrs: Array<AttrSpec & { name: string }> }>;
  filters: Array<FilterSpec & { name: TemplateFilter }>;
  fieldTypes: Array<{ type: WidgetFieldType; columns: readonly RenderColumnType[] | "any"; displays: string[] }>;
  roles: Array<{ role: FieldRole; types: readonly WidgetFieldType[]; displays: readonly string[] }>;
  displays: { types: typeof FIELD_TYPE_DISPLAYS; roles: typeof FIELD_ROLE_DISPLAYS; all: string[] };
  tokens: ThemeTokenSpec[];
  widgets: CatalogWidget[];
};

/** A complete widget folder: the catalog's example, the scaffold's model, and a compiler test. */
export const EXAMPLE_WIDGET_FILES: readonly LibraryFileText[] = [
  {
    path: "widget.json",
    content: `{
  "name": "Cartão de pedido",
  "description": "Pedido com status, cliente, prazo, responsável, etiquetas e valor.",
  "fields": {
    "titulo": { "type": "text", "required": true, "label": "Pedido" },
    "status": { "type": "status" },
    "cliente": { "type": "text" },
    "prazo": { "type": "date" },
    "responsavel": { "type": "person", "label": "Responsável" },
    "etiquetas": { "type": "multi_select" },
    "valor": { "type": "number", "role": "highlight" },
    "capa": { "type": "url", "role": "image" }
  },
  "variants": ["default", "compact"]
}
`,
  },
  {
    path: "widget.html",
    content: `<ravi-variant name="default">
  <ravi-card>
    {#if capa}
      <ravi-image src="{capa}" alt="decorative" ratio="16:9"></ravi-image>
    {/if}
    <ravi-row justify="between" align="center">
      <ravi-title>{titulo}</ravi-title>
      <ravi-field name="status"></ravi-field>
    </ravi-row>
    <ravi-text tone="secondary">{cliente} · {prazo | relative}</ravi-text>
    {#if etiquetas}
      <ravi-row gap="xs" wrap>
        {#each etiquetas as item}
          <ravi-badge>{item.name}</ravi-badge>
        {/each}
      </ravi-row>
    {/if}
    <ravi-row justify="between" align="center">
      <ravi-field name="responsavel"></ravi-field>
      <ravi-field name="valor" label="visible"></ravi-field>
    </ravi-row>
    <ravi-button action="update" set="status=@done" variant="primary">Concluir</ravi-button>
  </ravi-card>
</ravi-variant>
<ravi-variant name="compact">
  <ravi-card tone="subtle">
    <ravi-row justify="between" align="center">
      <ravi-title size="sm">{titulo}</ravi-title>
      <ravi-field name="status"></ravi-field>
    </ravi-row>
    <ravi-text size="sm" tone="secondary">{valor | currency}</ravi-text>
  </ravi-card>
</ravi-variant>
`,
  },
  {
    path: "example.json",
    content: `{
  "titulo": "Pedido 1042",
  "status": "Em andamento",
  "cliente": "Padaria Aurora",
  "prazo": "2026-10-20",
  "responsavel": "Ana Souza",
  "etiquetas": ["Urgente", "Atacado"],
  "valor": 1890.5,
  "capa": "https://example.com/pedido-1042.jpg"
}
`,
  },
];

export function catalogText(input: CatalogInput): string {
  const locale = input.locale ?? "pt-BR";
  const lines: string[] = [];
  const push = (...more: string[]) => lines.push(...more);

  push(
    "# Widget catalog",
    "",
    "A widget is a card or block the organization keeps in its Library: a template of the closed `ravi-*` pieces below plus typed fields, rendered by the page runtime with the org theme. The template is data; a widget may also carry `widget.js`, code an organization admin published that draws on top of the template (marked \"com código\" below). Reuse a widget before writing one; without a widget the runtime draws a default card with typed fields.",
    "",
    "## Use a widget in a page",
    "",
    "```html",
    '<ravi-view view="<view-uuid>" layout="list" widget="pedido-card"></ravi-view>',
    '<ravi-view view="<view-uuid>" layout="board" widget="org/pedido-card" fields="titulo:nome_cliente,valor:total" variant="compact"></ravi-view>',
    '<ravi-widget use="kpi-mes" data=\'{"valor": 1200}\'></ravi-widget>',
    "```",
    "",
    "- Close every tag (`</ravi-view>`); never `/>`.",
    "- A ref is `slug` (the project's widget, else the org's), `org/<slug>` or `<project>/<slug>`.",
    "- Without `widget`, the view's default widget applies (`ravi bases views bind`), else the default card.",
    "- `ravi pages ship` checks the fields against the view, pins the widget version (a newer version needs a new ship) and adds the runtime and theme.",
    "- Fields match view columns in this order: the `fields=\"widgetField:column,…\"` map; a compatible column with the same key; a compatible column whose name, lowercased without accents and with spaces as `_`, equals the field key or label; the only unused column of exactly the field's type. A required field without a match fails the ship (exit 2); an optional one renders empty.",
    "- `variant` picks one of the variants the widget lists (default `default`).",
    "- `data` on `<ravi-widget>` is static JSON, the same for every visitor: numbers the operator chose to publish, never rows of a view.",
    "",
  );

  push("## Organization widgets", "");
  if (input.widgets.length === 0) {
    push("None yet. Write one only when the person asks or the same card repeats across pages (see below).", "");
  }
  for (const widget of input.widgets) {
    push(`### \`${widget.ref}\`: ${oneLine(widget.name)}${widget.script ? " (com código)" : ""}`, "", oneLine(widget.description), "");
    push("| Field | Type | Role | Required | Label |", "| --- | --- | --- | --- | --- |");
    for (const [key, field] of Object.entries(widget.fields)) {
      push(`| \`${key}\` | ${field.type} | ${field.role ?? ""} | ${field.required ? "yes" : "no"} | ${cell(field.label ?? "")} |`);
    }
    push("", `Variants: ${widget.variants.join(", ")}.`, "");
  }

  push(
    "## Write a widget",
    "",
    "A widget is a folder: `widget.json` (required), `widget.html` (required), `example.json` (optional invented data for previews), `widget.js` (optional code, see below) and `README.md` (optional).",
    "",
    "```sh",
    "ravi widgets init <dir> [--from-view <view-uuid>]   # scaffold; --from-view reads the view's schema, never rows",
    "ravi widgets check <dir>                             # compile and list diagnostics",
    "ravi widgets preview <dir> --out preview.html        # every variant, light and dark",
    "ravi widgets propose <dir> --execute                 # a person publishes",
    "```",
    "",
    `Write names, labels and button text in ${locale}. Every diagnostic names the file, line and column and says what to change.`,
    "",
    "### widget.json",
    "",
    `- \`name\` (≤ ${MAX_WIDGET_NAME_LENGTH} characters) and \`description\` (≤ ${MAX_WIDGET_DESCRIPTION_LENGTH}; agents search it).`,
    `- \`fields\`: at most ${MAX_WIDGET_FIELDS}, keyed by \`^[a-z][a-z0-9_]{0,62}$\` (not \`item\`). Each takes \`type\` (required), \`role\`, \`required\` (default false), \`label\` (≤ ${MAX_FIELD_LABEL_LENGTH}; default: the key humanized) and \`description\` (≤ ${MAX_FIELD_DESCRIPTION_LENGTH}).`,
    "- `variants`: from `compact`, `default`, `detail`; must include `default` (the default list is `[\"default\"]`).",
    "- Unknown keys are errors.",
    "",
    "Field types, the view columns each accepts, and its displays (first is the default):",
    "",
    "| Type | Columns | Displays |",
    "| --- | --- | --- |",
  );
  for (const type of WIDGET_FIELD_TYPES) {
    const columns = compatibleColumnTypes(type);
    push(`| ${type} | ${columns === "any" ? "any" : columns.join(", ")} | ${displaysForField({ type }).join(", ") || "none"} |`);
  }
  push(
    "",
    `Numbers show as ${FIELD_TYPE_DISPLAYS.number.join("/")}, ${FIELD_TYPE_DISPLAYS.currency.join("/")} or ${FIELD_TYPE_DISPLAYS.percent.join("/")} depending on the column format (plain, currency, percent).`,
    "",
    "| Role | Types | Displays |",
    "| --- | --- | --- |",
  );
  for (const role of FIELD_ROLES) {
    push(`| ${role} | ${FIELD_ROLE_TYPES[role].join(", ")} | ${FIELD_ROLE_DISPLAYS[role].join(", ")} |`);
  }

  push(
    "",
    "### widget.html",
    "",
    "- Only the pieces below, text and blocks. No other elements and no `style`, `class`, `id`, `on*`, `aria-*` or `data-*` attributes: the renderer owns markup, styling and ARIA.",
    "- Close every piece explicitly: `<ravi-field name=\"status\"></ravi-field>`; `/>` is an error.",
    "- Text interpolation: `{field}`, `{field | filter}`, `{field | filter | filter}`. Values are always text, never HTML.",
    `- Blocks: \`{#if field}…{:else}…{/if}\`, \`{#if !field}…{/if}\`, \`{#each field as item}…{/each}\`. They go in the text between pieces, may wrap pieces, must open and close inside the same parent, and nest at most ${MAX_BLOCK_DEPTH} deep. There is no \`{:else if}\` and \`{#each}\` has no \`{:else}\`.`,
    `- \`{#each}\` iterates ${EACH_FIELD_TYPES.join(", ")} fields. Inside it \`item\` is the current entry: ${EACH_FIELD_TYPES.map((type) => `${type} → ${ITEM_PROPERTIES[type].map((name) => `item.${name}`).join(", ")}`).join("; ")}.`,
    "- Attribute values are a literal from the piece's list, or exactly one whole `{field}` where the attribute takes a field. No `{…}` inside a longer string and no filters in attributes.",
    `- Text, titles, badges, links and buttons hold text and inline pieces only (${PIECE_NAMES.filter((name) => PIECES[name]?.inline).map((name) => `\`${name}\``).join(", ")}); links and buttons never nest.`,
    "- Variants: optional top-level `<ravi-variant name=\"compact\">…</ravi-variant>` blocks. With blocks, all content goes inside one, `default` is required, and a listed variant without a block renders like `default` (warning). Without blocks the whole file is `default`.",
    "- Write `&#123;` and `&#125;` for literal braces.",
    "",
    "### Pieces",
    "",
    "| Piece | Renders | Attributes | Content |",
    "| --- | --- | --- | --- |",
  );
  for (const name of PIECE_NAMES) {
    const piece = PIECES[name] as PieceSpec;
    const attrs = Object.entries(piece.attrs).map(([attr, spec]) => attrSummary(attr, spec));
    push(
      `| \`${name}\` | ${cell(piece.description)} | ${attrs.length ? attrs.join("; ") : "none"} | ${contentSummary(piece)} |`,
    );
  }

  push("", "### Filters", "");
  for (const filter of TEMPLATE_FILTERS) {
    push(`- \`${filter}\` (${FILTERS[filter].accepts.join(", ")}): ${FILTERS[filter].description}`);
  }

  push(
    "",
    "### Buttons",
    "",
    "`<ravi-button action=\"…\">Text</ravi-button>` runs one action through the view and renders only when the view allows it: update needs every set column writable, create and archive need those capabilities. The confirmation text is built from the action, never from the label.",
    "",
    "- `update`: changes this record; needs `set`.",
    "- `create`: creates a record; `set` gives its values.",
    "- `archive`: archives this record; always confirms.",
    "- `open`: with `href=\"{url field}\"` a plain link; without it, a dialog with the whole record.",
    "- `confirm=\"true\"` asks before update or create.",
    "",
    "`set` is `field=value` pairs separated by `;`, on widget fields:",
    "",
    "- status: `@todo`, `@in_progress`, `@done` (the first option of that group) or an option name",
    "- select: an option name; text: literal text",
    "- checkbox: `true` or `false`; number: a number such as `10` or `2.5`",
    "- date: `@today` or `@now`",
    "- person: `@me`, the viewer (create only)",
    "",
    'Example: `<ravi-button action="update" set="status=@done;pago=true">Concluir</ravi-button>`.',
    "",
    "### Accessibility (checked at publish)",
    "",
    "- `ravi-image` needs `alt`: a field, a short text, or `decorative`. `ravi-avatar` needs `name`.",
    "- Buttons and links need text between their tags (an action, where the link goes).",
    "- `ravi-badge` and `ravi-text` with a `tone` or `color` need text: color is never the only signal.",
    "- Buttons, links and colored badges need text every record has: literal text, a required field, or a field inside `{#if field}…{/if}`. An optional field alone, or an `{#if}` without `{:else}`, can leave them empty and is an error.",
    "- Explicit `ravi-title` levels never skip a level going down (2 → 4 is an error); prefer omitting `level`.",
    "- Every `ravi-card` needs a `ravi-title` (its name); a compact card without one is a warning.",
    "- `ravi-canvas` needs a `label` saying what it shows.",
    "- The runtime adds the rest: status and select always show the option name, buttons are named \"<label>: <record title>\", focus is visible, every record carries `data-ravi-row` and every field `data-ravi-field` and `data-ravi-value` for agents.",
    "",
    "### widget.js (optional code)",
    "",
    "Use it only when the pieces cannot draw what the record needs (a chart, a map, a sparkline). The template still renders first and stays what readers without JavaScript, agents and `ravi pages read` see; the code draws on top.",
    "",
    "```js",
    "export function mount(card, ctx) {",
    "  const area = ctx.canvas(0); // the first <ravi-canvas> of this card",
    "  const draw = (next) => { area.textContent = String(next.record.values.valor ?? \"\"); };",
    "  draw(ctx);",
    "  return { update: draw, destroy() { area.replaceChildren(); } };",
    "}",
    "```",
    "",
    "- One ES module of at most 128 KiB with every library bundled in (no `import`, no `import()`, no `<script src>`, no workers). It must export `mount`.",
    "- `mount(card, ctx)` runs after the card renders and returns `{ update?(ctx), destroy?() }`: `update` when the record changes, `destroy` when the card leaves the page.",
    "- `ctx`: `record` (`{ id, values }` by widget field), `fields`, `canvas(i = 0)`, `locale`, `timeZone`, `mode` (light or dark), `theme(name)` (a CSS variable's value), `announce(text)` (polite live region), `el` (like `ravi.el`), `onModeChange(fn)` (returns an unsubscribe).",
    "- Draw inside `<ravi-canvas label=\"…\" height=\"20rem\"></ravi-canvas>` pieces: labelled empty regions, allowed only in widgets with `widget.js`. The rest of the card is re-rendered from the template on every change.",
    "- Read-only: the code changes no records; buttons stay `<ravi-button>`.",
    "- A throw leaves the static card as it is and reports `ravi:error` with kind `widget_script`.",
    "- Only an organization owner or admin publishes a widget with code (agents and developers propose). Each version passes an accessibility audit in the Console (axe-core over example.json with the code running; serious or critical violations fail) before a page can ship it: until then `ravi pages ship` fails with KIT_WIDGET_UNAUDITED and the link where an admin runs it.",
    "",
    "## Example widget folder",
    "",
  );
  for (const file of EXAMPLE_WIDGET_FILES) {
    const language = file.path.endsWith(".json") ? "json" : "html";
    push(`\`${file.path}\`:`, "", `\`\`\`${language}`, file.content.trimEnd(), "```", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function catalogJson(input: CatalogInput): WidgetCatalogJson {
  return {
    text: catalogText(input),
    pieces: PIECE_NAMES.map((name) => {
      const { attrs, ...piece } = PIECES[name] as PieceSpec;
      return { name, ...piece, attrs: Object.entries(attrs).map(([attr, spec]) => ({ name: attr, ...spec })) };
    }),
    filters: TEMPLATE_FILTERS.map((name) => ({ name, ...FILTERS[name] })),
    fieldTypes: WIDGET_FIELD_TYPES.map((type) => ({ type, columns: compatibleColumnTypes(type), displays: displaysForField({ type }) })),
    roles: FIELD_ROLES.map((role) => ({ role, types: FIELD_ROLE_TYPES[role], displays: FIELD_ROLE_DISPLAYS[role] })),
    displays: { types: FIELD_TYPE_DISPLAYS, roles: FIELD_ROLE_DISPLAYS, all: allDisplays() },
    tokens: THEME_TOKENS.map((token) => ({ ...token })),
    widgets: input.widgets,
  };
}

function attrSummary(name: string, spec: AttrSpec) {
  const forms: string[] = [];
  if (spec.values) forms.push(spec.values.join(", "));
  switch (spec.literal) {
    case "https-url":
      forms.push("https URL");
      break;
    case "link-url":
      forms.push("https, mailto or tel URL");
      break;
    case "number":
      forms.push("number");
      break;
    case "text":
      forms.push(`text ≤ ${spec.maxLength ?? 80}`);
      break;
    case "field-key":
      forms.push("field key");
      break;
    case "display":
      forms.push("display for the field type");
      break;
    case "set":
      forms.push("field=value;… pairs");
      break;
    case "css-length":
      forms.push("length in px, rem, em or vh");
      break;
    default:
      break;
  }
  if (spec.fields) forms.push(`{${spec.fields.join("/")} field}`);
  const required = spec.required || spec.a11y ? " (required)" : "";
  return `\`${name}\`${required}: ${forms.join(" or ")}`;
}

function contentSummary(piece: PieceSpec) {
  if (piece.content === "none") return "none";
  if (piece.content === "flow") return "any pieces";
  return piece.interactive ? "text and inline pieces (no controls)" : "text and inline pieces";
}

function oneLine(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function cell(text: string) {
  return oneLine(text).replace(/\|/g, "\\|");
}
