// A compiled widget template plus one record → VNodes. Pieces become semantic
// HTML (CONTRACT 4.3): the card is an `article` named by its first title,
// titles take the heading level from the context, buttons are real buttons
// named "<visible label>: <record title>" and render only when the viewer's
// capabilities allow the action. The record root carries `data-ravi-row`.
// Interpolated dates are `<time datetime>`; initials keep the full name for
// screen readers and agents.

import type {
  CompiledWidget,
  RenderColumn,
  RenderContext,
  RenderRecord,
  TemplateAttrValue,
  TemplateFilter,
  TemplateNode,
  VElement,
  VNode,
  WidgetAction,
  WidgetFieldSpec,
} from "../types";
import {
  humanizeKey,
  isPhrasing,
  meterText,
  optionColor,
  renderAvatar,
  renderDateText,
  renderEmpty,
  renderField,
  renderInitialsText,
  renderMeter,
  resolveDisplay,
  roleFits,
  textDisplay,
} from "./fields";
import {
  applyFilters,
  dateDisplay,
  filteredDateParts,
  formatDateParts,
  formatNumberByColumn,
  formatValue,
  isDateColumn,
  isEmptyValue,
  numberKind,
  optionFor,
  optionValues,
  personRefs,
  rawValueText,
  refText,
  refValues,
  urlText,
} from "./format";
import { messages, type RuntimeMessages } from "./messages";
import { cx, h, mailtoUrl, safeUrl, spaced, telUrl, textContent } from "./vnode";

// ---------------------------------------------------------------------------
// Walk state

/** One `{#each}` item: what `item` and `item.<x>` read. */
export type EachItem = {
  id: string;
  name: string;
  displayName: string;
  color: string;
  type: string;
  avatarUrl: string | null;
};

type Scope = { name: string; item: EachItem };

type Walk = {
  widget: CompiledWidget;
  record: RenderRecord;
  ctx: RenderContext;
  msgs: RuntimeMessages;
  scopes: Scope[];
  /** Next id suffix (titles, field editors). */
  seq: number;
  /** Action index of each `ravi-button` node of the template. */
  actionIndexes: Map<TemplateNode, number | null>;
  /** Accessible record title for button names; null while it is being computed. */
  title: string | null;
  /** Next `data-ravi-canvas` index in this record. */
  canvases: number;
};

type Place = { inRow: boolean; textual: boolean };

const BLOCK: Place = { inRow: false, textual: false };
const TEXTUAL: Place = { inRow: false, textual: true };

// ---------------------------------------------------------------------------
// Closed attribute values (defensive: the compiler already checks them)

const GAPS = new Set(["none", "xs", "sm", "md", "lg"]);
const JUSTIFY = new Set(["start", "center", "end", "between"]);
const ALIGN = new Set(["start", "center", "end", "baseline"]);
const TONES = new Set(["primary", "secondary", "tertiary", "info", "success", "warning", "danger"]);
const CARD_TONES = new Set(["default", "subtle", "outline"]);
const SIZES = new Set(["xs", "sm", "md", "lg"]);
const TITLE_SIZES = new Set(["sm", "md", "lg"]);
const WEIGHTS = new Set(["normal", "medium", "semibold", "bold"]);
const RATIOS: Record<string, string> = { "1:1": "1-1", "4:3": "4-3", "16:9": "16-9", "3:4": "3-4" };
const BUTTON_VARIANTS = new Set(["primary", "secondary", "ghost", "danger"]);

function lit(node: Extract<TemplateNode, { k: "el" }>, name: string): string | null {
  const attr: TemplateAttrValue | undefined = node.attrs[name];
  return attr && "lit" in attr ? attr.lit : null;
}

function refPath(node: Extract<TemplateNode, { k: "el" }>, name: string): string[] | null {
  const attr: TemplateAttrValue | undefined = node.attrs[name];
  return attr && "ref" in attr ? attr.ref : null;
}

