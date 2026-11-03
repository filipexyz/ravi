// Plain-data virtual nodes shared by the ship prerender, the Console previews
// and the Pages runtime. A VNode is JSON (no closures): `toHtml` serializes it
// here, and the runtime builds DOM from the same tree. Both go through
// `sanitizeAttrs`, so the tag and attribute allowlist, URL scheme checks and
// the forced `rel`/`referrerpolicy` hold on every surface.

import type { VElement, VNode } from "../types";

export type { VElement, VNode };

export type UrlScheme = "https" | "http" | "mailto" | "tel";

type AttrInput = string | number | boolean | null | undefined;
type ChildInput = VNode | number | null | undefined | false | readonly ChildInput[];

const MAX_URL_CHARS = 2048;

/**
 * Builds a VElement. Attributes that are `false`, `null` or `undefined` are
 * left out, `true` is a bare attribute, numbers become strings. Children are
 * flattened, empty ones dropped and adjacent strings merged.
 */
export function h(tag: string, attrs?: Record<string, AttrInput> | null, ...children: ChildInput[]): VElement {
  const out: Record<string, string | true> = {};
  if (attrs) {
    for (const [name, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      out[name] = value === true ? true : String(value);
    }
  }
  return { tag, attrs: out, children: flattenChildren(children) };
}

export function flattenChildren(children: readonly ChildInput[]): VNode[] {
  const out: VNode[] = [];
  const push = (child: ChildInput) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      for (const nested of child) push(nested);
      return;
    }
    const node = typeof child === "number" ? String(child) : (child as VNode);
    if (typeof node === "string") {
      if (node === "") return;
      const last = out[out.length - 1];
      if (typeof last === "string") {
        out[out.length - 1] = last + node;
        return;
      }
    }
    out.push(node);
  };
  for (const child of children) push(child);
  return out;
}

// ---------------------------------------------------------------------------
// Escaping

export function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

export function escapeAttr(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ATTR_ENTITIES[char] ?? char);
}

const ATTR_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// ---------------------------------------------------------------------------
// URLs

/**
 * The URL a browser would follow for `value`, or null when its scheme is not
 * in `allowed`. The scheme is read from the parsed, final value (the URL
 * parser drops tabs and newlines and trims controls, so `java\nscript:` is
 * caught), relative and protocol-relative URLs are refused, and http(s) URLs
 * may not carry credentials.
 */
export function safeUrl(value: unknown, allowed: ReadonlyArray<UrlScheme>): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_URL_CHARS) return null;
  // Absolute URLs only: a scheme followed by ':' at the very start.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text.replace(/[\t\n\r]/g, ""))) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase() as UrlScheme;
  if (!allowed.includes(scheme)) return null;
  if ((scheme === "https" || scheme === "http") && (url.username || url.password || !url.hostname)) return null;
  return url.href;
}

/** `mailto:` URL for an e-mail value, or null. */
export function mailtoUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim();
  if (!/^[^\s@"<>(),;:\\[\]?&#%/]+@[^\s@"<>(),;:\\[\]?&#%/]+\.[^\s@"<>(),;:\\[\]?&#%/]+$/.test(email)) return null;
  return safeUrl(`mailto:${email}`, ["mailto"]);
}

/** `tel:` URL for a phone value (digits and a leading +), or null. */
export function telUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = value.replace(/[\s().-]/g, "");
  if (!/^\+?\d{3,20}$/.test(digits)) return null;
  return safeUrl(`tel:${digits}`, ["tel"]);
}

// ---------------------------------------------------------------------------
// Tags and attributes

const VOID_TAGS = new Set(["img", "hr", "br", "input", "col", "wbr"]);

const GLOBAL_ATTRS = new Set(["class", "id", "role", "title", "lang", "dir", "hidden", "tabindex", "style"]);

/** ARIA attributes carry no URLs or script; any well-formed name passes. */
const ARIA_ATTR = /^aria-[a-z]{3,20}$/;

