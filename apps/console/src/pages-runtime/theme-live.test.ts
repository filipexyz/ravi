// The theme-live script as the kit inlines it (`PAGES_THEME_LIVE_JS`), run in
// a happy-dom window with a mocked exec endpoint.

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { PAGES_RUNTIME_JS, PAGES_THEME_LIVE_JS } from "@/server/console/pages/kit/runtime.generated";
import type { KitTheme, PageKit } from "@/shared/widgets/types";

import { THEME_GET_ID } from "./theme";

const THEME: KitTheme = {
  ref: { itemId: "00000000-0000-4000-8000-0000000000t1", ref: "org/acme", version: 3 },
  hash: "hash-old",
  locale: "pt-BR",
  density: "comfortable",
  fields: {
    types: { status: "pill", select: "pill", multi_select: "pills", number: "number", currency: "currency", percent: "percent", date: "date", person: "avatar-name", url: "link", checkbox: "check" },
    roles: { image: "cover", avatar: "circle", highlight: "big", progress: "bar", rating: "stars" },
  },
  live: true,
};

/** What the kit puts in a file without tags on a live route: the theme, no instances, `uses` without the theme id. */
const KIT: PageKit = { v: 1, runtime: "1.0.0", locale: "pt-BR", theme: THEME, widgets: {}, instances: {}, actions: [], uses: [] };

const NEW_THEME = { hash: "hash-new", css: "@layer ravi.theme{:root{--a:2}}", locale: "pt-BR", version: 4, ref: "org/acme" };

type Call = { url: string; id: string; input: unknown; runtime: string | null };
type Scope = { ravi?: Record<string, unknown>; eval: (code: string) => unknown };

let win: Window | null = null;

afterEach(async () => {
  await win?.happyDOM.close();
  win = null;
});

/** A page with a shipped theme snapshot and the kit; closes the one opened before. */
async function open(opts: { kit?: PageKit; lang?: string; answer: () => { status: number; body: unknown }; before?: (scope: Scope) => void }) {
  await win?.happyDOM.close();
  win = new Window({ url: "https://acme-site.ravi.page/" });
  Object.defineProperty(win.navigator, "webdriver", { value: false, configurable: true });
  const json = JSON.stringify(opts.kit ?? KIT).replace(/</g, "\\u003c");
  win.document.write(
    `<!doctype html><html${opts.lang ? ` lang="${opts.lang}"` : ""}><head><meta charset="utf-8"><style id="ravi-theme" data-ravi-theme="hash-old">old</style><script type="application/json" id="ravi-kit">${json}</script></head><body><p>Conteúdo</p></body></html>`,
  );
  const calls: Call[] = [];
  (win as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: string; input: unknown };
    calls.push({ url, id: body.id, input: body.input, runtime: (init.headers as Record<string, string>)["x-ravi-runtime"] ?? null });
    const answer = opts.answer();
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const scope = win as unknown as Scope;
  opts.before?.(scope);
  const doc = win.document as unknown as Document;
  const flush = async () => {
    for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { win, doc, scope, calls, flush, style: () => doc.getElementById("ravi-theme") };
}

const ok = (output: unknown) => () => ({ status: 200, body: { ok: true, output } });

describe("theme-live script", () => {
  test("a different hash swaps #ravi-theme; one quiet ravi.pages.theme.get even though uses does not list it", async () => {
    const page = await open({ answer: ok(NEW_THEME) });
    page.scope.eval(PAGES_THEME_LIVE_JS);
    await page.flush();
    expect(page.calls).toEqual([{ url: "/_ravi/connectors/exec", id: THEME_GET_ID, input: {}, runtime: "1.1.0" }]);
    expect(page.style()?.textContent).toBe(NEW_THEME.css);
    expect(page.style()?.getAttribute("data-ravi-theme")).toBe("hash-new");
    expect(page.doc.querySelectorAll("#ravi-theme").length).toBe(1);
    // lang from the theme locale, since the document had none.
    expect(page.doc.documentElement.getAttribute("lang")).toBe("pt-BR");
    // Nothing else: no window.ravi, no elements, nothing added to the body.
    expect(page.scope.ravi).toBeUndefined();
    expect(page.win.customElements.get("ravi-view")).toBeUndefined();
    expect(page.doc.body.innerHTML).toBe("<p>Conteúdo</p>");
  });

  test("the same hash changes nothing; a lang already set stays", async () => {
    const page = await open({ lang: "en", answer: ok({ ...NEW_THEME, hash: "hash-old", css: "new css" }) });
    const style = page.style();
    page.scope.eval(PAGES_THEME_LIVE_JS);
    await page.flush();
    expect(page.calls.map((call) => call.id)).toEqual([THEME_GET_ID]);
    expect(page.style()).toBe(style);
    expect(style?.textContent).toBe("old");
    expect(page.doc.documentElement.getAttribute("lang")).toBe("en");
  });

  test("an error keeps the snapshot and shows nothing", async () => {
    for (const answer of [
      () => ({ status: 403, body: { ok: false, error: "connector_permission_required" } }),
      () => ({ status: 401, body: { ok: false, error: "connector_session_required" } }),
      () => ({ status: 200, body: { ok: true, output: { none: true } } }),
    ]) {
      const page = await open({ answer });
      page.scope.eval(PAGES_THEME_LIVE_JS);
      await page.flush();
      expect(page.calls.length).toBe(1);
      expect(page.style()?.textContent).toBe("old");
      expect(page.style()?.getAttribute("data-ravi-theme")).toBe("hash-old");
      expect(page.doc.body.innerHTML).toBe("<p>Conteúdo</p>");
      expect(page.doc.querySelector("[aria-live],[data-ravi-status]")).toBeNull();
    }
  });

  test("a theme that is not live, or a missing kit, asks nothing; Page Chat's ravi stays as it was", async () => {
    const chat = { open: () => {} };
    const page = await open({ kit: { ...KIT, theme: { ...THEME, live: false } }, answer: ok(NEW_THEME), before: (scope) => (scope.ravi = { chat }) });
    page.scope.eval(PAGES_THEME_LIVE_JS);
    await page.flush();
    expect(page.calls).toEqual([]);
    expect(page.scope.ravi).toEqual({ chat });
    const bare = await open({ answer: ok(NEW_THEME) });
    bare.doc.getElementById("ravi-kit")?.remove();
    bare.scope.eval(PAGES_THEME_LIVE_JS);
    await bare.flush();
    expect(bare.calls).toEqual([]);
  });

  test("with the full runtime on the page it does nothing, whichever script comes first", async () => {
    for (const order of [
      [PAGES_THEME_LIVE_JS, PAGES_RUNTIME_JS],
      [PAGES_RUNTIME_JS, PAGES_THEME_LIVE_JS],
    ]) {
      const page = await open({ answer: ok(NEW_THEME) });
      // Inline scripts in <head> run while the document is still loading.
      let state = "loading";
      Object.defineProperty(page.doc, "readyState", { configurable: true, get: () => state });
      for (const code of order) page.scope.eval(code);
      state = "interactive";
      page.doc.dispatchEvent(new page.win.Event("DOMContentLoaded") as unknown as Event);
      await page.flush();
      expect(page.calls.map((call) => call.id)).toEqual([THEME_GET_ID]);
      expect(page.style()?.getAttribute("data-ravi-theme")).toBe("hash-new");
      expect((page.scope.ravi?.theme as { hash: string }).hash).toBe("hash-new");
    }
  });
});