function closed(value: string | null, allowed: Set<string>): string | null {
  return value !== null && allowed.has(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Paths

type Resolved =
  | { kind: "field"; key: string; column: RenderColumn; value: unknown; spec: WidgetFieldSpec | undefined }
  | { kind: "item"; item: EachItem; prop: string | null }
  | null;

/** The column for a widget field: the mapped/static column, else one built from the field spec. */
export function widgetColumn(widget: CompiledWidget, ctx: RenderContext, key: string): RenderColumn {
  const column = ctx.columns[key];
  if (column) return column;
  const spec = widget.fields[key];
  return { key, name: spec?.label ?? humanizeKey(key), type: spec?.type ?? "text", config: {} };
}

function fieldLabel(walk: Walk, key: string): string {
  return walk.widget.fields[key]?.label?.trim() || walk.ctx.columns[key]?.name || humanizeKey(key);
}

function resolvePath(path: readonly string[], walk: Walk): Resolved {
  const [head, prop] = path;
  if (!head) return null;
  for (let index = walk.scopes.length - 1; index >= 0; index -= 1) {
    const scope = walk.scopes[index] as Scope;
    if (scope.name === head) return { kind: "item", item: scope.item, prop: prop ?? null };
  }
  const column = widgetColumn(walk.widget, walk.ctx, head);
  return { kind: "field", key: head, column, value: walk.record.values[head], spec: walk.widget.fields[head] };
}

function itemProp(item: EachItem, prop: string | null): string {
  switch (prop) {
    case null:
    case "name":
      return item.name;
    case "displayName":
      return item.displayName;
    case "color":
      return item.color;
    case "id":
      return item.id;
    case "type":
      return item.type;
    default:
      return "";
  }
}

function truthy(resolved: Resolved): boolean {
  if (!resolved) return false;
  if (resolved.kind === "item") return itemProp(resolved.item, resolved.prop) !== "";
  if (resolved.value === false) return false;
  return !isEmptyValue(resolved.value);
}

function eachItems(resolved: Resolved, walk: Walk): EachItem[] {
  if (!resolved || resolved.kind !== "field") return [];
  const { column, value } = resolved;
  const { ctx } = walk;
  switch (column.type) {
    case "multi_select":
    case "select":
    case "status":
      return optionValues(value).map((entry) => {
        const option = optionFor(column, entry);
        const name = option?.name ?? formatValue({ ...column, type: "select" }, entry, ctx);
        return { id: option?.id ?? String(entry), name, displayName: name, color: optionColor(option?.color), type: "option", avatarUrl: null };
      });
    case "person":
    case "created_by":
    case "updated_by":
      return personRefs(value, ctx.users, ctx.locale).map((person) => ({
        id: person.id,
        name: person.name,
        displayName: person.name,
        color: "",
        type: "person",
        avatarUrl: person.avatarUrl,
      }));
    case "ref":
      return refValues(value).map((ref) => ({ id: ref.id, name: refText(ref), displayName: refText(ref), color: "", type: ref.type, avatarUrl: null }));
    default:
      if (!Array.isArray(value)) return [];
      return value.map((entry, index) => genericItem(entry, index));
  }
}

function genericItem(entry: unknown, index: number): EachItem {
  if (entry && typeof entry === "object") {
    const object = entry as Record<string, unknown>;
    const text = (key: string) => (typeof object[key] === "string" || typeof object[key] === "number" ? String(object[key]) : "");
    const name = text("name") || text("displayName") || text("title");
    return {
      id: text("id") || name || String(index),
      name,
      displayName: text("displayName") || name,
      color: text("color"),
      type: text("type"),
      avatarUrl: text("avatarUrl") || null,
    };
  }
  const name = entry === null || entry === undefined ? "" : String(entry);
  return { id: name, name, displayName: name, color: "", type: "", avatarUrl: null };
}

/** The value `{path}` reads: a field's column and value, or an `{#each}` item's text. */
function exprSource(path: readonly string[], walk: Walk): { column: RenderColumn; value: unknown; display: string | null } | null {
  const resolved = resolvePath(path, walk);
  if (!resolved) return null;
  if (resolved.kind === "item") {
    return { column: { key: path.join("."), name: "", type: "text", config: {} }, value: itemProp(resolved.item, resolved.prop), display: null };
  }
  const role = roleFits(resolved.spec?.role, resolved.column) ? resolved.spec?.role : undefined;
  const display = textDisplay(resolveDisplay({ column: resolved.column, role, rules: walk.ctx.fields }), role);
  return { column: resolved.column, value: resolved.value, display };
}

/**
 * Plain text of `{path}` for attributes and names (alt, avatar name): the
 * theme's display, except that people shown as initials read as their names.
 */
function exprText(path: readonly string[], walk: Walk): string {
  const source = exprSource(path, walk);
  if (!source) return "";
  if (source.display === null) return typeof source.value === "string" ? source.value : "";
  return formatValue(source.column, source.value, walk.ctx, source.display === "initials" ? "name" : source.display);
}

/**
 * Text of `{path | filters}` in content: dates as `<time datetime>`, and
 * initials (the `initials` filter or a theme that shows people as initials)
 * with the full text kept for screen readers and agents.
 */
function exprNodes(path: readonly string[], filters: readonly TemplateFilter[], walk: Walk): VNode[] {
  const source = exprSource(path, walk);
  if (!source) return [];
  const { column, value, display } = source;
  const { ctx } = walk;
  if (filters.includes("initials")) {
    const rest = filters.filter((filter) => filter !== "initials");
    return renderInitialsText(applyFilters(filters, column, value, ctx), applyFilters(rest, column, value, ctx));
  }
  if (filters.length) {
    const date = filteredDateParts(filters, column, value, ctx);
    return date ? renderDateText(date) : [applyFilters(filters, column, value, ctx)];
  }
  if (display === null) return [typeof value === "string" ? value : ""];
  if (display === "initials") return renderInitialsText(formatValue(column, value, ctx, "initials"), formatValue(column, value, ctx, "name"));
  const date = isDateColumn(column.type) ? formatDateParts(column, value, ctx, dateDisplay(display)) : null;
  return date ? renderDateText(date) : [formatValue(column, value, ctx, display)];
}

/** Plain text of an attribute that names a field or an item (alt, name). */
function attrText(node: Extract<TemplateNode, { k: "el" }>, name: string, walk: Walk): string | null {
  const literal = lit(node, name);
  if (literal !== null) return literal;
  const path = refPath(node, name);
  return path ? exprText(path, walk) : null;
}

// ---------------------------------------------------------------------------
// Tree walk

/**
 * Renders a node list. Text keeps the parser's spacing: whitespace is a word
 * space in text pieces and dropped in layout content, two runs that meet keep
 * one space, and only an element's content (`trimEdges`) is trimmed at its
 * edges; `{#if}` branches and `{#each}` items are not, so
 * `{titulo}{#if cliente} · {cliente}{/if}` keeps both spaces.
 */
function renderNodes(nodes: readonly TemplateNode[], walk: Walk, place: Place, trimEdges = true): VNode[] {
  const out: VNode[] = [];
  const push = (node: VNode) => {
    const last = out[out.length - 1];
    if (typeof node === "string" && typeof last === "string") {
      out[out.length - 1] = /\s$/.test(last) ? last + node.replace(/^\s+/, "") : last + node;
      return;
    }
    if (node !== "") out.push(node);
  };
  for (const node of nodes) {
    switch (node.k) {
      case "text": {
        const text = node.v.replace(/\s+/g, " ");
        if (text.trim() !== "" || place.textual) push(text);
        break;
      }
      case "expr":
        for (const child of exprNodes(node.path, node.filters, walk)) push(child);
        break;
      case "if": {
        const ok = truthy(resolvePath(node.path, walk)) !== node.not;
        for (const child of renderNodes(ok ? node.then : node.else, walk, place, false)) push(child);
        break;
      }
      case "each": {
        const items = eachItems(resolvePath(node.path, walk), walk);
        for (const item of items) {
          walk.scopes.push({ name: node.as, item });
          try {
            for (const child of renderNodes(node.children, walk, place, false)) push(child);
          } finally {
            walk.scopes.pop();
          }
        }
        break;
      }
      case "el": {
        const renderer = PIECE_RENDERERS[node.piece];
        if (!renderer) break;
        const rendered = renderer(node, walk, place);
        if (Array.isArray(rendered)) for (const child of rendered) push(child);
        else if (rendered) push(rendered as VNode);
        break;
      }
      default:
        break;
    }
  }
  if (trimEdges) {
    // `<ravi-title> {titulo} </ravi-title>` has no stray spaces.
    if (typeof out[0] === "string") out[0] = (out[0] as string).replace(/^\s+/, "");
    const last = out.length - 1;
    if (last >= 0 && typeof out[last] === "string") out[last] = (out[last] as string).replace(/\s+$/, "");
  }
  return out.filter((node) => node !== "");
}

/** Whether rendered content gives an accessible name: text, or an image's alt. */
function hasAccessibleText(nodes: readonly VNode[]): boolean {
  return textContent(nodes, true).trim() !== "";
}

type PieceRenderer = (node: Extract<TemplateNode, { k: "el" }>, walk: Walk, place: Place) => VNode | VNode[] | null;

function nextId(walk: Walk, kind: string) {
  walk.seq += 1;
  return `${walk.ctx.idPrefix}-${kind}${walk.seq}`;
}

function findTitleId(nodes: readonly VNode[]): string | null {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (node.tag === "article") continue;
    const classes = typeof node.attrs.class === "string" ? node.attrs.class.split(" ") : [];
    if (/^h[1-6]$/.test(node.tag) && classes.includes("ravi-title") && typeof node.attrs.id === "string") return node.attrs.id;
    const nested = findTitleId(node.children);
    if (nested) return nested;
  }
  return null;
}

function gapClass(node: Extract<TemplateNode, { k: "el" }>) {
  const gap = closed(lit(node, "gap"), GAPS);
  return gap ? `ravi-gap-${gap}` : null;
}

function headingLevel(node: Extract<TemplateNode, { k: "el" }>, walk: Walk) {
  const explicit = Number(lit(node, "level"));
  const level = Number.isInteger(explicit) && explicit >= 1 && explicit <= 6 ? explicit : walk.ctx.headingLevel;
  return Math.min(6, Math.max(1, Number.isInteger(level) ? level : 2));
}

/** Resolves a `src`/`href` attribute: an https literal, or a url/email/phone field (or `item` text). */
function urlAttr(node: Extract<TemplateNode, { k: "el" }>, name: string, walk: Walk, kind: "image" | "link"): { url: string | null; key: string | null } {
  const literal = lit(node, name);
  if (literal !== null) return { url: safeUrl(literal, kind === "image" ? ["https"] : ["https", "mailto", "tel"]), key: null };
  const path = refPath(node, name);
  const resolved = path ? resolvePath(path, walk) : null;
  if (!resolved) return { url: null, key: null };
  if (resolved.kind === "item") {
    const text = resolved.prop === null && resolved.item.avatarUrl ? resolved.item.avatarUrl : itemProp(resolved.item, resolved.prop);
    return { url: safeUrl(text, kind === "image" ? ["https", "http"] : ["https", "http", "mailto", "tel"]), key: null };
  }
  const { column, value, key } = resolved;
  if (kind === "link" && column.type === "email") return { url: mailtoUrl(value), key };
  if (kind === "link" && column.type === "phone") return { url: telUrl(value), key };
  return { url: safeUrl(value, ["https", "http"]), key };
}

// ---------------------------------------------------------------------------
// Pieces

function renderCard(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement {
  const children = renderNodes(node.children, walk, BLOCK);
  const tone = closed(lit(node, "tone"), CARD_TONES);
  return h(
    "article",
    { class: cx("ravi-card", tone && tone !== "default" && `ravi-card-${tone}`), "aria-labelledby": findTitleId(children) },
    spaced(children),
  );
}

function renderRow(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement {
  const justify = closed(lit(node, "justify"), JUSTIFY);
  const align = closed(lit(node, "align"), ALIGN);
  return h(
    "div",
    {
      class: cx("ravi-row", justify && `ravi-justify-${justify}`, align && `ravi-align-${align}`, gapClass(node), lit(node, "wrap") === "true" && "ravi-wrap"),
    },
    spaced(renderNodes(node.children, walk, { inRow: true, textual: false })),
  );
}

function renderStack(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement {
  return h("div", { class: cx("ravi-stack", gapClass(node)) }, spaced(renderNodes(node.children, walk, BLOCK)));
}

function renderGrid(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement {
  const columns = Number(lit(node, "columns"));
  const count = Number.isInteger(columns) && columns >= 1 && columns <= 4 ? columns : 2;
  return h("div", { class: cx("ravi-grid", `ravi-cols-${count}`, gapClass(node)) }, spaced(renderNodes(node.children, walk, BLOCK)));
}

/** A heading; an empty one reads "Sem título" like the default card, so the card it names keeps a name. */
function renderTitle(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement {
  const size = closed(lit(node, "size"), TITLE_SIZES);
  const children = renderNodes(node.children, walk, TEXTUAL);
  return h(
    `h${headingLevel(node, walk)}`,
    { class: cx("ravi-title", size && `ravi-size-${size}`), id: nextId(walk, "title") },
    hasAccessibleText(children) ? children : [...children, walk.msgs.untitled],
  );
}

function renderText(node: Extract<TemplateNode, { k: "el" }>, walk: Walk, place: Place): VElement {
  const tone = closed(lit(node, "tone"), TONES);
  const size = closed(lit(node, "size"), SIZES);
  const weight = closed(lit(node, "weight"), WEIGHTS);
  const lines = Number(lit(node, "lines"));
  const children = renderNodes(node.children, walk, TEXTUAL);
  const tag = !isPhrasing(children) ? "div" : place.inRow || place.textual ? "span" : "p";
  return h(
    tag,
    {
      class: cx(
        "ravi-text",
        tone && `ravi-tone-${tone}`,
        size && `ravi-size-${size}`,
        weight && `ravi-weight-${weight}`,
        Number.isInteger(lines) && lines >= 1 && lines <= 3 && `ravi-lines-${lines}`,
      ),
    },
    children,
  );
}

function renderFieldPiece(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement | null {
  const key = lit(node, "name") ?? refPath(node, "name")?.[0] ?? null;
  if (!key) return null;
  const column = widgetColumn(walk.widget, walk.ctx, key);
  walk.seq += 1;
  return renderField(
    {
      key,
      column,
      value: walk.record.values[key],
      role: walk.widget.fields[key]?.role,
      display: lit(node, "display") ?? undefined,
      label: lit(node, "label") === "visible" ? "visible" : "hidden",
      labelText: fieldLabel(walk, key),
      editable: lit(node, "editable") !== "false",
      uid: `f${walk.seq}`,
    },
    walk.ctx,
  );
}

/** A badge with its text; one that renders no text is left out, so a color never shows alone. */
function renderBadge(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement | null {
  const tone = closed(lit(node, "tone"), TONES);
  const color = lit(node, "color");
  const children = renderNodes(node.children, walk, TEXTUAL);
  if (!hasAccessibleText(children)) return null;
  return h("span", { class: cx("ravi-badge", tone && `ravi-tone-${tone}`, !tone && color && `ravi-option-${optionColor(color)}`) }, children);
}

function renderImage(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement | null {
  const ratio = RATIOS[lit(node, "ratio") ?? ""] ?? null;
  const fit = lit(node, "fit") === "contain" ? "contain" : null;
  const className = cx("ravi-image", ratio && `ravi-ratio-${ratio}`, fit && "ravi-fit-contain");
  const { url } = urlAttr(node, "src", walk, "image");
  if (!url) return ratio ? h("div", { class: cx(className, "ravi-image-empty"), "aria-hidden": "true" }) : null;
  const altLiteral = lit(node, "alt");
  const alt = altLiteral === "decorative" ? "" : (attrText(node, "alt", walk) ?? "");
  return h("img", { class: className, src: url, alt });
}

function renderAvatarPiece(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement | null {
  const namePath = refPath(node, "name");
  const resolved = namePath ? resolvePath(namePath, walk) : null;
  let name = lit(node, "name") ?? "";
  let avatarUrl: string | null = null;
  if (resolved?.kind === "field" && (resolved.column.type === "person" || resolved.column.type === "created_by" || resolved.column.type === "updated_by")) {
    const person = personRefs(resolved.value, walk.ctx.users, walk.ctx.locale)[0];
    name = person?.name ?? "";
    avatarUrl = person?.avatarUrl ?? null;
  } else if (resolved?.kind === "item") {
    name = itemProp(resolved.item, resolved.prop === null ? "displayName" : resolved.prop);
    avatarUrl = resolved.item.avatarUrl;
  } else if (resolved) {
    name = exprText(namePath ?? [], walk);
  }
  const src = urlAttr(node, "src", walk, "image").url ?? avatarUrl;
  if (!name && !src) return null;
  return renderAvatar({ name: name || walk.msgs.unknownPerson, avatarUrl: src }, {});
}

/** A link; when its text renders empty, the address itself names it. */
function renderLinkPiece(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement {
  const { url } = urlAttr(node, "href", walk, "link");
  const children = renderNodes(node.children, walk, TEXTUAL);
  if (!url) return h("span", { class: "ravi-link-text" }, children);
  const shown = hasAccessibleText(children) ? children : [...children, urlText(url.replace(/^(?:mailto|tel):/i, ""))];
  return h("a", { class: "ravi-link", href: url }, shown);
}

const CANVAS_HEIGHT = /^(?:\d{1,4}(?:\.\d{1,3})?)(?:px|rem|em|vh)$/;

/**
 * The region `widget.js` draws in: empty, named by its label (the widget's
 * name when a field label renders empty), `data-ravi-canvas` numbering the
 * record's canvases from 0. Static HTML is an empty region of its height.
 */
function renderCanvas(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement {
  const label = (attrText(node, "label", walk) ?? "").replace(/\s+/g, " ").trim() || walk.widget.name;
  const height = lit(node, "height");
  return h("div", {
    class: "ravi-canvas",
    role: "region",
    "aria-label": label,
    "data-ravi-canvas": walk.canvases++,
    style: height && CANVAS_HEIGHT.test(height) ? `--ravi-canvas-height: ${height}` : null,
  });
}

function renderMetric(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement | null {
  const path = refPath(node, "value");
  const resolved = path ? resolvePath(path, walk) : null;
  if (!resolved || resolved.kind !== "field") return null;
  const label = lit(node, "label") ?? fieldLabel(walk, resolved.key);
  const value =
    typeof resolved.value === "number"
      ? h("span", { class: "ravi-metric-value" }, formatNumberByColumn(resolved.value, resolved.column, walk.ctx.locale))
      : h("span", { class: "ravi-metric-value" }, renderEmpty(walk.msgs));
  return h(
    "div",
    { class: "ravi-metric", "data-ravi-field": resolved.key, "data-ravi-value": rawValueText(resolved.column, resolved.value) },
    h("span", { class: "ravi-metric-label" }, label),
    " ",
    value,
  );
}

function renderProgress(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement | null {
  const path = refPath(node, "value");
  const resolved = path ? resolvePath(path, walk) : null;
  if (!resolved || resolved.kind !== "field") return null;
  const label = fieldLabel(walk, resolved.key);
  const data = { "data-ravi-field": resolved.key, "data-ravi-value": rawValueText(resolved.column, resolved.value) };
  if (typeof resolved.value !== "number") {
    return h("div", { class: "ravi-progress", ...data }, h("span", { class: "ravi-sr-only" }, `${label}: `), renderEmpty(walk.msgs));
  }
  let max: number | null = Number(lit(node, "max"));
  if (!Number.isFinite(max) || (max as number) <= 0) {
    const maxPath = refPath(node, "max");
    const maxResolved = maxPath ? resolvePath(maxPath, walk) : null;
    max = maxResolved?.kind === "field" && typeof maxResolved.value === "number" && maxResolved.value > 0 ? maxResolved.value : null;
  }
  const limit = max ?? (numberKind(resolved.column) === "percent" ? 1 : 100);
  const meter = renderMeter({ value: resolved.value, max: limit, text: meterText(resolved.value, resolved.column, limit, walk.ctx.locale), shape: "bar", label });
  return h("div", { class: "ravi-progress", ...data }, meter);
}

/**
 * Index of the action a button node refers to: an index the compiler stored
 * on the node; else the n-th action with the same verb and literal label;
 * else the n-th action with the same verb (n counted in document order).
 */
function actionIndexFor(node: Extract<TemplateNode, { k: "el" }>, actions: readonly WidgetAction[], seen: Map<string, number>): number | null {
  for (const name of ["data-ravi-action", "actionIndex", "action-index", "index", "action"]) {
    const value = lit(node, name);
    if (value !== null && /^\d{1,4}$/.test(value)) {
      const index = Number(value);
      return index < actions.length ? index : null;
    }
  }
  const verb = lit(node, "action");
  const label = literalText(node.children);
  const nth = (key: string, matches: (action: WidgetAction) => boolean) => {
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    const indexes = actions.flatMap((action, index) => (matches(action) ? [index] : []));
    return indexes.length ? (indexes[Math.min(ordinal, indexes.length - 1)] as number) : null;
  };
  const sameLabel = (action: WidgetAction) => action.verb === verb && action.label.replace(/\s+/g, " ").trim() === label;
  if (actions.some(sameLabel)) return nth(`label|${verb}|${label}`, sameLabel);
  return nth(`verb|${verb}`, (action) => action.verb === verb);
}

/** Action index of every `ravi-button` in the template, every branch included, in document order. */
function assignActionIndexes(template: readonly TemplateNode[], actions: readonly WidgetAction[]): Map<TemplateNode, number | null> {
  const out = new Map<TemplateNode, number | null>();
  const seen = new Map<string, number>();
  const visit = (nodes: readonly TemplateNode[]) => {
    for (const node of nodes) {
      if (node.k === "el") {
        if (node.piece === "ravi-button") out.set(node, actionIndexFor(node, actions, seen));
        visit(node.children);
      } else if (node.k === "if") {
        visit(node.then);
        visit(node.else);
      } else if (node.k === "each") {
        visit(node.children);
      }
    }
  };
  visit(template);
  return out;
}

function literalText(nodes: readonly TemplateNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.k === "text") out += node.v;
    else if (node.k === "el") out += literalText(node.children);
  }
  return out.replace(/\s+/g, " ").trim();
}

function actionAllowed(action: WidgetAction, walk: Walk): boolean {
  const { can } = walk.ctx;
  switch (action.verb) {
    case "update":
      return Object.keys(action.set).every((key) => can.write.has(key));
    case "create":
      return can.create;
    case "archive":
      return can.archive;
    case "open":
      return action.href !== null || walk.record.id !== null || !walk.ctx.interactive;
    default:
      return false;
  }
}

function renderButton(node: Extract<TemplateNode, { k: "el" }>, walk: Walk): VElement | null {
  const index = walk.actionIndexes.get(node) ?? null;
  if (index === null) return null;
  const action = walk.widget.actions[index] as WidgetAction;
  if (!actionAllowed(action, walk)) return null;
  const children = renderNodes(node.children, walk, TEXTUAL);
  // The visible label: the content's text (an image counts as its alt), else
  // the action's verb ("Arquivar"), shown so the button is never empty.
  const shown = textContent(children, true).replace(/\s+/g, " ").trim();
  const visible = shown || action.label.replace(/\s+/g, " ").trim() || walk.msgs.confirmAction(action.verb);
  const content = shown ? children : [...children, visible];
  const title = walk.title ?? "";
  const name = title && title !== visible ? `${visible}: ${title}` : null;
  const variant = closed(lit(node, "variant"), BUTTON_VARIANTS) ?? "secondary";
  const className = cx("ravi-button", `ravi-button-${variant}`);
  if (action.verb === "open" && action.href) {
    const href = safeUrl(walk.record.values[action.href], ["https", "http"]);
    if (!href) return null;
    return h("a", { class: className, href, "aria-label": name, "data-ravi-action": String(index) }, content);
  }
  const dialog = action.confirm || action.verb === "archive" || action.verb === "open";
  return h(
    "button",
    {
      type: "button",
      class: className,
      "aria-label": name,
      "aria-haspopup": dialog ? "dialog" : null,
      "data-ravi-action": String(index),
      disabled: !walk.ctx.interactive,
      "aria-disabled": walk.ctx.interactive ? null : "true",
    },
    content,
  );
}

/** One renderer per catalog piece (`template/catalog.ts` `PIECE_NAMES`). */
export const PIECE_RENDERERS: Record<string, PieceRenderer> = {
  "ravi-card": (node, walk) => renderCard(node, walk),
  "ravi-row": (node, walk) => renderRow(node, walk),
  "ravi-stack": (node, walk) => renderStack(node, walk),
  "ravi-grid": (node, walk) => renderGrid(node, walk),
  "ravi-divider": () => h("hr", { class: "ravi-divider" }),
  "ravi-title": (node, walk) => renderTitle(node, walk),
  "ravi-text": (node, walk, place) => renderText(node, walk, place),
  "ravi-field": (node, walk) => renderFieldPiece(node, walk),
  "ravi-badge": (node, walk) => renderBadge(node, walk),
  "ravi-image": (node, walk) => renderImage(node, walk),
  "ravi-avatar": (node, walk) => renderAvatarPiece(node, walk),
  "ravi-link": (node, walk) => renderLinkPiece(node, walk),
  "ravi-metric": (node, walk) => renderMetric(node, walk),
  "ravi-progress": (node, walk) => renderProgress(node, walk),
  "ravi-button": (node, walk) => renderButton(node, walk),
  "ravi-canvas": (node, walk) => renderCanvas(node, walk),
};

// ---------------------------------------------------------------------------
// Record title and root

function findFirstTitle(nodes: readonly TemplateNode[], walk: Walk): Extract<TemplateNode, { k: "el" }> | null {
  for (const node of nodes) {
    if (node.k === "el") {
      if (node.piece === "ravi-title") return node;
      const nested = findFirstTitle(node.children, walk);
      if (nested) return nested;
    } else if (node.k === "if") {
      const ok = truthy(resolvePath(node.path, walk)) !== node.not;
      const nested = findFirstTitle(ok ? node.then : node.else, walk);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * The record's title for accessible names: the first `ravi-title`'s text
 * ("Sem título" when it renders empty, as the heading does), else the first
 * text field with a value.
 */
export function widgetRecordTitle(widget: CompiledWidget, record: RenderRecord, ctx: RenderContext, template?: readonly TemplateNode[]): string {
  const walk = newWalk(widget, record, ctx);
  const nodes = template ?? widget.variants[ctx.variant] ?? widget.variants.default;
  const title = findFirstTitle(nodes, walk);
  if (title) {
    const text = textContent(renderNodes(title.children, walk, TEXTUAL), true).replace(/\s+/g, " ").trim();
    return text || walk.msgs.untitled;
  }
  const keys = Object.keys(widget.fields);
  const ordered = [...keys.filter((key) => widget.fields[key]?.required), ...keys.filter((key) => !widget.fields[key]?.required)];
  for (const key of ordered) {
    if (widget.fields[key]?.type !== "text") continue;
    const value = record.values[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function newWalk(widget: CompiledWidget, record: RenderRecord, ctx: RenderContext, template: readonly TemplateNode[] = []): Walk {
  return {
    widget,
    record,
    ctx,
    msgs: messages(ctx.locale),
    scopes: [],
    seq: 0,
    actionIndexes: assignActionIndexes(template, widget.actions),
    title: null,
    canvases: 0,
  };
}

/** Puts `data-ravi-row` on the single root element, or wraps several roots in `div.ravi-record`. */
export function markRecordRoot(nodes: VNode[], record: Pick<RenderRecord, "id">): VNode[] {
  const rowId = record.id ?? "";
  const elements = nodes.filter((node): node is VElement => typeof node !== "string");
  const strayText = nodes.some((node) => typeof node === "string" && node.trim() !== "");
  if (elements.length === 1 && !strayText) {
    const root = elements[0] as VElement;
    root.attrs["data-ravi-row"] = rowId;
    return [root];
  }
  return [h("div", { class: "ravi-record", "data-ravi-row": rowId }, nodes)];
}

/**
 * Renders `record` with the template of `ctx.variant` (falling back to
 * `default`). The root element carries `data-ravi-row`; buttons carry
 * `data-ravi-action="<index into widget.actions>"`.
 */
export function renderWidget(widget: CompiledWidget, record: RenderRecord, ctx: RenderContext): VNode[] {
  const template = widget.variants[ctx.variant] ?? widget.variants.default ?? [];
  const walk = newWalk(widget, record, ctx, template);
  walk.title = widgetRecordTitle(widget, record, ctx, template);
  return markRecordRoot(renderNodes(template, walk, BLOCK), record);
}