const DATA_ATTR = /^data-ravi-[a-z][a-z0-9-]{0,40}$/;

/** Tags the renderer may emit that take only the global attributes. */
const PLAIN_TAGS =
  "abbr article aside b br caption code dd div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hr i legend li main mark nav p pre s section small span strong sub summary sup table tbody tfoot thead tr ul";

/** Tags with the attributes each accepts beyond the global ones. */
const SPECIFIC_TAGS: Record<string, string> = {
  a: "href rel hreflang",
  button: "type disabled name value",
  col: "span",
  colgroup: "span",
  details: "open",
  dialog: "open",
  fieldset: "disabled",
  form: "novalidate",
  img: "src alt width height loading referrerpolicy decoding",
  input: "type name value checked disabled required readonly placeholder min max step maxlength inputmode autocomplete",
  label: "for",
  meter: "value min max low high optimum",
  ol: "start reversed",
  option: "value selected disabled",
  output: "for",
  progress: "value max",
  select: "name disabled required",
  td: "colspan rowspan headers",
  textarea: "name rows disabled required readonly placeholder maxlength",
  th: "scope colspan rowspan abbr headers",
  time: "datetime",
};

function tagTable(): Map<string, ReadonlySet<string>> {
  const table = new Map<string, ReadonlySet<string>>();
  for (const tag of PLAIN_TAGS.split(" ")) table.set(tag, new Set());
  for (const [tag, names] of Object.entries(SPECIFIC_TAGS)) table.set(tag, new Set(names.split(" ")));
  return table;
}

/** Allowed tag -> its specific attributes. A Map, so `constructor` or `__proto__` are never tags. */
const TAG_ATTRS: ReadonlyMap<string, ReadonlySet<string>> = /* @__PURE__ */ tagTable();

const INPUT_TYPES = new Set(["checkbox", "text", "number", "date", "datetime-local", "email", "tel", "url", "search", "radio", "hidden"]);
const BUTTON_TYPES = new Set(["button", "submit", "reset"]);

const LINK_SCHEMES: readonly UrlScheme[] = ["https", "http", "mailto", "tel"];
const IMAGE_SCHEMES: readonly UrlScheme[] = ["https", "http"];

export function isAllowedTag(tag: string): boolean {
  return TAG_ATTRS.has(tag);
}

export function isVoidTag(tag: string): boolean {
  return VOID_TAGS.has(tag);
}

/**
 * Inline styles carry custom properties only (`--ravi-progress: 40%`,
 * theme variables on a preview pane) plus `color-scheme`, with values that
 * cannot load anything or break out of the declaration.
 */
