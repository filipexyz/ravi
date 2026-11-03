// DOM from the shared VNodes, `ravi.el` for page code, and focus keys that
// survive a re-render. Attributes go through `sanitizeAttrs` (the same
// allowlist `toHtml` applies) and are set with `setAttribute`; text is a text
// node. Nothing here writes HTML.

import { isVoidTag, safeUrl, sanitizeAttrs } from "@/shared/widgets/render/vnode";
import type { VNode } from "@/shared/widgets/types";

export type ElChild = Node | string | number | null | undefined | false | readonly ElChild[];

/** Every focusable control. */
export const FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])";

/** DOM nodes for VNodes. Tags outside the renderer allowlist are dropped, their children kept. */
export function toDom(doc: Document, nodes: VNode | readonly VNode[]): Node[] {
  return ([] as VNode[]).concat(nodes as VNode).flatMap((node): Node[] => {
    if (typeof node == "string") return [doc.createTextNode(node)];
    if (!node || typeof node.tag != "string") return [];
    const tag = node.tag.toLowerCase();
    const attrs = sanitizeAttrs(tag, node.attrs ?? {});
    const children = toDom(doc, node.children ?? []);
    if (!attrs) return children;
    const element = doc.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value === true ? "" : value);
    if (!isVoidTag(tag)) element.append(...children);
    return [element];
  });
}

/** The first element of `toDom(nodes)`, or a `div` holding them all when there are several. */
export function toElement(doc: Document, nodes: VNode | readonly VNode[]): HTMLElement {
  const built = toDom(doc, nodes);
  return built.length == 1 && built[0]?.nodeType == 1 ? (built[0] as HTMLElement) : el(doc, "div", null, built);
}

/** Children for `append`: nested lists flattened, empty ones dropped. */
export function kids(children: readonly ElChild[]): Array<Node | string> {
  return (children as unknown[]).flat(9).filter((child) => child != null && child !== false) as Array<Node | string>;
}

/** `href`/`src` for page code: relative URLs, or absolute ones with a safe scheme. */
function pageUrl(value: unknown): string | null {
  if (typeof value != "string") return null;
  // Browsers drop controls and spaces around and inside the scheme, so look for one without them.
  const probe = value.replace(/[\u0000-\u0020\u007f]/g, "");
  return !probe ? null : /^[a-z][a-z0-9+.-]*:/i.test(probe) ? safeUrl(value.trim(), ["https", "http", "mailto", "tel"]) : value.trim();
}

/**
 * `ravi.el(tag, props, ...children)`: an element for page code. Props that the
 * element has are assigned (`textContent`, `className`, `hidden`, ...),
 * functions on `on*` names become listeners (other `on*` values are
 * ignored), `dataset`/`style` objects merge, anything else is an attribute.
 * HTML-writing props are ignored and URL props are sanitized; children are
 * nodes or text.
 */
export function el(doc: Document, tag: string, props?: Record<string, unknown> | null, ...children: ElChild[]): HTMLElement {
  const node = doc.createElement(tag) as HTMLElement & Record<string, unknown>;
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value == null || /^(innerHTML|outerHTML|insertAdjacentHTML|srcdoc|setHTML.*)$/i.test(name)) continue;
    if (/^(href|src|action|formaction|poster|srcset|data|xlink:href)$/i.test(name)) {
      const url = pageUrl(value);
      if (url) node.setAttribute(name.toLowerCase(), url);
    } else if (/^on/i.test(name)) {
      if (typeof value == "function") node.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
    } else if ((name == "dataset" || name == "style") && typeof value == "object") Object.assign(node[name] as object, value);
    else if (name in node) node[name] = value;
    else if (value !== false) node.setAttribute(name, value === true ? "" : String(value));
  }
  node.append(...kids(children));
  return node;
}

/** `[name="value"]` with the value escaped. */
export const sel = (name: string, value: string) => `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;

// ---------------------------------------------------------------------------
// Focus across re-renders

/** Where focus was: selectors for its record (`data-ravi-item`) and the control inside it ("" when none; a multi_select editor's option first). */
export type FocusKey = string[];

export function focusKey(root: Element, active: Element | null): FocusKey | null {
  if (!active || active == root || !root.contains(active)) return null;
  return ["data-ravi-item", "data-ravi-action", "data-ravi-opt", "data-ravi-edit", "data-ravi-op", "data-ravi-decide"].map((name) => {
    const holder = active.closest(`[${name}]`);
    return holder && root.contains(holder) ? sel(name, holder.getAttribute(name) ?? "") : "";
  });
}

/** Focuses the same control (or its record, or `fallback`) after a re-render. */
export function restoreFocus(root: Element, key: FocusKey | null, fallback: Element) {
  if (!key) return;
  const [item, ...controls] = key;
  const scope = item ? root.querySelector(item) : root;
  const control = controls.find(Boolean);
  focusEl((scope && control && scope.querySelector(control)) || (scope != root && scope) || fallback);
}

/** Focuses `target`, making it focusable from script first when it is not a control. */
export function focusEl(target: Element) {
  if (!target.matches(FOCUSABLE)) target.setAttribute("tabindex", "-1");
  (target as HTMLElement).focus();
}
