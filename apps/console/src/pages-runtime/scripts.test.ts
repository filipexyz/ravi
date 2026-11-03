import { afterEach, describe, expect, test } from "bun:test";

import { el, orderWidget, text } from "@/shared/widgets/render/test-fixtures";
import { escapeInlineScript, widgetScriptElementId } from "@/shared/widgets/script/inline";
import type { CompiledWidget } from "@/shared/widgets/types";

import { describeOutput, FakeBase, kitFor, openPage, sampleRows, VIEW_ID, type Page } from "./test-harness";

let page: Page | null = null;

afterEach(async () => {
  await page?.close();
  page = null;
});

const SHA = "ab".repeat(32);

function scriptWidget(sha = SHA): CompiledWidget {
  const widget = orderWidget({ script: { sha256: sha, bytes: 10 } });
  widget.variants.default = [el("ravi-card", {}, el("ravi-title", {}, { k: "expr", path: ["titulo"], filters: [] }), el("ravi-canvas", { label: "Gráfico" }), text(" "))];
  return widget;
}

const codeTag = (code: string, sha = SHA) => `<script type="text/plain" id="${widgetScriptElementId(sha)}" data-ravi-widget="org/pedido-card@1">${escapeInlineScript(code)}</script>`;

type Log = { calls: [string, ...unknown[]][]; mount: (card: HTMLElement, ctx: Record<string, unknown>) => unknown };

/** A module registry by code: what `importModule` resolves to, and every call it got. */
function modules(mount: Log["mount"]) {
  const imports: string[] = [];
  return {
    imports,
    importModule: async (code: string) => {
      imports.push(code);
      return { mount };
    },
  };
}

async function openView(mount: Log["mount"], opts: { importModule?: (code: string) => Promise<{ mount?: unknown }>; capture?: boolean } = {}) {
  const registry = modules(mount);
  page = await openPage({
    body: `<ravi-view data-ravi-id="r1" view="${VIEW_ID}"></ravi-view>${codeTag("export function mount() {}")}`,
    kit: kitFor({}, { r1: { widget: "w1", fields: { titulo: "titulo", status: "status", valor: "valor" } } }, { w1: scriptWidget() }),
    fake: new FakeBase(describeOutput(), sampleRows()),
    capture: opts.capture,
    install: { importModule: opts.importModule ?? registry.importModule },
  });
  await page.ravi.ready;
  await page.flush();
  return { p: page, imports: registry.imports };
}

const viewHost = (p: Page) => p.doc.querySelector("ravi-view") as HTMLElement;
const card = (p: Page, rowId: string) => viewHost(p).querySelector(`[data-ravi-item="${rowId}"] > [data-ravi-row]`) as HTMLElement;

