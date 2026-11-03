import { afterEach, describe, expect, test } from "bun:test";

import { orderWidget } from "@/shared/widgets/render/test-fixtures";

import type { BaseViewColumn } from "@/shared/bases/types";

import { COLUMNS, describeOutput, FakeBase, kitFor, openPage, sampleRows, squash, VIEW_ID, type Caps, type Page } from "./test-harness";
import { BASES_IDS, type ViewRow } from "./view";

let page: Page | null = null;

afterEach(async () => {
  await page?.close();
  page = null;
});

function viewTag(attrs = "") {
  return `<ravi-view data-ravi-id="r1" view="${VIEW_ID}" ${attrs}></ravi-view>`;
}

async function open(attrs = "", layout: Record<string, unknown> = { type: "list" }, extra: Partial<Parameters<typeof openPage>[0]> = {}) {
  page = await openPage({ body: viewTag(attrs), kit: kitFor({}, { r1: {} }), fake: new FakeBase(describeOutput(layout), sampleRows()), ...extra });
  await page.ravi.ready;
  return page;
}

const host = (p: Page) => p.doc.querySelector("ravi-view") as HTMLElement;

function key(p: Page, target: Element, name: string, init: Record<string, unknown> = {}) {
  const event = new p.win.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event as unknown as Event);
  return event;
}

