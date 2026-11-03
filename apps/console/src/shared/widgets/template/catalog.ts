// The closed catalog of widget template pieces, their attributes and the
// interpolation filters. Single source for the template parser, the compiler,
// the renderer and the catalog text agents read (`catalog-text.ts`); nothing
// else lists pieces or values. Adding a piece, an attribute or a value is a
// public contract change (`.ravi/specs/console/widgets/SPEC.md`).

import {
  FIELD_ROLE_DISPLAYS,
  FIELD_TYPE_DISPLAYS,
  OPTION_COLORS,
  TEMPLATE_FILTERS,
  WIDGET_ACTION_VERBS,
  type TemplateFilter,
  type WidgetFieldSpec,
  type WidgetFieldType,
} from "../types";

/**
 * One attribute of a piece. A value is either a literal (from `values`, or of
 * the `literal` kind) or, when `fields` is set, exactly one whole `{path}`
 * naming a field of one of those types.
 */
export type AttrSpec = {
  /** Closed literal values. `["true"]` also accepts the attribute written without a value. */
  values?: readonly string[];
  /** Free literal accepted besides `values`. */
  literal?: "https-url" | "link-url" | "number" | "text" | "field-key" | "display" | "set" | "css-length";
  /** Longest `text` literal. */
  maxLength?: number;
  /** Field types accepted as one whole `{path}` (an `{item}` counts by its item type). */
  fields?: readonly WidgetFieldType[];
  required?: boolean;
  /** Required for accessibility: reported by the accessibility lint, not the parser. */
  a11y?: boolean;
  /** English, one line, for the agent catalog. */
  description: string;
};

/** What a piece holds: any piece (flow), text and inline pieces (phrasing), or nothing. */
export type PieceContent = "flow" | "phrasing" | "none";

export type PieceSpec = {
  /** Element the renderer outputs. `ravi-title` is `h2`..`h6` from context unless `level`. */
  tag: string;
  /** Class the renderer sets; `@layer ravi.pieces` styles it. */
  className: string;
  attrs: Record<string, AttrSpec>;
  /** Whether the piece takes content between its tags. */
  children: boolean;
  content: PieceContent;
  /** May appear inside phrasing content (titles, text, badges, links, buttons). */
  inline: boolean;
  /** A control: never nested inside another control. */
  interactive: boolean;
  /** English, one line, for the agent catalog. */
  description: string;
};

const GAPS = ["none", "xs", "sm", "md", "lg"] as const;
const TONES = ["primary", "secondary", "tertiary", "info", "success", "warning", "danger"] as const;

const gap: AttrSpec = { values: GAPS, description: "Space between children." };

