// `ravi.js`, the Pages runtime `ravi pages ship` inlines in pages that use
// `<ravi-view>`, `<ravi-widget>`, `<ravi-form>` or `<ravi-chart>` (a file
// with only a live theme gets the small `theme-live.ts` instead). It reads the
// page kit from `#ravi-kit`, merges its API into `window.ravi` without
// replacing what is there (Page Chat defines `ravi.chat`), and defines the
// four elements (light DOM). See CONTRACT section 6 and `.ravi/specs/console/widgets/SPEC.md`.
//
// Everything goes through the window passed to `install`, so tests run the
// source against a happy-dom window. Written as closures: the bundle has a
// size budget (scripts/build-pages-runtime.ts) and minifiers shorten local
// names, not properties.

import { messages, type RuntimeMessages } from "@/shared/widgets/render/messages";
import { PAGE_KIT_TAGS, type FieldDisplayRules, type PageKit, type RenderContext } from "@/shared/widgets/types";

import { chartHandle, CHART_MS, mountChart, type ChartHandle } from "./chart";
import { el, type ElChild } from "./dom";
import { asRaviError, RaviError } from "./errors";
import { createExec, type ExecClient } from "./exec";
import { mountForm } from "./form";
import { readKit } from "./kit";
import { defaultDisplayRules } from "./records";
import { setupTheme, type RaviTheme } from "./theme";
import { createAnnouncer, createStatus, type Announcer, type StatusLine } from "./ui";
import { RUNTIME_VERSION } from "./version";
import { createView, LIVE_POLL_MS, POLL_MS, type View, type ViewOp } from "./view";
import { mountView } from "./view-element";
import { mountWidget, renderStatic, type StaticRenderOptions } from "./widget";

export type InstallOptions = {
  /** Waits between retries and for the exec budget (tests pass a fast one). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  pollMs?: number;
  /** Near-live fingerprint poll (`ravi.bases.views.version`); default 5 s. */
  livePollMs?: number;
  /** `<ravi-chart>` re-read interval; default 60 s. */
  chartMs?: number;
  /** Imports a widget's code as an ES module (tests pass one that skips blob URLs). */
  importModule?: (code: string) => Promise<{ mount?: unknown }>;
};

export type ReportContext = { target?: EventTarget | null; view?: View | null; op?: ViewOp; quiet?: boolean };

export type RaviApi = {
  version: string;
  ready: Promise<void>;
  exec: (id: string, input?: unknown, opts?: { quiet?: boolean }) => Promise<unknown>;
  bases: { view: (id: string) => View; chart: (id: string) => ChartHandle };
  el: (tag: string, props?: Record<string, unknown> | null, ...children: ElChild[]) => HTMLElement;
  theme: RaviTheme;
  render: (widgetRef: string, data: unknown, opts?: StaticRenderOptions) => HTMLElement;
};

/** What a mounted element gives its custom element class; `attr` hears its observed attributes change. */
export type Mounted = { first: Promise<void>; stop?: () => void; on?: (event: Event) => void; attr?: (name: string) => void };

