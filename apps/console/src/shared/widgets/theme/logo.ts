// `logo.svg`: parsed and rebuilt from an allowlist of shape, text, gradient,
// clip and mask elements and their presentation attributes. No scripts, no
// event handlers, no foreignObject, no references outside the file. Pages
// only ever show the result through `<img alt>` as a data: URL, which is a
// second barrier (images never run scripts or load subresources). Server-side
// only (htmlparser2); the runtime receives the finished data: URL.

import { parseDocument } from "htmlparser2";

import type { Diagnostic } from "../types";

export const LOGO_FILE = "logo.svg";
export const LOGO_MAX_BYTES = 64 * 1024;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_DEPTH = 32;

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "linearGradient",
  "radialGradient",
  "stop",
  "title",
  "desc",
  "clipPath",
  "mask",
  "use",
]);

/** Elements whose text content is kept. */
const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc"]);

/** Presentation properties allowed both as attributes and inside `style`. */
const PRESENTATION_PROPERTIES = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "color",
  "display",
  "visibility",
  "clip-path",
  "clip-rule",
  "mask",
  "vector-effect",
  "shape-rendering",
  "paint-order",
  "stop-color",
  "stop-opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "letter-spacing",
  "word-spacing",
  "text-decoration",
  "writing-mode",
  "transform",
  "transform-origin",
];
const STYLE_PROPERTIES = new Set(PRESENTATION_PROPERTIES);

const ALLOWED_ATTRIBUTES = new Set([
  ...PRESENTATION_PROPERTIES,
  "id",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "fr",
  "dx",
  "dy",
  "d",
  "points",
  "pathLength",
  "rotate",
  "textLength",
  "lengthAdjust",
  "offset",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "xml:space",
]);