export const PIECES: Record<string, PieceSpec> = {
  "ravi-card": {
    tag: "article",
    className: "ravi-card",
    attrs: {
      tone: { values: ["default", "subtle", "outline"], description: "Surface style." },
    },
    children: true,
    content: "flow",
    inline: false,
    interactive: false,
    description: "The record's card, an article named by its first ravi-title.",
  },
  "ravi-row": {
    tag: "div",
    className: "ravi-row",
    attrs: {
      justify: { values: ["start", "center", "end", "between"], description: "Horizontal distribution." },
      align: { values: ["start", "center", "end", "baseline"], description: "Vertical alignment." },
      gap,
      wrap: { values: ["true"], description: "Let children wrap to the next line." },
    },
    children: true,
    content: "flow",
    inline: false,
    interactive: false,
    description: "Children side by side; wraps to a column on narrow screens.",
  },
  "ravi-stack": {
    tag: "div",
    className: "ravi-stack",
    attrs: { gap },
    children: true,
    content: "flow",
    inline: false,
    interactive: false,
    description: "Children one under the other.",
  },
  "ravi-grid": {
    tag: "div",
    className: "ravi-grid",
    attrs: {
      columns: { values: ["1", "2", "3", "4"], description: "Columns on wide screens; fewer on narrow ones." },
      gap,
    },
    children: true,
    content: "flow",
    inline: false,
    interactive: false,
    description: "Children in a responsive grid.",
  },
  "ravi-divider": {
    tag: "hr",
    className: "ravi-divider",
    attrs: {},
    children: false,
    content: "none",
    inline: false,
    interactive: false,
    description: "A horizontal rule between sections.",
  },
  "ravi-title": {
    tag: "h2",
    className: "ravi-title",
    attrs: {
      level: {
        values: ["1", "2", "3", "4", "5", "6"],
        description: "Heading level; omit it to follow the page (view heading level + 1).",
      },
      size: { values: ["sm", "md", "lg"], description: "Visual size, independent of the level." },
    },
    children: true,
    content: "phrasing",
    inline: false,
    interactive: false,
    description: "The card's heading; the first one names the card.",
  },
  "ravi-text": {
    tag: "p",
    className: "ravi-text",
    attrs: {
      tone: { values: TONES, description: "Text color from the theme; never the only signal." },
      size: { values: ["xs", "sm", "md", "lg"], description: "Font size." },
      weight: { values: ["normal", "medium", "semibold", "bold"], description: "Font weight." },
      lines: { values: ["1", "2", "3"], description: "Clamp to this many lines." },
    },
    children: true,
    content: "phrasing",
    inline: true,
    interactive: false,
    description: "A paragraph (a span inside rows and inline content).",
  },
  "ravi-field": {
    tag: "div",
    className: "ravi-field",
    attrs: {
      name: { literal: "field-key", required: true, description: "The widget field key, without braces." },
      label: { values: ["hidden", "visible"], description: "Show the field label (default hidden; still read by screen readers)." },
      display: { literal: "display", description: "How to show the value; the closed list depends on the field type and role." },
      editable: { values: ["false"], description: "Never turn into an editor, even when the view lets the viewer write." },
    },
    children: false,
    content: "none",
    inline: false,
    interactive: false,
    description: "One field rendered by its type: label and value, editor when the view allows writing.",
  },
  "ravi-badge": {
    tag: "span",
    className: "ravi-badge",
    attrs: {
      tone: { values: TONES, description: "Badge color from the theme tones." },
      color: { values: OPTION_COLORS, description: "Badge color from the option colors." },
    },
    children: true,
    content: "phrasing",
    inline: true,
    interactive: false,
    description: "A short label with a color; the text always carries the meaning.",
  },
  "ravi-image": {
    tag: "img",
    className: "ravi-image",
    attrs: {
      src: { literal: "https-url", fields: ["url"], required: true, description: "A url field or an https literal." },
      alt: {
        values: ["decorative"],
        literal: "text",
        maxLength: 200,
        fields: ["text", "select", "status", "person"],
        a11y: true,
        description: "Text alternative: a field, a literal, or `decorative` for images that add nothing.",
      },
      ratio: { values: ["1:1", "4:3", "16:9", "3:4"], description: "Aspect ratio box." },
      fit: { values: ["cover", "contain"], description: "How the image fills the box." },
    },
    children: false,
    content: "none",
    inline: true,
    interactive: false,
    description: "An image, loaded without a referrer.",
  },
  "ravi-avatar": {
    tag: "img",
    className: "ravi-avatar",
    attrs: {
      src: { fields: ["url"], description: "A url field with the picture; omit it to use the person's avatar or initials." },
      name: { fields: ["text", "person"], a11y: true, description: "Whose avatar: a text or person field (the accessible name)." },
    },
    children: false,
    content: "none",
    inline: true,
    interactive: false,
    description: "A person's picture, or their initials when there is none.",
  },
  "ravi-link": {
    tag: "a",
    className: "ravi-link",
    attrs: {
      href: {
        literal: "link-url",
        fields: ["url", "email", "phone"],
        required: true,
        description: "A url, email or phone field, or an https:, mailto: or tel: literal.",
      },
    },
    children: true,
    content: "phrasing",
    inline: true,
    interactive: true,
    description: "A link (rel=noopener noreferrer); its text says where it goes.",
  },
  "ravi-metric": {
    tag: "div",
    className: "ravi-metric",
    attrs: {
      value: { fields: ["number"], required: true, description: "The number field to show big." },
      label: { literal: "text", maxLength: 80, description: "Caption; defaults to the field label." },
    },
    children: false,
    content: "none",
    inline: false,
    interactive: false,
    description: "A key number with its caption.",
  },
  "ravi-progress": {
    tag: "div",
    className: "ravi-progress",
    attrs: {
      value: { fields: ["number"], required: true, description: "The number field with the current value." },
      max: { literal: "number", fields: ["number"], description: "Maximum: a number or a number field (default 100, or 1 for percent)." },
    },
    children: false,
    content: "none",
    inline: false,
    interactive: false,
    description: "A meter with the value also as text.",
  },
  "ravi-canvas": {
    tag: "div",
    className: "ravi-canvas",
    attrs: {
      label: {
        literal: "text",
        maxLength: 200,
        fields: ["text", "select", "status", "person"],
        required: true,
        a11y: true,
        description: "What the region shows, for screen readers (e.g. Vendas por mês): a literal or a field.",
      },
      height: { literal: "css-length", description: "Height of the region: px, rem, em or vh (default 16rem)." },
    },
    children: false,
    content: "none",
    inline: false,
    interactive: false,
    description: "An empty, labelled region that widget.js draws in (a chart, a map); only in widgets with widget.js.",
  },
  "ravi-button": {
    tag: "button",
    className: "ravi-button",
    attrs: {
      action: { values: WIDGET_ACTION_VERBS, required: true, description: "What the button does to the record." },
      set: { literal: "set", description: "update and create: `field=value` pairs separated by `;`." },
      href: { fields: ["url"], description: "open: a url field to follow; without it, open shows the record." },
      variant: { values: ["primary", "secondary", "ghost", "danger"], description: "Visual emphasis." },
      confirm: { values: ["true"], description: "Ask before update or create (archive always asks)." },
    },
    children: true,
    content: "phrasing",
    inline: false,
    interactive: true,
    description: "A real button running one action through the view; shown only when the view allows it.",
  },
};