export type Rt = {
  win: Window & typeof globalThis;
  doc: Document;
  kit: PageKit;
  locale: string;
  msgs: RuntimeMessages;
  rules: FieldDisplayRules;
  timeZone: string;
  exec: ExecClient;
  live: Announcer;
  status: StatusLine;
  /** A capture/thumbnail browser (WebDriver): Bases refuses it, so components stay neutral and report nothing. */
  capture: boolean;
  pollMs: number;
  livePollMs: number;
  chartMs: number;
  views: Map<string, View>;
  now: () => number;
  sessionExpired: boolean;
  api: RaviApi;
  /** Imports a widget's `widget.js` (a blob URL by default). */
  importModule(code: string): Promise<{ mount?: unknown }>;
  uid(prefix: string): string;
  view(id: string): View;
  /** A chart handle whose `data()` does not report (the element reports itself). */
  chart(id: string): ChartHandle;
  announce(text: string): void;
  /** Dispatches a bubbling `ravi:*` event on `target` (default: the document); false when a listener canceled it. */
  fire(target: EventTarget | null | undefined, type: string, detail: Record<string, unknown>, cancelable?: boolean): boolean;
  /** Inline text for a component that could not load. */
  stateText(error: RaviError): string;
  /** `ravi:error` on the target, then (unless quiet) what the person sees: `show`. */
  report(error: RaviError, ctx?: ReportContext): void;
  /**
   * The page's reaction by kind: session expiry and paused data in the
   * status line, denied actions hidden, failed writes announced and shown.
   */
  show(error: RaviError, ctx?: ReportContext): void;
  /** The locale, time zone, clock and display rules every render uses. */
  base(): Pick<RenderContext, "locale" | "timeZone" | "now" | "fields">;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Defines `tag` once: `mount` runs on connect, its `stop` on disconnect; events reach `on`.
 * The runtime sits in `<head>`, so the parser connects a tag before its
 * children (the ship's prerender) are parsed: while the document is still
 * loading, mounting waits for DOMContentLoaded, so the mount sees (and
 * replaces or keeps) the prerender instead of rendering next to it.
 */
function defineTag(rt: Rt, tag: string, mount: (rt: Rt, host: HTMLElement) => Mounted, observed: string[] = []) {
  const { win, doc } = rt;
  if (win.customElements.get(tag)) return;
  win.customElements.define(
    tag,
    class extends win.HTMLElement {
      static observedAttributes = observed;
      m?: Mounted;
      first?: Promise<void>;
      attributeChangedCallback(name: string, before: string | null, after: string | null) {
        if (before !== after) this.m?.attr?.(name);
      }
      constructor() {
        super();
        for (const type of ["click", "change", "keydown", "dragstart", "dragover", "drop"]) this.addEventListener(type, (event) => this.m?.on?.(event));
      }
      connectedCallback() {
        const start = () => (this.m ??= this.isConnected ? mount(rt, this) : undefined)?.first;
        if (doc.readyState != "loading") this.first = start();
        else if (!this.m) this.first = new Promise<void>((ok) => doc.addEventListener("DOMContentLoaded", () => ok(start()), { once: true }));
      }
      disconnectedCallback() {
        this.m?.stop?.();
        this.m = undefined;
      }
    },
  );
}

const installed = new WeakMap<object, Rt>();

/** Installs the runtime on `win` once; later calls return the same runtime. */
export function install(win: Window & typeof globalThis, options: InstallOptions = {}): Rt {
  const known = installed.get(win);
  if (known) return known;
  const doc = win.document;
  const root = doc.documentElement;
  const kit = readKit(doc);
  const locale = kit.locale || kit.theme?.locale || root.lang || "pt-BR";
  const msgs = messages(locale);
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((ok) => win.setTimeout(ok, ms)));
  const capture = win.navigator?.webdriver === true;
  const views = new Map<string, View>();
  const live = createAnnouncer(doc);
  const status = createStatus(doc, msgs, () => win.location.reload());
  const exec = createExec(kit, { fetch: (input, init) => win.fetch(input, init), sleep, now, random: options.random ?? Math.random, version: RUNTIME_VERSION });
  const rules = kit.theme?.fields ?? defaultDisplayRules();
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let seq = 0;

  const announce = (text: string) => {
    if (!capture) live.say(text);
  };

  const show = (error: RaviError, ctx: ReportContext = {}) => {
    const { kind } = error;
    const write = /^(update|create|archive)$/.test(ctx.op ?? "");
    if (kind == "session") {
      rt.sessionExpired = true;
      status.show("session", msgs.sessionExpired);
      views.forEach((view) => view.notify());
    } else if (kind == "paused") {
      for (const view of ctx.view ? [ctx.view] : views.values()) {
        view.paused = true;
        view.notify();
      }
      status.show("paused", msgs.paused);
      announce(msgs.paused);
    } else if (kind == "denied" || kind == "consent") {
      // A refused approval decision says nothing about the viewer's other writes.
      if (ctx.view && ctx.op && error.code != "approval_forbidden") ctx.view.deny(ctx.op);
      announce(msgs.denied);
    } else if (kind == "gone") announce(msgs.unavailable);
    else {
      const text = kind == "unsupported" ? msgs.unsupported : kind == "link" ? msgs.linkRequired : write ? msgs.writeFailed : msgs.error;
      announce(text);
      if (write || kind == "unsupported" || kind == "link") status.show("error", text);
    }
  };

  const fire = (target: EventTarget | null | undefined, type: string, detail: Record<string, unknown>, cancelable = false) =>
    (target ?? doc).dispatchEvent(new win.CustomEvent(type, { detail, bubbles: true, cancelable }));

  const report = (error: RaviError, ctx: ReportContext = {}) => {
    if (capture) return;
    fire(ctx.target, "ravi:error", { error, code: error.code, kind: error.kind });
    if (!ctx.quiet) show(error, ctx);
  };

  const view = (id: string) => {
    const key = String(id ?? "").trim().toLowerCase();
    if (!UUID.test(key)) throw new RaviError("payload_invalid");
    if (!views.has(key)) views.set(key, createView(rt, key));
    return views.get(key) as View;
  };

  const rt: Rt = {
    win,
    doc,
    kit,
    locale,
    msgs,
    rules,
    timeZone,
    exec,
    live,
    status,
    capture,
    pollMs: options.pollMs ?? POLL_MS,
    livePollMs: options.livePollMs ?? LIVE_POLL_MS,
    chartMs: options.chartMs ?? CHART_MS,
    views,
    now,
    sessionExpired: false,
    api: null as unknown as RaviApi,
    importModule:
      options.importModule ??
      (async (code) => {
        const url = win.URL.createObjectURL(new win.Blob([code], { type: "text/javascript" }));
        try {
          return await import(/* @vite-ignore */ url);
        } finally {
          win.URL.revokeObjectURL(url);
        }
      }),
    uid: (prefix) => `ravi-${prefix}${(seq += 1)}`,
    view,
    chart: (id) => chartHandle(id, UUID, exec.exec),
    announce,
    fire,
    stateText: (error) =>
      ({ denied: msgs.noPermission, consent: msgs.noPermission, gone: msgs.unavailable, session: msgs.sessionExpired, paused: msgs.paused, unsupported: msgs.unsupported, link: msgs.linkRequired } as Record<string, string>)[
        error.kind
      ] ?? msgs.error,
    report,
    show,
    base: () => ({ locale, timeZone, now: new Date(now()), fields: rules }),
  };
  installed.set(win, rt);

  if (!root.getAttribute("lang") && kit.locale) root.setAttribute("lang", kit.locale);

  const ready = new Promise<void>((parsed) => (doc.readyState == "loading" ? doc.addEventListener("DOMContentLoaded", () => parsed()) : parsed())).then(async () => {
    live.ensure();
    // A tag moved before its first render settles its old mount and starts a new one: wait for the newest.
    await Promise.all(
      Array.from(doc.querySelectorAll(PAGE_KIT_TAGS.join(",")), async (tag) => {
        const holder = tag as { first?: Promise<void> };
        let at: Promise<void> | undefined;
        while (at != holder.first) await (at = holder.first);
      }),
    );
  });

  const api: RaviApi = (rt.api = {
    version: RUNTIME_VERSION,
    ready,
    exec: (id, input, opts) =>
      exec.exec(id, input ?? {}).catch((thrown: unknown) => {
        const error = asRaviError(thrown);
        report(error, { quiet: opts?.quiet });
        throw error;
      }),
    bases: {
      view,
      chart: (id) => chartHandle(id, UUID, (one, input) => api.exec(one, input)),
    },
    el: (tag, props, ...children) => el(doc, tag, props, ...children),
    theme: setupTheme(rt),
    render: (ref, data, opts) => renderStatic(rt, ref, data, opts),
  });
  const holder = win as unknown as { ravi?: Record<string, unknown> };
  const target = holder.ravi && typeof holder.ravi == "object" ? holder.ravi : {};
  for (const [key, value] of Object.entries(api)) {
    const existing = target[key];
    target[key] = key == "bases" && existing && typeof existing == "object" ? Object.assign(existing, value) : value;
  }
  holder.ravi = target;

  doc.addEventListener("visibilitychange", () => doc.hidden || views.forEach((one) => void one.tick()));
  defineTag(rt, "ravi-view", mountView, ["where", "search", "sort"]);
  defineTag(rt, "ravi-widget", mountWidget);
  defineTag(rt, "ravi-form", mountForm);
  defineTag(rt, "ravi-chart", mountChart, ["chart"]);
  return rt;
}