describe("widget.js in <ravi-view>", () => {
  test("mount runs once per card with a frozen ctx; the module is imported once per sha", async () => {
    const mounted: [HTMLElement, Record<string, unknown>][] = [];
    const { p, imports } = await openView((node, ctx) => {
      mounted.push([node, ctx]);
      (ctx.canvas as (i?: number) => HTMLElement).call(null).textContent = `desenho ${(ctx.record as { id: string }).id}`;
    });
    expect(imports).toEqual(["export function mount() {}"]);
    expect(mounted.map(([node]) => node.getAttribute("data-ravi-row"))).toEqual(["r1", "r2", "r3"]);
    const [node, ctx] = mounted[0] as [HTMLElement, Record<string, unknown>];
    expect(node).toBe(card(p, "r1"));
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(ctx.record).toEqual({ id: "r1", values: expect.objectContaining({ titulo: "Pedido 1", valor: 10 }) });
    expect(ctx.fields).toEqual(scriptWidget().fields);
    expect(ctx.locale).toBe("pt-BR");
    expect(ctx.mode).toBe("light");
    expect((ctx.canvas as (i: number) => HTMLElement | null)(1)).toBeNull();
    const canvas = node.querySelector(".ravi-canvas") as HTMLElement;
    expect(canvas.getAttribute("role")).toBe("region");
    expect(canvas.getAttribute("aria-label")).toBe("Gráfico");
    expect(canvas.textContent).toBe("desenho r1");
    (ctx.announce as (text: string) => void)("Gráfico pronto");
    expect(p.announced()).toBe("Gráfico pronto");
    expect((ctx.el as (tag: string) => HTMLElement)("span").tagName).toBe("SPAN");
  });

  test("update runs when a card's record changes; the card and what the code drew survive the re-render", async () => {
    const updates: unknown[] = [];
    const { p } = await openView((node, ctx) => {
      (ctx.canvas as () => HTMLElement)().textContent = "desenhado";
      return { update: (next: { record: { id: string; values: Record<string, unknown> } }) => updates.push([next.record.id, next.record.values.titulo]) };
    });
    const before = card(p, "r2");
    const view = p.rt.views.get(VIEW_ID);
    await view?.update("r2", { titulo: "Pedido 2 (novo)" }, { target: viewHost(p) });
    await p.flush();
    expect(updates).toContainEqual(["r2", "Pedido 2 (novo)"]);
    expect(updates.some((entry) => (entry as string[])[0] != "r2")).toBe(false);
    expect(card(p, "r2")).toBe(before);
    expect(before.querySelector(".ravi-title")?.textContent).toBe("Pedido 2 (novo)");
    expect(before.querySelector(".ravi-canvas")?.textContent).toBe("desenhado");
  });

  test("destroy runs when a card leaves and for every card when the element is removed", async () => {
    const destroyed: string[] = [];
    const { p } = await openView((_node, ctx) => ({ destroy: () => destroyed.push((ctx.record as { id: string }).id) }));
    const view = p.rt.views.get(VIEW_ID);
    await view?.archive("r1", { target: viewHost(p) });
    await p.flush();
    expect(destroyed).toEqual(["r1"]);
    viewHost(p).remove();
    await p.flush();
    expect(destroyed.sort()).toEqual(["r1", "r2", "r3"]);
  });

  test("a throwing mount reports ravi:error on its card only; other cards keep their code", async () => {
    const errors: Record<string, unknown>[] = [];
    const mounted: string[] = [];
    const { p } = await openView((_node, ctx) => {
      const id = (ctx.record as { id: string }).id;
      if (id == "r2") throw new Error("boom");
      mounted.push(id);
      return { update: () => { throw new Error("update boom"); } };
    });
    p.doc.addEventListener("ravi:error", (event) => errors.push({ target: (event.target as HTMLElement).getAttribute("data-ravi-row"), ...(event as CustomEvent).detail }));
    // Mount errors fired before the listener: re-run a render with a changed record to see an update error too.
    await p.rt.views.get(VIEW_ID)?.update("r1", { titulo: "x" }, { target: viewHost(p) });
    await p.flush();
    expect(mounted).toEqual(["r1", "r3"]);
    expect(errors).toContainEqual(expect.objectContaining({ target: "r1", kind: "widget_script", code: "widget_script", widget: "org/pedido-card@1" }));
    expect(card(p, "r2").querySelector(".ravi-title")?.textContent).toBe("Pedido 2");
    expect(card(p, "r3").querySelector(".ravi-title")?.textContent).toBe("Pedido 3");
  });

  test("a failed import reports ravi:error on each card and leaves the static cards", async () => {
    const errors: string[] = [];
    let fail!: (error: Error) => void;
    const pending = new Promise<{ mount?: unknown }>((_ok, ko) => (fail = ko));
    const { p } = await openView(() => {}, { importModule: () => pending });
    p.doc.addEventListener("ravi:error", (event) => errors.push(`${(event.target as HTMLElement).getAttribute("data-ravi-row")}:${(event as CustomEvent).detail.kind}`));
    fail(new SyntaxError("bad module"));
    await p.flush();
    expect(errors.sort()).toEqual(["r1:widget_script", "r2:widget_script", "r3:widget_script"]);
    expect(card(p, "r1").querySelector(".ravi-title")?.textContent).toBe("Pedido 1");
  });

  test("onModeChange follows data-theme on <html>; unsubscribe stops it", async () => {
    const seen: string[] = [];
    const sub: { off?: () => void } = {};
    const { p } = await openView((_node, ctx) => {
      if ((ctx.record as { id: string }).id == "r1") sub.off = (ctx.onModeChange as (fn: (mode: string) => void) => () => void)((mode) => seen.push(mode));
    });
    p.doc.documentElement.setAttribute("data-theme", "dark");
    await p.flush();
    expect(seen).toEqual(["dark"]);
    sub.off?.();
    p.doc.documentElement.setAttribute("data-theme", "light");
    await p.flush();
    expect(seen).toEqual(["dark"]);
  });
});