const ID_PATTERN = /^[A-Za-z_][\w.:-]{0,127}$/;
const LOCAL_HREF_PATTERN = /^#[A-Za-z_][\w.:-]{0,127}$/;
const URL_FUNCTION_PATTERN = /url\s*\(/gi;
const LOCAL_URL_PATTERN = /url\s*\(\s*(['"]?)#[A-Za-z_][\w.:-]{0,127}\1\s*\)/gi;
/** Characters that never belong in a presentation value. */
const UNSAFE_VALUE_PATTERN = /[\\<>@{}]|expression\s*\(|javascript:/i;
const MAX_VALUE_LENGTH = 32 * 1024;

type DomNode = {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
};

/** True when every `url(...)` in `value` is a local `url(#id)` reference. */
function onlyLocalUrls(value: string) {
  const all = value.match(URL_FUNCTION_PATTERN)?.length ?? 0;
  const local = value.match(LOCAL_URL_PATTERN)?.length ?? 0;
  return all === local;
}

function hasControlCharacter(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

function escapeText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string) {
  return escapeText(value).replace(/"/g, "&quot;").replace(/[\t\n\r]/g, " ");
}

/**
 * Sanitizes logo.svg into a `data:image/svg+xml;base64,` URL. Errors (too
 * large, not an SVG) return null; removed content is reported as warnings.
 */
export function sanitizeLogoSvg(text: string): { dataUrl: string | null; diagnostics: Diagnostic[] } {
  const svg = sanitizeLogoMarkup(text);
  return { dataUrl: svg.markup === null ? null : `data:image/svg+xml;base64,${base64FromUtf8(svg.markup)}`, diagnostics: svg.diagnostics };
}

/** The rebuilt SVG markup (what sanitizeLogoSvg encodes). */
export function sanitizeLogoMarkup(text: string): { markup: string | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const error = (code: string, message: string) => {
    diagnostics.push({ severity: "error", code, message, file: LOGO_FILE });
    return { markup: null, diagnostics };
  };

  const bytes = utf8Encode(text).length;
  if (bytes > LOGO_MAX_BYTES) {
    return error("LOGO_TOO_LARGE", `logo.svg has ${bytes} bytes; the limit is ${LOGO_MAX_BYTES} (64 KiB).`);
  }

  const document = parseDocument(text, { xmlMode: true }) as unknown as DomNode;
  const roots = (document.children ?? []).filter((node) => isElement(node));
  const root = roots[0];
  if (!root || root.name !== "svg") return error("LOGO_INVALID", "logo.svg must have a single <svg> root element.");

  const removedElements = new Set<string>();
  const removedHandlers = new Set<string>();
  const removedReferences = new Set<string>();
  if (roots.length > 1) for (const extra of roots.slice(1)) removedElements.add(extra.name ?? "?");

  const sanitizeStyle = (value: string) => {
    const declarations: string[] = [];
    for (const declaration of value.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon === -1) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase();
      const propertyValue = declaration.slice(colon + 1).trim();
      if (!STYLE_PROPERTIES.has(property) || !propertyValue) continue;
      if (!onlyLocalUrls(propertyValue)) {
        removedReferences.add(`style ${property}`);
        continue;
      }
      if (UNSAFE_VALUE_PATTERN.test(propertyValue) || hasControlCharacter(propertyValue)) continue;
      declarations.push(`${property}:${propertyValue}`);
    }
    return declarations.join(";");
  };

  const sanitizeAttributes = (attribs: Record<string, string>) => {
    const out: Array<[string, string]> = [];
    for (const [name, rawValue] of Object.entries(attribs)) {
      const value = rawValue.trim();
      if (/^on/i.test(name)) {
        removedHandlers.add(name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (LOCAL_HREF_PATTERN.test(value)) out.push(["href", value]);
        else removedReferences.add(name);
        continue;
      }
      if (name === "style") {
        const style = sanitizeStyle(value);
        if (style) out.push(["style", style]);
        continue;
      }
      if (!ALLOWED_ATTRIBUTES.has(name) || value.length > MAX_VALUE_LENGTH || hasControlCharacter(value)) continue;
      if (name === "id") {
        if (ID_PATTERN.test(value)) out.push([name, value]);
        continue;
      }
      if (!onlyLocalUrls(value)) {
        removedReferences.add(name);
        continue;
      }
      if (UNSAFE_VALUE_PATTERN.test(value)) continue;
      out.push([name, value]);
    }
    return out;
  };

  const serialize = (node: DomNode, depth: number): string => {
    const name = node.name ?? "";
    const attributes = sanitizeAttributes(node.attribs ?? {});
    if (name === "svg" && depth === 0) attributes.unshift(["xmlns", SVG_NAMESPACE]);
    const keepText = TEXT_ELEMENTS.has(name);
    let inner = "";
    for (const child of node.children ?? []) {
      if (isElement(child)) {
        const childName = child.name ?? "";
        if (!ALLOWED_ELEMENTS.has(childName) || depth + 1 >= MAX_DEPTH) {
          removedElements.add(childName);
          continue;
        }
        inner += serialize(child, depth + 1);
      } else if (keepText && child.type === "text") {
        inner += escapeText(child.data ?? "");
      } else if (keepText && child.type === "cdata") {
        for (const part of child.children ?? []) if (part.type === "text") inner += escapeText(part.data ?? "");
      }
    }
    const attributeText = attributes.map(([key, value]) => ` ${key}="${escapeAttribute(value)}"`).join("");
    return inner ? `<${name}${attributeText}>${inner}</${name}>` : `<${name}${attributeText}/>`;
  };

  const markup = serialize(root, 0);

  const warn = (message: string) => diagnostics.push({ severity: "warning", code: "LOGO_SANITIZED", message, file: LOGO_FILE });
  const list = (names: Set<string>) => [...names].slice(0, 10).join(", ") + (names.size > 10 ? ", …" : "");
  if (removedElements.size) warn(`Removed elements a logo cannot use: ${list(removedElements)}.`);
  if (removedHandlers.size) warn(`Removed event handler attributes: ${list(removedHandlers)}.`);
  if (removedReferences.size) {
    warn(`Removed references outside the file (only local #id references are kept): ${list(removedReferences)}.`);
  }
  return { markup, diagnostics };
}

function isElement(node: DomNode) {
  return node.type === "tag" || node.type === "script" || node.type === "style";
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8Encode(text: string) {
  return new TextEncoder().encode(text);
}

/** Base64 of the UTF-8 bytes of `text`, without Buffer or btoa (isomorphic). */
export function base64FromUtf8(text: string): string {
  const bytes = utf8Encode(text);
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      BASE64_ALPHABET[(n >> 18) & 63]! + BASE64_ALPHABET[(n >> 12) & 63]! + BASE64_ALPHABET[(n >> 6) & 63]! + BASE64_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${BASE64_ALPHABET[(n >> 18) & 63]}${BASE64_ALPHABET[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${BASE64_ALPHABET[(n >> 18) & 63]}${BASE64_ALPHABET[(n >> 12) & 63]}${BASE64_ALPHABET[(n >> 6) & 63]}=`;
  }
  return out;
}
