// `<ravi-widget>` (a Library widget with static `data`) and `ravi.render()`
// for page code. The ship already prerendered the tag; the runtime renders
// the same record client-side and keeps the prerender when the DOM would be
// identical, so the page does not flash.
//
// Render context: idPrefix `ravi-<data-ravi-id>` (as the ship's prerender),
// no capabilities (so update, create and archive buttons are left out),
// interactive (an open button without href has no row to open, so it is left
// out too), heading level from `heading-level` (default 2), the viewer's
// time zone and clock. Where the prerender differs, the runtime's DOM wins.

import { normalizeStaticRecord } from "@/shared/widgets/render/static";
import { renderWidget } from "@/shared/widgets/render/widget";
import { WIDGET_VARIANTS, type CompiledWidget, type VNode, type WidgetVariant } from "@/shared/widgets/types";

import { el, toDom, toElement } from "./dom";
import { RaviError } from "./errors";
import type { Mounted, Rt } from "./runtime";
import { cardScripts } from "./scripts";

export type StaticRenderOptions = { variant?: string | null; headingLevel?: number | string | null; idPrefix?: string };

export const variantOf = (value: unknown, fallback: WidgetVariant = "default"): WidgetVariant =>
  WIDGET_VARIANTS.includes(value as WidgetVariant) ? (value as WidgetVariant) : fallback;

export function headingLevelOf(value: unknown, fallback = 2): number {
  const level = Number(value);
  return level >= 1 && level <= 6 && level % 1 == 0 ? level : fallback;
}

/** A kit widget by key, by `ref` (`org/slug`, `project/slug`) or by bare slug. */
export function findWidget(rt: Rt, ref: string | null | undefined): CompiledWidget | null {
  const all = Object.values(rt.kit.widgets);
  return (ref && (rt.kit.widgets[ref] ?? all.find((widget) => widget.ref?.ref == ref || widget.ref?.ref.split("/").pop() == ref))) || null;
}

export function staticNodes(rt: Rt, widget: CompiledWidget, data: unknown, opts: StaticRenderOptions = {}): VNode[] {
  const { record, columns, users } = normalizeStaticRecord(widget.fields, data);
  return renderWidget(widget, record, {
    ...rt.base(),
    users,
    columns,
    can: { write: new Set(), create: false, archive: false },
    variant: variantOf(opts.variant),
    headingLevel: headingLevelOf(opts.headingLevel),
    idPrefix: opts.idPrefix ?? rt.uid("w"),
    interactive: true,
  });
}

/** `ravi.render(widgetRef, record, opts)`: an element for static data. */
export function renderStatic(rt: Rt, ref: string, data: unknown, opts?: StaticRenderOptions): HTMLElement {
  const widget = findWidget(rt, ref);
  if (!widget) throw new RaviError("not_found");
  return toElement(rt.doc, staticNodes(rt, widget, data, opts));
}

export function mountWidget(rt: Rt, host: HTMLElement): Mounted {
  const { doc, kit } = rt;
  const id = host.getAttribute("data-ravi-id");
  const instance = id ? kit.instances[id] : undefined;
  const widget = (instance?.widget && kit.widgets[instance.widget]) || findWidget(rt, host.getAttribute("use"));
  const scripts = cardScripts(rt, widget);
  try {
    if (widget) {
      const data: unknown = JSON.parse(host.getAttribute("data") ?? "{}");
      const nodes = staticNodes(rt, widget, data, {
        variant: host.getAttribute("variant") ?? instance?.variant,
        headingLevel: host.getAttribute("heading-level"),
        idPrefix: id ? `ravi-${id}` : undefined,
      });
      const probe = el(doc, "div", null, toDom(doc, nodes));
      if (probe.innerHTML != host.innerHTML) host.replaceChildren(...probe.childNodes);
      rt.fire(host, "ravi:render", {});
      const card = host.firstElementChild as HTMLElement | null;
      if (card) scripts?.sync([[card, "", normalizeStaticRecord(widget.fields, data).record]]);
    }
  } catch {
    // Unreadable `data`: the prerender stays (and runs no code).
  }
  return { first: Promise.resolve(), stop: () => scripts?.stop() };
}
