// Regression: the runtime sits in `<head>`, so a browser connects each kit
// tag before the parser reaches its children (the ship's prerender). The
// mount used to run at that moment, render into the empty tag, and the parser
// then appended the prerender after it: two cards with the same data. These
// tests ship a real page through the kit build and replay its body the way a
// parser does (each element connected empty, then its children) while the
// document is still loading.

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { buildPageKit, type KitLibrarySource } from "@/server/console/pages/kit/build";

import { install } from "./runtime";
import { describeOutput, FakeBase, sampleRows, VIEW_ID } from "./test-harness";

const WIDGET: KitLibrarySource = {
  itemId: "33333333-3333-4333-8333-333333333333",
  ref: "org/pedido-card",
  version: 1,
  files: [
    {
      path: "widget.json",
      content: JSON.stringify({ name: "Cartão de pedido", description: "Pedido com valor.", fields: { titulo: { type: "text", required: true }, valor: { type: "number", label: "Valor" } } }),
    },
    { path: "widget.html", content: '<ravi-card><ravi-title>{titulo}</ravi-title><ravi-metric value="{valor}" label="Valor"></ravi-metric></ravi-card>' },
  ],
};

async function ship(body: string): Promise<string> {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>T</title></head><body>${body}</body></html>`;
  const result = await buildPageKit(
    { route: "/", visibility: "private", theme: "none", files: [{ path: "index.html", html }] },
    {
      resolveTheme: async () => ({ ok: true, source: null }),
      resolveWidget: async (ref) => (ref.endsWith("pedido-card") ? { ok: true, source: WIDGET } : { ok: false, code: "KIT_WIDGET_NOT_FOUND", message: ref }),
      resolveWidgetItem: async () => ({ ok: false, code: "KIT_WIDGET_NOT_FOUND", message: "none" }),
      describeView: async () => ({ ok: true, view: describeOutput() }),
      previousPresentation: async () => null,
      // The real kit output, with a stand-in for the inlined runtime (installed below from source).
      runtime: { version: "1.0.0", js: "/* runtime */", sha256: "a".repeat(64) },
    },
  );
  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  const file = result.files[0];
  if (!file?.html) throw new Error("the kit did not rewrite the page");
  return file.html;
}

let win: Window | null = null;

afterEach(async () => {
  await win?.happyDOM.close();
  win = null;
});

/** Installs the runtime on a page still loading, then appends the body as a parser does. */
async function streamPage(shipped: string, fake = new FakeBase(describeOutput(), sampleRows())) {
  const source = new Window().document;
  source.write(shipped);
  win = new Window({ url: "https://acme-site.ravi.page/" });
  Object.defineProperty(win.navigator, "webdriver", { value: false, configurable: true });
  const doc = win.document as unknown as Document;
  doc.write(`<!doctype html><html><head>${source.head.innerHTML}</head><body></body></html>`);
  let state: DocumentReadyState = "loading";
  Object.defineProperty(doc, "readyState", { get: () => state, configurable: true });
  (win as unknown as { fetch: unknown }).fetch = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { id: string; input: Record<string, unknown> };
    const answer = fake.answer({ id: body.id, input: body.input, runtime: null });
    return "output" in answer ? new Response(JSON.stringify({ ok: true, output: answer.output })) : new Response(JSON.stringify(answer), { status: answer.status });
  };
  const rt = install(win as unknown as globalThis.Window & typeof globalThis, { sleep: async () => {}, pollMs: 60_000, random: () => 0.5 });
  const replay = (from: Node, into: Node) => {
    for (const child of Array.from(from.childNodes)) {
      const copy = child.cloneNode(false);
      into.appendChild(doc.importNode(copy, false));
      replay(child, into.lastChild as Node);
    }
  };
  replay(source.body as unknown as Node, doc.body);
  state = "interactive";
  doc.dispatchEvent(new win.Event("DOMContentLoaded") as unknown as Event);
  await (rt.api.ready as Promise<void>);
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return doc;
}

describe("hydration of a shipped page", () => {
  test("<ravi-widget> with data keeps one card (the prerender is adopted or replaced, never duplicated)", async () => {
    const shipped = await ship(`<ravi-widget use="org/pedido-card" data='{"titulo":"Pedido 7","valor":1200}'></ravi-widget>`);
    // The ship prerendered the card into the tag.
    expect(shipped).toContain('id="ravi-r1-title1"');
    const doc = await streamPage(shipped);
    const host = doc.querySelector("ravi-widget") as HTMLElement;
    expect(host.querySelectorAll("article").length).toBe(1);
    expect(host.querySelectorAll(".ravi-title").length).toBe(1);
    expect(doc.querySelectorAll("#ravi-r1-title1").length).toBe(1);
    expect(host.querySelector(".ravi-title")?.textContent).toBe("Pedido 7");
  });

  test("<ravi-view> rows replace the loading line instead of sitting next to it", async () => {
    const shipped = await ship(`<ravi-view view="${VIEW_ID}" widget="org/pedido-card"></ravi-view>`);
    expect(shipped).toContain('class="ravi-status"');
    const doc = await streamPage(shipped);
    const host = doc.querySelector("ravi-view") as HTMLElement;
    expect(host.querySelectorAll("li[data-ravi-item]").length).toBe(3);
    expect(host.querySelectorAll("article").length).toBe(3);
    expect(host.querySelector("p.ravi-status")).toBeNull();
  });

  test("a page parsed in full before the runtime runs still renders once", async () => {
    const shipped = await ship(`<ravi-widget use="org/pedido-card" data='{"titulo":"Pedido 8","valor":10}'></ravi-widget>`);
    win = new Window({ url: "https://acme-site.ravi.page/" });
    const doc = win.document as unknown as Document;
    doc.write(shipped);
    const rt = install(win as unknown as globalThis.Window & typeof globalThis, { sleep: async () => {} });
    await (rt.api.ready as Promise<void>);
    expect(doc.querySelectorAll("ravi-widget article").length).toBe(1);
  });
});