describe("<ravi-view> layouts", () => {
  test("list: a list of default cards, the loaded count announced, the runtime header sent", async () => {
    const p = await open();
    const list = host(p).querySelector("ul.ravi-list");
    expect(list?.getAttribute("role")).toBe("list");
    expect(list?.querySelectorAll(":scope > li[data-ravi-item]").length).toBe(3);
    expect(host(p).querySelector("h2.ravi-title")?.textContent).toBe("Pedido 1");
    expect(p.announced()).toBe("3 itens carregados.");
    expect(p.calls.map((call) => call.id)).toEqual([BASES_IDS.describe, BASES_IDS.query]);
    expect(p.calls.every((call) => call.runtime === "1.1.0")).toBe(true);
    expect(host(p).hasAttribute("aria-busy")).toBe(false);
  });

  test("where, sort and page-size become the query input; Carregar mais loads the next page and moves focus to it", async () => {
    const p = await open('where="area=Operações;status=@done;feito=true" sort="valor,-titulo" page-size="2"');
    const query = p.calls.find((call) => call.id === BASES_IDS.query);
    expect(query?.input).toEqual({
      viewId: VIEW_ID,
      filter: {
        and: [
          { prop: "area", op: "eq", value: "Operações" },
          { prop: "status", op: "eq", value: { group: "done" } },
          { prop: "feito", op: "eq", value: true },
        ],
      },
      sort: [
        { prop: "valor", dir: "asc" },
        { prop: "titulo", dir: "desc" },
      ],
      limit: 2,
    });
    expect(host(p).querySelectorAll("li[data-ravi-item]").length).toBe(2);
    const more = host(p).querySelector('[data-ravi-op="more"]') as HTMLButtonElement;
    expect(more.textContent).toBe("Carregar mais");
    more.click();
    await p.flush();
    expect(p.calls.at(-1)?.input.cursor).toBe("2");
    expect(host(p).querySelectorAll("li[data-ravi-item]").length).toBe(3);
    expect(host(p).querySelector('[data-ravi-op="more"]')).toBeNull();
    expect(p.announced()).toBe("1 item carregado.");
    expect(p.doc.activeElement?.getAttribute("data-ravi-item")).toBe("r3");
  });

  test("board: lanes in option order with counts, cards in lists, a menu button per card", async () => {
    const p = await open("", { type: "board", groupBy: "status" });
    const lanes = Array.from(host(p).querySelectorAll("section.ravi-lane"));
    expect(lanes.map((lane) => squash(lane.querySelector("h2")?.textContent))).toEqual(["A fazer (1)", "Fazendo (1)", "Feito (1)"]);
    expect(lanes[0]?.getAttribute("aria-labelledby")).toBe(lanes[0]?.querySelector("h2")?.id ?? "x");
    expect(lanes[0]?.querySelector("ul")?.getAttribute("role")).toBe("list");
    // Cards take the next heading level on a board.
    expect(lanes[0]?.querySelector("article h3")?.textContent).toBe("Pedido 1");
    const button = lanes[0]?.querySelector('[data-ravi-op="move"]');
    expect(button?.textContent).toBe("Mover para…");
    expect(button?.getAttribute("aria-label")).toBe("Mover para…: Pedido 1");
    expect(button?.getAttribute("aria-haspopup")).toBe("menu");
    expect(lanes[0]?.querySelector("li")?.getAttribute("draggable")).toBe("true");
  });

  test("board on a select column has a Sem valor lane; group-by on a non-option column falls back to list", async () => {
    let p = await open('group-by="area"', { type: "board", groupBy: "status" });
    expect(Array.from(host(p).querySelectorAll("section.ravi-lane h2"), (heading) => squash(heading.textContent))).toEqual([
      "Operações (1)",
      "Financeiro (1)",
      "Sem valor (1)",
    ]);
    await p.close();
    p = await open('group-by="valor"', { type: "board", groupBy: "status" });
    expect(host(p).querySelector("ul.ravi-list")).not.toBeNull();
    expect(host(p).querySelector("section.ravi-lane")).toBeNull();
  });

  test("board: Mover para… menu with arrow keys, Esc returns focus, choosing a lane updates the row", async () => {
    const p = await open("", { type: "board", groupBy: "status" });
    const button = host(p).querySelector('li[data-ravi-item="r1"] [data-ravi-op="move"]') as HTMLButtonElement;
    button.focus();
    button.click();
    const menu = host(p).querySelector('[role="menu"]') as HTMLElement;
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(menu.id);
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(items.map((item) => item.textContent)).toEqual(["Fazendo", "Feito"]);
    expect(p.doc.activeElement).toBe(items[0] ?? null);
    key(p, items[0] as Element, "ArrowDown");
    expect(p.doc.activeElement).toBe(items[1] ?? null);
    key(p, items[1] as Element, "ArrowDown");
    expect(p.doc.activeElement).toBe(items[0] ?? null);
    key(p, items[0] as Element, "End");
    expect(p.doc.activeElement).toBe(items[1] ?? null);
    key(p, items[1] as Element, "Escape");
    expect(host(p).querySelector('[role="menu"]')).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(p.doc.activeElement).toBe(button);
    expect(p.calls.some((call) => call.id === BASES_IDS.update)).toBe(false);

    // ArrowUp on the button opens the menu on its last item.
    key(p, button, "ArrowUp");
    const reopened = Array.from(host(p).querySelectorAll('[role="menuitem"]'));
    expect(p.doc.activeElement).toBe(reopened[1] ?? null);
    (reopened[1] as HTMLElement).click();
    await p.flush();
    const update = p.calls.find((call) => call.id === BASES_IDS.update);
    expect(update?.input).toMatchObject({ viewId: VIEW_ID, rowId: "r1", values: { status: "s-done" }, expectedVersion: 1 });
    expect(String(update?.input.idempotencyKey)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
    const lanes = Array.from(host(p).querySelectorAll("section.ravi-lane h2"), (heading) => squash(heading.textContent));
    expect(lanes).toEqual(["A fazer (0)", "Fazendo (1)", "Feito (2)"]);
    expect(p.announced()).toBe("“Pedido 1” movido para Feito.");
    // Focus follows the card's control into its new lane.
    expect(p.doc.activeElement?.closest("li")?.getAttribute("data-ravi-item")).toBe("r1");
  });

  test("board: pointer drag moves a card to a lane", async () => {
    const p = await open("", { type: "board", groupBy: "status" });
    const data = new Map<string, string>();
    const transfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
    const fire = (target: Element, type: string) => {
      const event = new p.win.Event(type, { bubbles: true, cancelable: true }) as unknown as Event & { dataTransfer: unknown };
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      target.dispatchEvent(event);
      return event;
    };
    fire(host(p).querySelector('li[data-ravi-item="r2"]') as Element, "dragstart");
    const lane = host(p).querySelector('section[data-ravi-lane="s-todo"] h2') as Element;
    expect(fire(lane, "dragover").defaultPrevented).toBe(true);
    fire(lane, "drop");
    await p.flush();
    expect(p.calls.find((call) => call.id === BASES_IDS.update)?.input).toMatchObject({ rowId: "r2", values: { status: "s-todo" } });
  });

  test("readonly board: no move buttons", async () => {
    const p = await open("readonly", { type: "board", groupBy: "status" });
    expect(host(p).querySelector('[data-ravi-op="move"]')).toBeNull();
    expect(host(p).querySelector("select[data-ravi-edit]")).toBeNull();
  });

  test("table: caption for screen readers, column headers, the title column as row header", async () => {
    const p = await open('layout="table" columns="titulo,status,valor"');
    const table = host(p).querySelector("table.ravi-table") as HTMLTableElement;
    expect(table.querySelector("caption")?.className).toBe("ravi-sr-only");
    expect(table.querySelector("caption")?.textContent).toBe("Pedidos");
    expect(Array.from(table.querySelectorAll("thead th"), (th) => [th.getAttribute("scope"), th.textContent])).toEqual([
      ["col", "Título"],
      ["col", "Status"],
      ["col", "Valor"],
    ]);
    expect(table.querySelectorAll("tbody tr").length).toBe(3);
    expect(table.querySelector("tbody tr th")?.getAttribute("scope")).toBe("row");
  });

  test("gallery: cards with the view's cover image", async () => {
    page = await openPage({
      body: viewTag(),
      kit: kitFor({}, { r1: {} }),
      fake: new FakeBase(
        describeOutput({ type: "gallery", coverProp: "capa" }),
        sampleRows().map((row) => ({ ...row, values: { ...row.values, capa: `https://example.test/${row.rowId}.png` } })),
      ),
    });
    await page.ravi.ready;
    const gallery = host(page).querySelector("ul.ravi-gallery");
    expect(gallery?.getAttribute("role")).toBe("list");
    expect(gallery?.querySelector("img.ravi-cover")?.getAttribute("src")).toBe("https://example.test/r1.png");
  });

  test.each(["chart", "calendar"])("%s layout falls back to list (a calendar needs a date column)", async (type) => {
    const p = await open("", { type });
    expect(host(p).querySelector("ul.ravi-list")).not.toBeNull();
  });

  test("empty view says so", async () => {
    page = await openPage({ body: viewTag(), kit: kitFor({}, { r1: {} }), fake: new FakeBase(describeOutput(), []) });
    await page.ravi.ready;
    expect(squash(host(page).textContent)).toBe("Nenhum item por aqui.");
    expect(page.announced()).toBe("0 itens carregados.");
  });
});

describe("<ravi-view> with a widget", () => {
  const widget = orderWidget({
    actions: [
      { verb: "update", set: { status: { kind: "status_group", group: "done" } }, href: null, confirm: true, label: "Concluir" },
      { verb: "open", set: {}, href: null, confirm: false, label: "Abrir" },
    ],
  });
  // ORDER_TEMPLATE has one button (action 0); add an open button (action 1).
  widget.variants.default = [
    ...widget.variants.default,
    { k: "el", piece: "ravi-button", attrs: { action: { lit: "open" } }, children: [{ k: "text", v: "Abrir" }], line: 2 },
  ];

  async function openWidget() {
    page = await openPage({
      body: viewTag(),
      kit: kitFor({}, { r1: { widget: "w1", fields: { titulo: "titulo", status: "status", valor: "valor" } } }, { w1: widget }),
      fake: new FakeBase(describeOutput(), sampleRows()),
    });
    page.fake.bodies.r1 = "Linha 1\nLinha 2";
    await page.ravi.ready;
    return page;
  }

  test("cards come from the kit widget with fields mapped to view columns", async () => {
    const p = await openWidget();
    const item = host(p).querySelector('li[data-ravi-item="r1"]') as HTMLElement;
    expect(item.querySelector("article.ravi-card .ravi-title")?.textContent).toBe("Pedido 1");
    expect(item.querySelector('[data-ravi-row="r1"]')).not.toBeNull();
    expect(item.querySelector('[data-ravi-field="valor"]')?.getAttribute("data-ravi-value")).toBe("10");
  });

  test("an update button confirms with text built from the action, then writes the resolved option", async () => {
    const p = await openWidget();
    const button = Array.from(host(p).querySelectorAll('li[data-ravi-item="r1"] button[data-ravi-action="0"]'))[0] as HTMLButtonElement;
    button.focus();
    button.click();
    const dialog = p.doc.querySelector("dialog.ravi-dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector("h2")?.textContent).toBe("Alterar este item?");
    expect(p.doc.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Em “Pedido 1”: Status passa a ser Feito.");
    expect(p.doc.activeElement?.textContent).toBe("Alterar");
    (p.doc.activeElement as HTMLElement).click();
    await p.flush();
    expect(p.calls.find((call) => call.id === BASES_IDS.update)?.input).toMatchObject({ rowId: "r1", values: { status: "s-done" } });
    expect(p.doc.querySelector("dialog")).toBeNull();
  });

  test("open without href: the record dialog reads the row (rows.get), shows read-only columns and the body as text, and edits the writable ones", async () => {
    const p = await openWidget();
    const button = host(p).querySelector('li[data-ravi-item="r1"] button[data-ravi-action="1"]') as HTMLButtonElement;
    button.focus();
    button.click();
    await p.flush();
    expect(p.calls.at(-1)).toMatchObject({ id: BASES_IDS.get, input: { viewId: VIEW_ID, rowId: "r1" } });
    const dialog = p.doc.querySelector("dialog.ravi-dialog") as HTMLElement;
    expect(dialog.querySelector("h2")?.textContent).toBe("Pedido 1");
    // Capa is not writable: text. The writable columns are a form that starts from the row.
    expect(Array.from(dialog.querySelectorAll("dt"), (dt) => dt.textContent)).toEqual(["Capa"]);
    expect(dialog.querySelector(".ravi-body")?.textContent).toBe("Linha 1\nLinha 2");
    const form = dialog.querySelector("form") as HTMLFormElement;
    expect(Array.from(form.elements, (control) => (control as HTMLInputElement).name || (control as HTMLElement).textContent)).toEqual(["titulo", "status", "area", "feito", "valor", "Salvar"]);
    expect((form.querySelector('input[name="titulo"]') as HTMLInputElement).value).toBe("Pedido 1");
    expect((form.querySelector('select[name="status"]') as HTMLSelectElement).value).toBe("s-todo");
    expect((form.querySelector('input[name="valor"]') as HTMLInputElement).value).toBe("10");
    key(p, dialog, "Escape");
    expect(p.doc.querySelector("dialog")).toBeNull();
    expect(p.doc.activeElement).toBe(host(p).querySelector('li[data-ravi-item="r1"] button[data-ravi-action="1"]'));
  });

  test("the record dialog saves only the fields that changed; a cleared field sends null", async () => {
    const p = await openWidget();
    (host(p).querySelector('li[data-ravi-item="r1"] button[data-ravi-action="1"]') as HTMLButtonElement).click();
    await p.flush();
    const form = p.doc.querySelector("dialog form") as HTMLFormElement;
    (form.querySelector('input[name="titulo"]') as HTMLInputElement).value = "Pedido 1 (revisto)";
    (form.querySelector('input[name="valor"]') as HTMLInputElement).value = "";
    form.requestSubmit();
    await p.flush();
    expect(p.calls.find((call) => call.id === BASES_IDS.update)?.input).toMatchObject({ rowId: "r1", values: { titulo: "Pedido 1 (revisto)", valor: null }, expectedVersion: 1 });
    expect(Object.keys(p.calls.find((call) => call.id === BASES_IDS.update)?.input.values as object)).toEqual(["titulo", "valor"]);
    expect(p.doc.querySelector("dialog")).toBeNull();
    expect(p.announced()).toBe("Salvo.");
  });
});

const COLUMN_NAMES = ["Título", "Status", "Área", "Feito", "Valor", "Capa"];

describe("<ravi-view archive>", () => {
  test("archive always confirms in a dialog with a focus trap; Esc cancels and returns focus", async () => {
    const p = await open("archive");
    const button = host(p).querySelector('li[data-ravi-item="r2"] [data-ravi-op="archive"]') as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Arquivar: Pedido 2");
    button.focus();
    button.click();
    const dialog = p.doc.querySelector("dialog.ravi-dialog") as HTMLDialogElement;
    expect(dialog.getAttribute("aria-labelledby")).toBe(dialog.querySelector("h2")?.id ?? "x");
    expect(p.doc.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe("“Pedido 2” será arquivado e sai desta lista.");
    const [cancel, confirm] = Array.from(dialog.querySelectorAll("button"));
    // Archive focuses Cancel first.
    expect(p.doc.activeElement).toBe(cancel ?? null);
    confirm?.focus();
    expect(key(p, confirm as Element, "Tab").defaultPrevented).toBe(true);
    expect(p.doc.activeElement).toBe(cancel ?? null);
    expect(key(p, cancel as Element, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(p.doc.activeElement).toBe(confirm ?? null);
    key(p, dialog, "Escape");
    expect(p.doc.querySelector("dialog")).toBeNull();
    expect(p.doc.activeElement).toBe(button);
    expect(p.calls.some((call) => call.id === BASES_IDS.archive)).toBe(false);
  });

  test("confirming archives the row, removes it and announces", async () => {
    const p = await open("archive");
    (host(p).querySelector('li[data-ravi-item="r2"] [data-ravi-op="archive"]') as HTMLButtonElement).click();
    const confirm = Array.from(p.doc.querySelectorAll("dialog button")).find((button) => button.textContent === "Arquivar") as HTMLButtonElement;
    confirm.click();
    await p.flush();
    expect(p.calls.find((call) => call.id === BASES_IDS.archive)?.input).toEqual({ viewId: VIEW_ID, rowId: "r2", expectedVersion: 1 });
    expect(host(p).querySelector('li[data-ravi-item="r2"]')).toBeNull();
    expect(p.announced()).toBe("Salvo.");
  });

  test("no archive capability: no archive button", async () => {
    page = await openPage({ body: viewTag("archive"), kit: kitFor({}, { r1: {} }), fake: new FakeBase(describeOutput({ type: "list" }, { archive: false }), sampleRows()) });
    await page.ravi.ready;
    expect(host(page).querySelector('[data-ravi-op="archive"]')).toBeNull();
  });
});

describe("<ravi-view create>", () => {
  test("Novo item opens the create form in a dialog; saving creates the row and closes the dialog", async () => {
    const p = await open("create");
    const button = host(p).querySelector('[data-ravi-op="create"]') as HTMLButtonElement;
    expect(button.textContent).toBe("Novo item");
    button.click();
    const dialog = p.doc.querySelector("dialog.ravi-dialog") as HTMLElement;
    expect(dialog.querySelector("h2")?.textContent).toBe("Novo item");
    const title = dialog.querySelector('input[name="titulo"]') as HTMLInputElement;
    title.value = "Pedido novo";
    (dialog.querySelector("form") as HTMLFormElement).requestSubmit();
    await p.flush();
    expect(p.calls.find((call) => call.id === BASES_IDS.create)?.input).toMatchObject({ viewId: VIEW_ID, values: { titulo: "Pedido novo" } });
    expect(p.doc.querySelector("dialog")).toBeNull();
    expect(host(p).querySelector('li[data-ravi-item="new1"]')).not.toBeNull();
    expect(p.announced()).toBe("Salvo.");
  });
});

describe("<ravi-view> removed or moved before its first render", () => {
  /** A page whose describe answer waits for `release()`, with a manual clock: polls run only on `tick()`. */
  async function held() {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    let clock = 1_000_000;
    const p = (page = await openPage({
      body: `<div id="a">${viewTag()}</div><div id="b"></div>`,
      kit: kitFor({}, { r1: {} }),
      handler: async (call) => {
        if (call.id === BASES_IDS.describe) await opened;
        return undefined;
      },
      install: { now: () => clock },
    }));
    return { p, release, later: () => (clock += 120_000) };
  }
  const settled = (promise: Promise<unknown>) => Promise.race([promise.then(() => "settled"), new Promise((resolve) => setTimeout(() => resolve("pending"), 300))]);
  const queries = (p: Page) => p.calls.filter((call) => call.id === BASES_IDS.query).length;
  const view = (p: Page) => (p.ravi.bases as { view: (id: string) => { tick(): Promise<void> } }).view(VIEW_ID);

  test("removed while describing: nothing starts, nothing polls, ravi.ready resolves", async () => {
    const { p, release, later } = await held();
    expect(p.calls.map((call) => call.id)).toEqual([BASES_IDS.describe]);
    host(p).remove();
    release();
    expect(await settled(p.ravi.ready)).toBe("settled");
    later();
    await view(p).tick();
    expect(queries(p)).toBe(0);
  });

  test("moved while describing: one live query, the new mount's; ravi.ready waits for its render", async () => {
    const { p, release, later } = await held();
    const tag = host(p);
    p.doc.getElementById("b")?.append(tag);
    release();
    expect(await settled(p.ravi.ready)).toBe("settled");
    expect(tag.parentElement?.id).toBe("b");
    expect(tag.querySelectorAll("li[data-ravi-item]").length).toBe(3);
    expect(queries(p)).toBe(1);
    later();
    await view(p).tick();
    expect(queries(p)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Bases H1+H2: editors, calendar, form layout, search, approval and agent cells.

const RICH_COLUMNS: BaseViewColumn[] = [
  ...COLUMNS,
  { key: "prazo", name: "Prazo", type: "date", config: {}, required: false },
  {
    key: "tags",
    name: "Tags",
    type: "multi_select",
    config: {
      options: [
        { id: "t-urg", name: "Urgente", color: "red" },
        { id: "t-cli", name: "Cliente", color: "blue" },
      ],
    },
    required: false,
  },
  { key: "aprov", name: "Aprovação", type: "approval", config: {}, required: false },
  { key: "resumo", name: "Resumo", type: "agent", config: { output: "text" }, required: false },
  { key: "body", name: "Body", type: "body", config: {}, required: false },
];
const RICH_WRITE = ["titulo", "status", "area", "feito", "valor", "capa", "prazo", "tags", "aprov", "body"];

function richDescribe(layout: Record<string, unknown> = { type: "list" }, caps: Caps = {}) {
  return { ...describeOutput(layout, { writeColumns: RICH_WRITE, approve: ["aprov"], ...caps }), columns: RICH_COLUMNS };
}

function richRows(): ViewRow[] {
  return [
    { rowId: "r1", version: 1, values: { titulo: "Pedido 1", status: "s-todo", valor: 10, capa: "https://x.test/1", prazo: "2026-10-20", tags: ["t-urg"], aprov: { state: "pending" }, resumo: { state: "done", value: "Cliente quer prazo" } } },
    { rowId: "r2", version: 1, values: { titulo: "Pedido 2", status: "s-doing", valor: 20, prazo: "2026-10-05", tags: [], aprov: null, resumo: { state: "pending", value: null } } },
    { rowId: "r3", version: 1, values: { titulo: "Pedido 3", status: "s-done", valor: 30, prazo: null, aprov: { state: "approved" }, resumo: { state: "error", value: null, error: "Sem acesso" } } },
  ];
}

async function openRich(attrs = "", layout: Record<string, unknown> = { type: "list" }, caps: Caps = {}, extra: Partial<Parameters<typeof openPage>[0]> = {}) {
  page = await openPage({ body: viewTag(attrs), kit: kitFor({}, { r1: {} }), fake: new FakeBase(richDescribe(layout, caps), richRows()), ...extra });
  await page.ravi.ready;
  return page;
}

function change(p: Page, control: Element, value?: string | boolean) {
  const input = control as HTMLInputElement;
  if (typeof value == "boolean") input.checked = value;
  else if (value !== undefined) input.value = value;
  input.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
}

const updates = (p: Page) => p.calls.filter((call) => call.id === BASES_IDS.update).map((call) => [call.input.rowId, call.input.values]);
const buttonIn = (root: ParentNode, text: string) => Array.from(root.querySelectorAll("button")).find((button) => button.textContent === text) as HTMLButtonElement | undefined;

describe("<ravi-view> inline editors (table)", () => {
  test("every writable type but person and ref gets a labelled editor; changes write the typed value", async () => {
    const p = await openRich('layout="table"');
    const row = (id: string) => host(p).querySelector(`tr[data-ravi-item="${id}"]`) as HTMLElement;
    const edit = (id: string, key: string) => row(id).querySelector(`[data-ravi-edit="${key}"]`) as HTMLInputElement;
    expect([edit("r1", "titulo").type, edit("r1", "titulo").value]).toEqual(["text", "Pedido 1"]);
    expect([edit("r1", "valor").type, edit("r1", "valor").value]).toEqual(["number", "10"]);
    expect([edit("r1", "capa").type, edit("r1", "capa").value]).toEqual(["url", "https://x.test/1"]);
    expect([edit("r1", "prazo").type, edit("r1", "prazo").value]).toEqual(["date", "2026-10-20"]);
    // Each editor has a label (visually hidden in the table).
    const label = p.doc.querySelector(`label[for="${edit("r1", "titulo").id}"]`);
    expect(label?.textContent).toBe("Título");
    expect(label?.className).toBe("ravi-sr-only");
    // multi_select: a fieldset of checkboxes named by its legend.
    const tags = row("r1").querySelector('fieldset[data-ravi-field="tags"]') as HTMLFieldSetElement;
    expect(tags.querySelector("legend")?.textContent).toBe("Tags");
    expect(Array.from(tags.querySelectorAll("label"), (one) => squash(one.textContent))).toEqual(["Urgente", "Cliente"]);
    // Agent cells are read-only.
    expect(row("r1").querySelector('[data-ravi-edit="resumo"]')).toBeNull();

    change(p, edit("r1", "titulo"), " Pedido 1b ");
    change(p, edit("r2", "valor"), "12.5");
    change(p, edit("r3", "capa"), "");
    await p.flush();
    change(p, row("r1").querySelector('input[data-ravi-opt="t-cli"]') as Element, true);
    change(p, edit("r2", "prazo"), "2026-11-02");
    await p.flush();
    expect(updates(p)).toEqual([
      ["r1", { titulo: "Pedido 1b" }],
      ["r2", { valor: 12.5 }],
      ["r3", { capa: null }],
      ["r1", { tags: ["t-urg", "t-cli"] }],
      ["r2", { prazo: "2026-11-02" }],
    ]);
  });

  test("a number that is not a number is announced, not written", async () => {
    const p = await openRich('layout="table"');
    const valor = host(p).querySelector('tr[data-ravi-item="r1"] [data-ravi-edit="valor"]') as HTMLInputElement;
    Object.defineProperty(valor, "value", { configurable: true, get: () => "abc", set: () => {} });
    change(p, valor);
    await p.flush();
    expect(updates(p)).toEqual([]);
    expect(p.announced()).toBe("Valor inválido.");
  });

  test("cards edit only select, status, checkbox and approval in place; the rest through Abrir", async () => {
    const p = await openRich('card-fields="status,valor,prazo"');
    const card = host(p).querySelector('li[data-ravi-item="r1"]') as HTMLElement;
    expect(card.querySelector('select[data-ravi-edit="status"]')).not.toBeNull();
    expect(card.querySelector('[data-ravi-edit="valor"]')).toBeNull();
    expect(card.querySelector('[data-ravi-edit="prazo"]')).toBeNull();
    const open = card.querySelector('[data-ravi-op="open"]') as HTMLButtonElement;
    expect(open.textContent).toBe("Abrir");
    expect(open.getAttribute("aria-label")).toBe("Abrir: Pedido 1");
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
  });
});

describe("<ravi-view> record dialog with the body", () => {
  test("Abrir reads the row and its body; editing the body sends it apart from the values", async () => {
    const p = await openRich();
    p.fake.bodies.r1 = "Primeira linha";
    const open = host(p).querySelector('li[data-ravi-item="r1"] [data-ravi-op="open"]') as HTMLButtonElement;
    open.focus();
    open.click();
    await p.flush();
    expect(p.calls.at(-1)).toMatchObject({ id: BASES_IDS.get, input: { rowId: "r1" } });
    const dialog = p.doc.querySelector("dialog.ravi-dialog") as HTMLElement;
    expect(dialog.querySelector("h2")?.textContent).toBe("Pedido 1");
    const body = dialog.querySelector('textarea[name="body"]') as HTMLTextAreaElement;
    expect(body.value).toBe("Primeira linha");
    expect(p.doc.querySelector(`label[for="${body.id}"]`)?.textContent).toBe("Body");
    // Columns the form cannot edit (approval is decided on its cell, agent is read-only) show as text; an editable body is not repeated.
    expect(Array.from(dialog.querySelectorAll("dt"), (dt) => dt.textContent)).toEqual(["Aprovação", "Resumo"]);
    expect(dialog.querySelector(".ravi-body")).toBeNull();
    body.value = "Primeira linha\nSegunda";
    (dialog.querySelector("form") as HTMLFormElement).requestSubmit();
    await p.flush();
    const update = p.calls.find((call) => call.id === BASES_IDS.update);
    expect(update?.input).toMatchObject({ rowId: "r1", values: {}, body: "Primeira linha\nSegunda", expectedVersion: 1 });
    expect(p.fake.bodies.r1).toBe("Primeira linha\nSegunda");
    expect(p.doc.querySelector("dialog")).toBeNull();
    expect(p.announced()).toBe("Salvo.");
    expect(p.doc.activeElement).toBe(host(p).querySelector('li[data-ravi-item="r1"] [data-ravi-op="open"]'));
  });

  test("a read-only body shows as text, with Fechar", async () => {
    const p = await openRich("", { type: "list" }, { writeColumns: ["titulo"] });
    p.fake.bodies.r2 = "Só leitura";
    (host(p).querySelector('li[data-ravi-item="r2"] [data-ravi-op="open"]') as HTMLButtonElement).click();
    await p.flush();
    const dialog = p.doc.querySelector("dialog.ravi-dialog") as HTMLElement;
    expect(dialog.querySelector(".ravi-body")?.textContent).toBe("Só leitura");
    expect(dialog.querySelector('textarea[name="body"]')).toBeNull();
  });
});

describe("<ravi-view> calendar", () => {
  const NOW = new Date(2026, 9, 19, 12).getTime();
  const openCalendar = () => openRich("", { type: "calendar", dateProp: "prazo" }, {}, { install: { now: () => NOW } });
  const rangeOf = (p: Page) => p.calls.filter((call) => call.id === BASES_IDS.query).at(-1)?.input.filter;

  test("a month grid: weekday headers, today marked, the month's range queried, entries on their day", async () => {
    const p = await openCalendar();
    expect(rangeOf(p)).toEqual({
      and: [
        { prop: "prazo", op: "on_or_after", value: "2026-10-01" },
        { prop: "prazo", op: "before", value: "2026-11-01" },
      ],
    });
    const table = host(p).querySelector("table.ravi-calendar") as HTMLTableElement;
    const heading = p.doc.getElementById(table.getAttribute("aria-labelledby") ?? "");
    expect(heading?.textContent).toBe("outubro de 2026");
    const headers = Array.from(table.querySelectorAll("thead th"));
    expect(headers.length).toBe(7);
    expect(headers[0]?.getAttribute("abbr")).toBe("domingo");
    expect(headers.every((th) => th.getAttribute("scope") === "col")).toBe(true);
    const today = table.querySelector('td[aria-current="date"]') as HTMLElement;
    expect(today.querySelector(".ravi-sr-only")?.textContent).toBe("19 de outubro, hoje");
    const cellOf = (rowId: string) => table.querySelector(`li[data-ravi-item="${rowId}"]`)?.closest("td")?.querySelector(".ravi-sr-only")?.textContent;
    expect(cellOf("r1")).toBe("20 de outubro");
    expect(cellOf("r2")).toBe("5 de outubro");
    // No date: not on the grid.
    expect(table.querySelector('li[data-ravi-item="r3"]')).toBeNull();
    // October 2026 starts on a Thursday: four empty cells first.
    const first = Array.from(table.querySelectorAll("tbody tr:first-child td"));
    expect(first.slice(0, 4).every((td) => !td.textContent)).toBe(true);
  });

  test("Próximo mês and Mês anterior re-query the month and announce it; December wraps the year", async () => {
    const p = await openCalendar();
    const nav = () => host(p).querySelector(".ravi-calendar-nav") as HTMLElement;
    (buttonIn(nav(), "Próximo mês") as HTMLButtonElement).click();
    await p.flush();
    expect(p.announced()).toBe("novembro de 2026. 3 itens carregados.");
    (buttonIn(nav(), "Próximo mês") as HTMLButtonElement).click();
    await p.flush();
    expect(rangeOf(p)).toEqual({
      and: [
        { prop: "prazo", op: "on_or_after", value: "2026-12-01" },
        { prop: "prazo", op: "before", value: "2027-01-01" },
      ],
    });
    expect(host(p).querySelector(".ravi-calendar-nav h2")?.textContent).toBe("dezembro de 2026");
    (buttonIn(nav(), "Mês anterior") as HTMLButtonElement).click();
    (buttonIn(nav(), "Mês anterior") as HTMLButtonElement).click();
    (buttonIn(nav(), "Mês anterior") as HTMLButtonElement).click();
    await p.flush();
    expect(p.announced()).toBe("setembro de 2026. 3 itens carregados.");
  });

  test("an entry is a button that opens the record dialog; the where attribute is ANDed with the month", async () => {
    const p = await openRich('where="valor>15"', { type: "calendar", dateProp: "prazo" }, {}, { install: { now: () => NOW } });
    expect(rangeOf(p)).toEqual({
      and: [
        { prop: "valor", op: "gt", value: 15 },
        {
          and: [
            { prop: "prazo", op: "on_or_after", value: "2026-10-01" },
            { prop: "prazo", op: "before", value: "2026-11-01" },
          ],
        },
      ],
    });
    const entry = host(p).querySelector('li[data-ravi-item="r1"] button') as HTMLButtonElement;
    expect(entry.textContent).toBe("Pedido 1");
    expect(entry.getAttribute("aria-haspopup")).toBe("dialog");
    entry.click();
    await p.flush();
    expect(p.calls.at(-1)).toMatchObject({ id: BASES_IDS.get, input: { rowId: "r1" } });
    expect(p.doc.querySelector("dialog.ravi-dialog h2")?.textContent).toBe("Pedido 1");
  });
});

describe("<ravi-view> form layout", () => {
  test("the create form with the layout's texts, without reading rows (a writer may not read the view)", async () => {
    const layout = { type: "form", title: "Novo pedido", description: "Conte o que precisa.", submitLabel: "Enviar pedido", successMessage: "Recebemos seu pedido." };
    const p = await openRich("", layout, { read: false, writeColumns: ["titulo", "valor"] });
    expect(p.calls.map((call) => call.id)).toEqual([BASES_IDS.describe]);
    expect(host(p).querySelector("h2.ravi-title")?.textContent).toBe("Novo pedido");
    expect(host(p).querySelector("p")?.textContent).toBe("Conte o que precisa.");
    const form = host(p).querySelector("form") as HTMLFormElement;
    expect(Array.from(form.elements, (control) => (control as HTMLInputElement).name || (control as HTMLElement).textContent)).toEqual(["titulo", "valor", "Enviar pedido"]);
    (form.querySelector('input[name="titulo"]') as HTMLInputElement).value = "Pedido novo";
    form.requestSubmit();
    await p.flush();
    expect(p.calls.at(-1)).toMatchObject({ id: BASES_IDS.create, input: { values: { titulo: "Pedido novo" } } });
    expect(p.announced()).toBe("Recebemos seu pedido.");
  });

  test("layout=form without create capability says so", async () => {
    const p = await openRich('layout="form"', { type: "list" }, { create: false });
    expect(host(p).querySelector("form")).toBeNull();
    expect(host(p).querySelector("p.ravi-status")).not.toBeNull();
  });
});

describe("<ravi-view> search and observed attributes", () => {
  test("searchable: a labelled search box sends search; typing re-queries after a pause and keeps focus", async () => {
    const p = await openRich('searchable search="ped"');
    const box = host(p).querySelector('[role="search"] input[type="search"]') as HTMLInputElement;
    expect(box.value).toBe("ped");
    expect(p.doc.querySelector(`label[for="${box.id}"]`)?.textContent).toBe("Buscar");
    expect(p.calls.find((call) => call.id === BASES_IDS.query)?.input.search).toBe("ped");
    box.focus();
    box.value = "pedido 2";
    box.dispatchEvent(new p.win.Event("input", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 360));
    await p.flush();
    expect(p.calls.filter((call) => call.id === BASES_IDS.query).at(-1)?.input.search).toBe("pedido 2");
    expect(p.doc.activeElement).toBe(box);
    // The box stays; the collection renders after it.
    expect(host(p).querySelector('[role="search"]')).not.toBeNull();
    expect(host(p).querySelectorAll("li[data-ravi-item]").length).toBe(3);
  });

  test("changing where, search or sort re-queries; search also updates the box", async () => {
    const p = await openRich("searchable");
    const last = () => p.calls.filter((call) => call.id === BASES_IDS.query).at(-1)?.input;
    expect(last()?.search).toBeUndefined();
    host(p).setAttribute("where", "valor>=20;titulo~Pedido");
    await p.flush();
    expect(last()?.filter).toEqual({
      and: [
        { prop: "valor", op: "gte", value: 20 },
        { prop: "titulo", op: "contains", value: "Pedido" },
      ],
    });
    host(p).setAttribute("search", "três");
    await p.flush();
    expect(last()?.search).toBe("três");
    expect((host(p).querySelector('input[type="search"]') as HTMLInputElement).value).toBe("três");
    host(p).setAttribute("sort", "-valor");
    await p.flush();
    expect(last()?.sort).toEqual([{ prop: "valor", dir: "desc" }]);
  });

  test("a bad where operator is an inline error, not a request", async () => {
    const p = await openRich('where="titulo>3"');
    expect(p.calls.map((call) => call.id)).toEqual([BASES_IDS.describe]);
    expect(host(p).querySelector(".ravi-error")).not.toBeNull();
  });
});

describe("<ravi-view> approval and agent cells", () => {
  const cell = (p: Page, rowId: string, key: string) => host(p).querySelector(`li[data-ravi-item="${rowId}"] [data-ravi-field="${key}"]`) as HTMLElement;

  test("approval: a state pill with text; Aprovar/Recusar for deciders while undecided; Pedir aprovação when empty or refused", async () => {
    const p = await openRich('card-fields="aprov"');
    expect(cell(p, "r1", "aprov").querySelector("[data-ravi-state]")?.textContent).toBe("Pendente");
    expect(Array.from(cell(p, "r1", "aprov").querySelectorAll("button"), (button) => button.textContent)).toEqual(["Aprovar", "Recusar"]);
    expect(Array.from(cell(p, "r2", "aprov").querySelectorAll("button"), (button) => button.textContent)).toEqual(["Aprovar", "Recusar", "Pedir aprovação"]);
    expect(cell(p, "r3", "aprov").querySelector("[data-ravi-state]")?.textContent).toBe("Aprovado");
    expect(cell(p, "r3", "aprov").querySelectorAll("button").length).toBe(0);
  });

  test("Aprovar asks in a dialog with an optional note, then writes the decision and announces it", async () => {
    const p = await openRich('card-fields="aprov"');
    (buttonIn(cell(p, "r1", "aprov"), "Aprovar") as HTMLButtonElement).click();
    await p.flush();
    const dialog = p.doc.querySelector("dialog.ravi-dialog") as HTMLElement;
    expect(dialog.querySelector("h2")?.textContent).toBe("Aprovar este item?");
    expect(p.doc.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent).toBe("“Pedido 1”: Aprovação.");
    const note = dialog.querySelector("textarea") as HTMLTextAreaElement;
    expect(squash(note.closest("label")?.textContent)).toBe("Observação (opcional)");
    note.value = "  Pode seguir  ";
    (buttonIn(dialog, "Aprovar") as HTMLButtonElement).click();
    await p.flush();
    expect(updates(p)).toEqual([["r1", { aprov: { state: "approved", note: "Pode seguir" } }]]);
    expect(p.announced()).toBe("Aprovado.");
    expect(cell(p, "r1", "aprov").querySelector("[data-ravi-state]")?.textContent).toBe("Aprovado");
  });

  test("Recusar without a note sends the state only; Cancelar sends nothing", async () => {
    const p = await openRich('card-fields="aprov"');
    (buttonIn(cell(p, "r1", "aprov"), "Recusar") as HTMLButtonElement).click();
    await p.flush();
    (buttonIn(p.doc.querySelector("dialog") as HTMLElement, "Cancelar") as HTMLButtonElement).click();
    await p.flush();
    expect(updates(p)).toEqual([]);
    (buttonIn(cell(p, "r1", "aprov"), "Recusar") as HTMLButtonElement).click();
    await p.flush();
    (buttonIn(p.doc.querySelector("dialog") as HTMLElement, "Recusar") as HTMLButtonElement).click();
    await p.flush();
    expect(updates(p)).toEqual([["r1", { aprov: { state: "rejected" } }]]);
    expect(p.announced()).toBe("Recusado.");
  });

  test("without approve: only Pedir aprovação, which writes pending at once", async () => {
    const p = await openRich('card-fields="aprov"', { type: "list" }, { approve: [] });
    expect(Array.from(cell(p, "r1", "aprov").querySelectorAll("button"))).toEqual([]);
    const request = buttonIn(cell(p, "r2", "aprov"), "Pedir aprovação") as HTMLButtonElement;
    expect(Array.from(cell(p, "r2", "aprov").querySelectorAll("button"), (button) => button.textContent)).toEqual(["Pedir aprovação"]);
    request.click();
    await p.flush();
    expect(updates(p)).toEqual([["r2", { aprov: "pending" }]]);
    expect(p.announced()).toBe("Aprovação pedida.");
  });

  test("a refused decision (approval_forbidden) is announced but keeps the viewer's other editors", async () => {
    const p = await openRich('card-fields="aprov,feito"', { type: "list" }, {}, { handler: (call) => (call.id === BASES_IDS.update ? { status: 403, error: "approval_forbidden" } : undefined) });
    (buttonIn(cell(p, "r1", "aprov"), "Aprovar") as HTMLButtonElement).click();
    await p.flush();
    (buttonIn(p.doc.querySelector("dialog") as HTMLElement, "Aprovar") as HTMLButtonElement).click();
    await p.flush();
    expect(updates(p).length).toBe(1);
    expect(p.announced()).not.toBe("Aprovado.");
    expect(host(p).querySelector('li[data-ravi-item="r1"] input[data-ravi-edit="feito"]')).not.toBeNull();
    expect(cell(p, "r1", "aprov").querySelector("[data-ravi-state]")?.textContent).toBe("Pendente");
  });

  test("agent cells: the value, a Preenchendo… or Erro badge with text, never an editor", async () => {
    const p = await openRich('card-fields="resumo"');
    expect(squash(cell(p, "r1", "resumo").textContent)).toBe("Resumo Cliente quer prazo");
    expect(cell(p, "r1", "resumo").querySelector("[data-ravi-state]")).toBeNull();
    expect(cell(p, "r2", "resumo").querySelector('[data-ravi-state="pending"]')?.textContent).toBe("Preenchendo…");
    const error = cell(p, "r3", "resumo").querySelector('[data-ravi-state="error"]') as HTMLElement;
    expect(squash(error.textContent)).toBe("Erro: Sem acesso");
    expect(error.getAttribute("title")).toBe("Sem acesso");
    expect(host(p).querySelector('[data-ravi-edit="resumo"]')).toBeNull();
  });
});