export const PIECE_NAMES = Object.keys(PIECES);

/** Top-level block holding one variant of the template; not a rendered piece. */
export const VARIANT_TAG = "ravi-variant";

/** Page tags (`ravi pages ship`), never valid inside a widget template. */
export const PAGE_TAGS = ["ravi-view", "ravi-widget", "ravi-form"] as const;

/** Attributes the renderer owns; a template never writes them. */
export function isForbiddenAttribute(name: string) {
  return (
    name === "style" ||
    name === "class" ||
    name === "id" ||
    name.startsWith("on") ||
    name.startsWith("aria-") ||
    name.startsWith("data-") ||
    name === "role" ||
    name === "tabindex"
  );
}

/** A `ravi-canvas` height: a positive length in px, rem, em or vh. */
export const CSS_LENGTH_PATTERN = /^(?:\d{1,4}(?:\.\d{1,3})?)(?:px|rem|em|vh)$/;

export const MAX_BLOCK_DEPTH = 8;
export const MAX_ELEMENT_DEPTH = 32;

// ---------------------------------------------------------------------------
// Filters

export type FilterSpec = { accepts: readonly WidgetFieldType[]; description: string };

export const FILTERS: Record<TemplateFilter, FilterSpec> = {
  date: { accepts: ["date"], description: "The date in the page locale (12/10/2026)." },
  relative: { accepts: ["date"], description: "Relative text up to 7 days away (in 2 days), else the date." },
  currency: { accepts: ["number"], description: "Money in the column's currency (R$ 1.890,50)." },
  number: { accepts: ["number"], description: "The number with the column's decimals." },
  compact: { accepts: ["number"], description: "Short number (12,4 mil)." },
  initials: { accepts: ["text", "person"], description: "Initials of a name (AS)." },
};

export const MAX_FILTERS = 2;

export function isTemplateFilter(name: string): name is TemplateFilter {
  return (TEMPLATE_FILTERS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// {#each}

/** Field types `{#each}` iterates. */
export const EACH_FIELD_TYPES = ["multi_select", "person", "ref"] as const satisfies readonly WidgetFieldType[];
export type EachFieldType = (typeof EACH_FIELD_TYPES)[number];

/** Properties of `item` by the iterated field type. */
export const ITEM_PROPERTIES: Record<EachFieldType, readonly string[]> = {
  multi_select: ["name", "color", "id"],
  person: ["name", "displayName", "id"],
  ref: ["type", "id"],
};

/** Every property `item.<x>` may name, before the field type is known. */
export const ITEM_PROPERTY_NAMES = ["name", "color", "id", "displayName", "type"] as const;

/** The field type a bare `{item}` counts as, for attributes and filters. Properties count as `text`. */
export const ITEM_TYPES: Record<EachFieldType, WidgetFieldType> = {
  multi_select: "select",
  person: "person",
  ref: "ref",
};

export function isEachFieldType(type: WidgetFieldType): type is EachFieldType {
  return (EACH_FIELD_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// Displays

/**
 * Displays `<ravi-field display>` accepts for a field. Numbers take the
 * number, currency and percent displays because the column format is only
 * known at render; a role adds its own displays.
 */
export function displaysForField(field: Pick<WidgetFieldSpec, "type" | "role">): string[] {
  const out: string[] = [];
  const add = (list: readonly string[]) => {
    for (const display of list) if (!out.includes(display)) out.push(display);
  };
  switch (field.type) {
    case "status":
    case "select":
    case "multi_select":
    case "date":
    case "person":
    case "url":
    case "checkbox":
      add(FIELD_TYPE_DISPLAYS[field.type]);
      break;
    case "number":
      add(FIELD_TYPE_DISPLAYS.number);
      add(FIELD_TYPE_DISPLAYS.currency);
      add(FIELD_TYPE_DISPLAYS.percent);
      break;
    default:
      break;
  }
  if (field.role) add(FIELD_ROLE_DISPLAYS[field.role]);
  return out;
}

/** Every display key, for the catalog. */
export function allDisplays(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(FIELD_TYPE_DISPLAYS)) for (const display of list) out.add(display);
  for (const list of Object.values(FIELD_ROLE_DISPLAYS)) for (const display of list) out.add(display);
  return [...out];
}
