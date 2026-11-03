// Widget code (`widget.js`, JS-CONTRACT section 5). The page kit inlines each
// script once per file as `<script type="text/plain" id="ravi-widget-js-…">`;
// after a card of that widget renders, the runtime imports the module once
// per sha (a blob URL) and calls `mount(card, ctx)`. It may return
// `{ update(ctx), destroy() }`: `update` runs when the card's record changes,
// `destroy` when the card leaves the page. The template part of a card is
// re-rendered from state; a re-render keeps the mounted card element and its
// `ravi-canvas` regions (where the code draws) and swaps the rest. A throw
// or a failed import fires `ravi:error` (kind `widget_script`) on the card,
// leaves the static card as it is and never touches other cards. Captures
// (`rt.capture`) run no code.

import { widgetScriptElementId } from "@/shared/widgets/script/inline";
import type { CompiledWidget, RenderRecord } from "@/shared/widgets/types";

import type { Rt } from "./runtime";

type Instance = { update?: (ctx: unknown) => void; destroy?: () => void };
type ModeFn = (mode: "light" | "dark") => void;
type Mounted = { card: HTMLElement; sig: string; record: RenderRecord; inst: Instance | null; gone: boolean; modes: Set<ModeFn> };

/** One rendered card: its element, a key stable across renders (the row id), and its record. */
export type ScriptCard = [card: HTMLElement, key: string, record: RenderRecord];
export type CardScripts = { sync(cards: ScriptCard[]): void; stop(): void };

const modules = new WeakMap<Rt, Map<string, Promise<{ mount?: unknown }>>>();
const modeWatchers = new WeakMap<Rt, Set<ModeFn>>();

const CANVAS = "data-ravi-canvas";

/** The module of `sha`, imported once per page. */
function load(rt: Rt, sha: string) {
  let cache = modules.get(rt);
  if (!cache) modules.set(rt, (cache = new Map()));
  let loaded = cache.get(sha);
  if (!loaded) {
    const code = rt.doc.getElementById(widgetScriptElementId(sha))?.textContent;
    loaded = code == null ? Promise.reject(new Error("widget code missing from the page")) : rt.importModule(code);
    cache.set(sha, loaded);
  }
  return loaded;
}

export function modeOf(rt: Rt): "light" | "dark" {
  const set = rt.doc.documentElement.getAttribute("data-theme");
  if (set == "light" || set == "dark") return set;
  return rt.win.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Listeners for light/dark changes: `data-theme` on `<html>` (`ravi.theme.setMode`) and the system setting. */
function watchMode(rt: Rt) {
  let set = modeWatchers.get(rt);
  if (!set) {
    const listeners = new Set<ModeFn>();
    modeWatchers.set(rt, (set = listeners));
    let last = modeOf(rt);
    const check = () => {
      const next = modeOf(rt);
      if (next == last) return;
      last = next;
      listeners.forEach((fn) => fn(next));
    };
    new rt.win.MutationObserver(check).observe(rt.doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    rt.win.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", check);
  }
  return set;
}

/** Scripts for the cards of one tag, or null when the widget has no code (or this is a capture). */
export function cardScripts(rt: Rt, widget: CompiledWidget | null): CardScripts | null {
  const script = widget?.script;
  if (!widget || !script || rt.capture) return null;
  const mounted = new Map<string, Mounted>();
  const label = widget.ref ? `${widget.ref.ref}@${widget.ref.version}` : widget.name;

  const fail = (m: Mounted, error: unknown) => {
    rt.fire(m.card, "ravi:error", { kind: "widget_script", code: "widget_script", widget: label, error });
  };

  const guard = (m: Mounted, run: () => void) => {
    try {
      run();
    } catch (error) {
      fail(m, error);
    }
  };

  const ctx = (m: Mounted) =>
    Object.freeze({
      record: Object.freeze({ id: m.record.id, values: Object.freeze({ ...m.record.values }) }),
      fields: widget.fields,
      canvas: (index = 0) => m.card.querySelector<HTMLElement>(`[${CANVAS}="${Number(index)}"]`),
      locale: rt.locale,
      timeZone: rt.timeZone,
      mode: modeOf(rt),
      theme: (name: string) => rt.win.getComputedStyle(m.card).getPropertyValue(name).trim(),
      announce: (text: string) => rt.announce(String(text)),
      el: rt.api.el,
      onModeChange: (fn: ModeFn) => {
        const call: ModeFn = (mode) => guard(m, () => fn(mode));
        m.modes.add(call);
        watchMode(rt).add(call);
        return () => {
          m.modes.delete(call);
          watchMode(rt).delete(call);
        };
      },
    });

  const start = (m: Mounted) => {
    load(rt, script.sha256).then(
      (module) => {
        if (m.gone) return;
        guard(m, () => {
          if (typeof module.mount != "function") throw new Error("widget.js exports no mount");
          const out = (module.mount as (card: HTMLElement, ctx: unknown) => unknown)(m.card, ctx(m));
          m.inst = out && typeof out == "object" ? (out as Instance) : {};
        });
        m.inst ??= {};
      },
      (error) => fail(m, error),
    );
  };

  const destroy = (m: Mounted) => {
    m.gone = true;
    m.modes.forEach((fn) => watchMode(rt).delete(fn));
    if (typeof m.inst?.destroy == "function") guard(m, () => m.inst?.destroy?.());
  };

  /** Keeps the mounted card element and its canvases; the new render's template part replaces the rest. */
  const adopt = (m: Mounted, card: HTMLElement) => {
    card.querySelectorAll<HTMLElement>(`[${CANVAS}]`).forEach((fresh) => {
      const kept = m.card.querySelector<HTMLElement>(`[${CANVAS}="${fresh.getAttribute(CANVAS)}"]`);
      if (!kept) return;
      for (const name of fresh.getAttributeNames()) kept.setAttribute(name, fresh.getAttribute(name) ?? "");
      fresh.replaceWith(kept);
    });
    for (const name of m.card.getAttributeNames()) if (!card.hasAttribute(name)) m.card.removeAttribute(name);
    for (const name of card.getAttributeNames()) m.card.setAttribute(name, card.getAttribute(name) ?? "");
    m.card.replaceChildren(...Array.from(card.childNodes));
    card.replaceWith(m.card);
  };

  return {
    sync(cards) {
      const seen = new Set<string>();
      for (const [card, key, record] of cards) {
        seen.add(key);
        const sig = JSON.stringify([record.id, record.version, record.values]);
        const m = mounted.get(key);
        if (!m) {
          const fresh: Mounted = { card, sig, record, inst: null, gone: false, modes: new Set() };
          mounted.set(key, fresh);
          start(fresh);
          continue;
        }
        if (m.card != card) adopt(m, card);
        if (sig != m.sig) {
          m.sig = sig;
          m.record = record;
          if (typeof m.inst?.update == "function") guard(m, () => m.inst?.update?.(ctx(m)));
        }
      }
      for (const [key, m] of mounted) {
        if (seen.has(key)) continue;
        mounted.delete(key);
        destroy(m);
      }
    },
    stop() {
      mounted.forEach(destroy);
      mounted.clear();
    },
  };
}