describe("widget.js in <ravi-widget>", () => {
  const tag = `<ravi-widget data-ravi-id="r1" use="org/pedido-card" data='${JSON.stringify({ titulo: "Pedido 9", valor: 5 })}'></ravi-widget>`;

  test("mounts on the card root with the static record; destroy on removal", async () => {
    const calls: unknown[] = [];
    page = await openPage({
      body: tag + codeTag("x"),
      kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: scriptWidget() }),
      install: {
        importModule: async () => ({
          mount: (node: HTMLElement, ctx: { record: { values: Record<string, unknown> } }) => {
            calls.push(["mount", node.className, ctx.record.values.titulo]);
            return { destroy: () => calls.push(["destroy"]) };
          },
        }),
      },
    });
    await page.ravi.ready;
    await page.flush();
    expect(calls).toEqual([["mount", "ravi-card", "Pedido 9"]]);
    page.doc.querySelector("ravi-widget")?.remove();
    await page.flush();
    expect(calls).toEqual([["mount", "ravi-card", "Pedido 9"], ["destroy"]]);
  });

  test("a capture browser runs no code; a module without mount is a widget_script error", async () => {
    let imported = 0;
    page = await openPage({
      body: tag + codeTag("x"),
      capture: true,
      kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: scriptWidget() }),
      install: { importModule: async () => ((imported += 1), {}) },
    });
    await page.ravi.ready;
    await page.flush();
    expect(imported).toBe(0);
    await page.close();

    const errors: unknown[] = [];
    page = await openPage({
      body: tag + codeTag("x"),
      kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: scriptWidget() }),
      before: (win) => win.document.addEventListener("ravi:error", (event) => errors.push((event as unknown as CustomEvent).detail.kind)),
      install: { importModule: async () => ({}) },
    });
    await page.ravi.ready;
    await page.flush();
    expect(errors).toEqual(["widget_script"]);
  });

  test("the code missing from the page is a widget_script error, not a crash", async () => {
    const errors: unknown[] = [];
    page = await openPage({
      body: tag,
      kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: scriptWidget() }),
      before: (win) => win.document.addEventListener("ravi:error", (event) => errors.push((event as unknown as CustomEvent).detail.kind)),
      install: { importModule: async () => ({ mount: () => {} }) },
    });
    await page.ravi.ready;
    await page.flush();
    expect(errors).toEqual(["widget_script"]);
    expect(page.doc.querySelector("ravi-widget .ravi-title")?.textContent).toBe("Pedido 9");
  });

  test("the default importer loads real module code (data URL stand-in for the blob URL)", async () => {
    const holder = globalThis as unknown as { __raviWidgetTest?: string[] };
    holder.__raviWidgetTest = [];
    page = await openPage({
      body: tag + codeTag("export const mount = (card, ctx) => { globalThis.__raviWidgetTest.push(ctx.record.values.titulo + '</script>'); };"),
      kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: scriptWidget() }),
      install: { importModule: (code) => import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) },
    });
    await page.ravi.ready;
    await page.flush();
    // The escaped `<\/script` reads back as `</script` in a JavaScript string.
    expect(holder.__raviWidgetTest).toEqual(["Pedido 9</script>"]);
    delete holder.__raviWidgetTest;
  });
});