export function safeStyle(value: string): string | null {
  const declarations: string[] = [];
  for (const raw of value.split(";")) {
    const declaration = raw.trim();
    if (!declaration) continue;
    const colon = declaration.indexOf(":");
    if (colon <= 0) return null;
    const name = declaration.slice(0, colon).trim();
    const val = declaration.slice(colon + 1).trim();
    if (!/^--[a-z0-9-]{1,64}$/.test(name) && name !== "color-scheme") return null;
    if (!val || val.length > 512) return null;
    if (/url\(|expression\(|image-set\(|[\\<>{}@]|\/\*|[\u0000-\u001f\u007f]/i.test(val)) return null;
    declarations.push(`${name}: ${val}`);
  }
  return declarations.length ? declarations.join("; ") : null;
}

/**
 * The attributes of `tag` that may be written, in order, or null when the
 * tag itself is not allowed. Unknown names, `on*`, URL attributes that fail
 * `safeUrl`, unsafe styles and unknown input/button types are dropped;
 * links always get `rel="noopener noreferrer"`, images
 * `referrerpolicy="no-referrer"` and `loading="lazy"`.
 */
export function sanitizeAttrs(tag: string, attrs: Readonly<Record<string, string | true>>): Record<string, string | true> | null {
  const specific = TAG_ATTRS.get(tag);
  if (!specific) return null;
  const out: Record<string, string | true> = {};
  for (const [rawName, value] of Object.entries(attrs)) {
    const name = rawName.toLowerCase();
    if (name.startsWith("on")) continue;
    if (!GLOBAL_ATTRS.has(name) && !ARIA_ATTR.test(name) && !DATA_ATTR.test(name) && !specific.has(name)) continue;
    if (name === "href" || name === "src") {
      const url = safeUrl(value === true ? "" : value, name === "src" ? IMAGE_SCHEMES : LINK_SCHEMES);
      if (url) out[name] = url;
      continue;
    }
    if (name === "style") {
      const style = value === true ? null : safeStyle(value);
      if (style) out.style = style;
      continue;
    }
    if (name === "type" && tag === "input" && (value === true || !INPUT_TYPES.has(value))) continue;
    if (name === "type" && tag === "button" && (value === true || !BUTTON_TYPES.has(value))) continue;
    out[name] = value;
  }
  if (tag === "a") out.rel = "noopener noreferrer";
  if (tag === "img") {
    out.referrerpolicy = "no-referrer";
    out.loading = "lazy";
    if (out.alt === undefined || out.alt === true) out.alt = "";
  }
  if (tag === "button" && out.type === undefined) out.type = "button";
  return out;
}

// ---------------------------------------------------------------------------
// Serialization

/**
 * HTML for one node or a list. Text and attribute values are escaped; tags
 * outside the allowlist are dropped but their children still render (as
 * escaped text and allowed elements).
 */
export function toHtml(nodes: VNode | readonly VNode[]): string {
  const list = Array.isArray(nodes) ? (nodes as readonly VNode[]) : [nodes as VNode];
  let out = "";
  for (const node of list) out += nodeHtml(node);
  return out;
}

function nodeHtml(node: VNode): string {
  if (typeof node === "string") return escapeHtml(node);
  if (!node || typeof node !== "object" || typeof node.tag !== "string") return "";
  const tag = node.tag.toLowerCase();
  const attrs = sanitizeAttrs(tag, node.attrs ?? {});
  const inner = Array.isArray(node.children) ? toHtml(node.children) : "";
  if (!attrs) return inner;
  let open = `<${tag}`;
  for (const [name, value] of Object.entries(attrs)) {
    open += value === true ? ` ${name}` : ` ${name}="${escapeAttr(value)}"`;
  }
  open += ">";
  if (VOID_TAGS.has(tag)) return open;
  return `${open}${inner}</${tag}>`;
}

/**
 * Concatenated text of a node tree. With `accessible`, the text an accessible
 * name is built from: `aria-hidden` subtrees are skipped and an image counts
 * as its `alt`.
 */
export function textContent(nodes: VNode | readonly VNode[], accessible = false): string {
  const list = Array.isArray(nodes) ? (nodes as readonly VNode[]) : [nodes as VNode];
  let out = "";
  for (const node of list) {
    if (typeof node === "string") out += node;
    else if (node && typeof node === "object") {
      if (accessible && node.attrs?.["aria-hidden"] === "true") continue;
      if (accessible && node.tag === "img") {
        const alt = node.attrs?.alt;
        if (typeof alt === "string") out += alt;
        continue;
      }
      out += textContent(node.children ?? [], accessible);
    }
  }
  return out;
}

/**
 * Puts a single space between adjacent elements, so text extraction (screen
 * reader browse mode, `ravi pages read`, textContent) keeps words apart.
 * Whitespace between flex and grid items does not render.
 */
export function spaced(nodes: readonly VNode[]): VNode[] {
  const out: VNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (previous !== undefined && typeof previous !== "string" && typeof node !== "string") out.push(" ");
    out.push(node);
  }
  return out;
}

/** Class list helper: joins the truthy names. */
export function cx(...names: Array<string | false | null | undefined>): string {
  return names.filter(Boolean).join(" ");
}
