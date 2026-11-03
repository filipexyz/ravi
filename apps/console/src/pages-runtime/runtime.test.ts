import { afterEach, describe, expect, test } from "bun:test";

import { orderWidget } from "@/shared/widgets/render/test-fixtures";
import { toHtml } from "@/shared/widgets/render/vnode";
import type { KitTheme } from "@/shared/widgets/types";

import { parseSort, parseWhere } from "./query";
import { errorKind, RaviError } from "./errors";
import { COLUMNS, describeOutput, FakeBase, kitFor, openPage, sampleRows, squash, VIEW_ID, type Page } from "./test-harness";
import { THEME_GET_ID } from "./theme";
import { BASES_IDS } from "./view";
import { staticNodes } from "./widget";

let page: Page | null = null;

afterEach(async () => {
  await page?.close();
  page = null;
});

const THEME: KitTheme = {
  ref: { itemId: "00000000-0000-4000-8000-0000000000t1", ref: "org/acme", version: 3 },
  hash: "hash-old",
  locale: "pt-BR",
  density: "compact",
  fields: {
    types: { status: "pill", select: "pill", multi_select: "pills", number: "number", currency: "currency", percent: "percent", date: "date", person: "avatar-name", url: "link", checkbox: "check" },
    roles: { image: "cover", avatar: "circle", highlight: "big", progress: "bar", rating: "stars" },
  },
  live: true,
};

describe("boot", () => {
  test("merges into an existing window.ravi (keeps ravi.chat), and ravi.ready resolves after every tag's first render", async () => {
    const chat = { open: () => "chat" };
    page = await openPage({
      body: `<ravi-view data-ravi-id="r1" view="${VIEW_ID}"></ravi-view><ravi-form data-ravi-id="r2" view="${VIEW_ID}"></ravi-form>`,
      kit: kitFor({}, { r1: {}, r2: { tag: "ravi-form" } }),
      before: (win) => {
        (win as unknown as { ravi: unknown }).ravi = { chat, bases: { custom: 1 } };
      },
    });
    const ravi = page.ravi as unknown as Record<string, unknown> & { bases: Record<string, unknown> };
    expect(ravi.chat).toBe(chat);
    expect(ravi.bases.custom).toBe(1);
    expect(typeof ravi.bases.view).toBe("function");
    expect(ravi.version).toBe("1.1.0");
    let ready = false;
    void page.ravi.ready.then(() => (ready = true));
    await page.ravi.ready;
    expect(ready).toBe(true);
    expect(page.doc.querySelector("ravi-view li[data-ravi-item]")).not.toBeNull();
    expect(page.doc.querySelector("ravi-form form")).not.toBeNull();
    // One polite live region, visually hidden.
    const regions = page.doc.querySelectorAll("[aria-live]");
    expect(regions.length).toBe(1);
    expect(regions[0]?.getAttribute("aria-live")).toBe("polite");
    expect(regions[0]?.className).toContain("ravi-sr-only");
  });

  test("lang comes from the kit locale only when the document has none", async () => {
    page = await openPage({ body: "", kit: kitFor({ locale: "en-US" }) });
    expect(page.doc.documentElement.getAttribute("lang")).toBe("en-US");
    await page.close();
    page = await openPage({
      body: "",
      kit: kitFor({ locale: "en-US" }),
      before: (win) => win.document.documentElement.setAttribute("lang", "pt-BR"),
    });
    expect(page.doc.documentElement.getAttribute("lang")).toBe("pt-BR");
  });

  test("messages follow the kit locale", async () => {
    page = await openPage({ body: `<ravi-view data-ravi-id="r1" view="${VIEW_ID}"></ravi-view>`, kit: kitFor({ locale: "en" }, { r1: {} }) });
    await page.ravi.ready;
    expect(page.announced()).toBe("3 items loaded.");
  });

  test("ravi.el sets props and attributes without writing HTML, and refuses script URLs", async () => {
    page = await openPage({ body: "" });
    const el = page.ravi.el as (tag: string, props?: Record<string, unknown> | null, ...children: unknown[]) => HTMLElement;
    let clicked = 0;
    const link = el("a", { href: " javascript:alert(1)", className: "x", innerHTML: "<b>no</b>", onclick: "alert(1)", "data-k": "v" }, "texto");
    expect(link.hasAttribute("href")).toBe(false);
    expect(link.innerHTML).toBe("texto");
    expect(link.getAttribute("onclick")).toBeNull();
    expect(link.className).toBe("x");
    expect(link.getAttribute("data-k")).toBe("v");
    expect(el("a", { href: "\u0001java\tscript:alert(1)" }).hasAttribute("href")).toBe(false);
    expect(el("a", { href: "/pedidos?x=1" }).getAttribute("href")).toBe("/pedidos?x=1");
    expect(el("a", { href: "https://example.test/" }).getAttribute("href")).toBe("https://example.test/");
    const button = el("button", { type: "button", onClick: () => (clicked += 1), dataset: { id: "7" } }, el("span", null, "ok"), null, false, 3);
    button.click();
    expect(clicked).toBe(1);
    expect(button.dataset.id).toBe("7");
    expect(button.textContent).toBe("ok3");
  });
});

describe("theme", () => {
  test("ravi.theme exposes locale, density and hash; setMode sets data-theme", async () => {
    page = await openPage({ body: "", kit: kitFor({ theme: { ...THEME, live: false } }), head: '<style id="ravi-theme" data-ravi-theme="hash-old">@layer ravi.theme{}</style>' });
    const theme = page.ravi.theme as { locale: string; density: string; hash: string; setMode: (mode: string) => void };
    expect(theme).toMatchObject({ locale: "pt-BR", density: "compact", hash: "hash-old" });
    expect(page.doc.documentElement.getAttribute("data-ravi-density")).toBe("compact");
    theme.setMode("dark");
    expect(page.doc.documentElement.getAttribute("data-theme")).toBe("dark");
    theme.setMode("auto");
    expect(page.doc.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(page.calls.length).toBe(0);
  });

  test("live theme: one quiet ravi.pages.theme.get (never not_declared, uses need not list it), #ravi-theme swapped when the hash differs", async () => {
    page = await openPage({
      body: "",
      kit: kitFor({ theme: THEME, uses: [] }),
      head: '<style id="ravi-theme" data-ravi-theme="hash-old">@layer ravi.theme{:root{--a:1}}</style>',
      handler: (call) => (call.id === THEME_GET_ID ? { output: { hash: "hash-new", css: "@layer ravi.theme{:root{--a:2}}", locale: "pt-BR", version: 4, ref: "org/acme" } } : undefined),
    });
    await page.flush();
    expect(page.calls.map((call) => call.id)).toEqual([THEME_GET_ID]);
    const style = page.doc.getElementById("ravi-theme");
    expect(style?.textContent).toBe("@layer ravi.theme{:root{--a:2}}");
    expect(style?.getAttribute("data-ravi-theme")).toBe("hash-new");
    expect((page.ravi.theme as { hash: string }).hash).toBe("hash-new");
  });

  test("live theme: same hash or an error keeps the shipped snapshot, quietly", async () => {
    page = await openPage({
      body: "",
      kit: kitFor({ theme: THEME }),
      head: '<style id="ravi-theme" data-ravi-theme="hash-old">old</style>',
      handler: () => ({ status: 503, error: "connector_unavailable" }),
    });
    await page.flush();
    expect(page.doc.getElementById("ravi-theme")?.textContent).toBe("old");
    expect(page.announced()).toBe("");
    expect(page.statusText()).toBe("");
  });
});

describe("capture session", () => {
  test("a thumbnail browser gets a neutral placeholder, no error, no announcement", async () => {
    page = await openPage({
      body: `<ravi-view data-ravi-id="r1" view="${VIEW_ID}"></ravi-view>`,
      kit: kitFor({}, { r1: {} }),
      capture: true,
      handler: () => ({ status: 403, error: "connector_permission_required" }),
    });
    const errors: unknown[] = [];
    page.doc.addEventListener("ravi:error", (event) => errors.push(event));
    await page.ravi.ready;
    const view = page.doc.querySelector("ravi-view") as HTMLElement;
    expect(squash(view.textContent)).toBe("Os dados aparecem quando a página é aberta.");
    expect(view.querySelector(".ravi-error")).toBeNull();
    expect(view.querySelector('[data-ravi-op="retry"]')).toBeNull();
    expect(page.statusText()).toBe("");
    expect(page.announced()).toBe("");
    expect(errors.length).toBe(0);
    expect(page.doc.querySelector('[role="alert"]')).toBeNull();
  });

  test("load errors outside capture: inline text, Tentar de novo for retryable kinds", async () => {
    let fail = true;
    page = await openPage({
      body: `<ravi-view data-ravi-id="r1" view="${VIEW_ID}"></ravi-view>`,
      kit: kitFor({}, { r1: {} }),
      handler: (call) => (call.id === BASES_IDS.query && fail ? { status: 400, error: "cursor_invalid" } : undefined),
    });
    await page.ravi.ready;
    const view = page.doc.querySelector("ravi-view") as HTMLElement;
    expect(view.querySelector(".ravi-error")?.textContent).toBe("Não foi possível carregar os dados.");
    fail = false;
    (view.querySelector('[data-ravi-op="retry"]') as HTMLButtonElement).click();
    await page.flush();
    expect(view.querySelectorAll("li[data-ravi-item]").length).toBe(3);
  });
});

describe("<ravi-widget> and ravi.render", () => {
  const widget = orderWidget();
  const data = { titulo: "Pedido 9", status: "Entregue", valor: 1200 };

  test("keeps an identical prerender and replaces a different one", async () => {
    page = await openPage({ body: "", kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: widget }) });
    const prerender = toHtml(staticNodes(page.rt, widget, data, { idPrefix: "ravi-r1" }));
    await page.close();
    const tag = (inner: string) => `<ravi-widget data-ravi-id="r1" use="org/pedido-card" data='${JSON.stringify(data)}'>${inner}</ravi-widget>`;
    page = await openPage({ body: tag(prerender), kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: widget }) });
    const host = page.doc.querySelector("ravi-widget") as HTMLElement;
    const kept = host.firstElementChild;
    await page.ravi.ready;
    expect(host.firstElementChild).toBe(kept);
    expect(host.querySelector(".ravi-title")?.textContent).toBe("Pedido 9");
    await page.close();
    page = await openPage({ body: tag("<p>velho</p>"), kit: kitFor({}, { r1: { tag: "ravi-widget", widget: "w1", view: null } }, { w1: widget }) });
    await page.ravi.ready;
    expect(page.doc.querySelector("ravi-widget .ravi-title")?.textContent).toBe("Pedido 9");
    expect(page.doc.querySelector("ravi-widget p")?.textContent).not.toBe("velho");
    expect(page.calls.length).toBe(0);
  });

  test("ravi.render returns an element for static data; unknown refs throw not_found", async () => {
    page = await openPage({ body: "", kit: kitFor({}, {}, { w1: widget }) });
    const render = page.ravi.render as (ref: string, data: unknown, opts?: unknown) => HTMLElement;
    const node = render("pedido-card", data, { headingLevel: 3 });
    expect(node.querySelector("h3.ravi-title")?.textContent).toBe("Pedido 9");
    // No capabilities: the update button is left out.
    expect(node.querySelector("button")).toBeNull();
    expect(() => render("nada", data)).toThrow(RaviError);
  });
});

describe("<ravi-form>", () => {
  async function openForm(handler?: Parameters<typeof openPage>[0]["handler"], attrs = 'fields="titulo,status,feito,valor"') {
    page = await openPage({
      body: `<ravi-form data-ravi-id="r1" view="${VIEW_ID}" ${attrs} submit-label="Enviar pedido" success="Pedido recebido."></ravi-form>`,
      kit: kitFor({}, { r1: { tag: "ravi-form" } }),
      fake: new FakeBase(describeOutput(), sampleRows()),
      handler,
    });
    await page.ravi.ready;
    return page.doc.querySelector("ravi-form form") as HTMLFormElement;
  }

  test("a native form of the writable columns in fields order, labeled", async () => {
    const form = await openForm();
    expect(Array.from(form.elements, (control) => (control as HTMLInputElement).name || (control as HTMLElement).tagName)).toEqual(["titulo", "status", "feito", "valor", "BUTTON"]);
    const title = form.querySelector('input[name="titulo"]') as HTMLInputElement;
    expect(form.querySelector(`label[for="${title.id}"]`)?.textContent).toBe("Título *");
    expect(title.required).toBe(true);
    expect((form.querySelector('input[name="valor"]') as HTMLInputElement).type).toBe("number");
    expect(form.querySelector("button")?.textContent).toBe("Enviar pedido");
  });

  test("missing required fields: aria-invalid and aria-describedby, focus on the first", async () => {
    const form = await openForm();
    form.requestSubmit();
    await page?.flush();
    const title = form.querySelector('input[name="titulo"]') as HTMLInputElement;
    expect(title.getAttribute("aria-invalid")).toBe("true");
    const error = page?.doc.getElementById(title.getAttribute("aria-describedby") ?? "");
    expect(error?.textContent).toBe("Obrigatório");
    expect(page?.doc.activeElement).toBe(title);
    expect(page?.calls.some((call) => call.id === BASES_IDS.create)).toBe(false);
    expect(page?.announced()).toBe("Valor inválido.");
  });

  test("server fieldErrors land under their field", async () => {
    const form = await openForm((call) => (call.id === BASES_IDS.create ? { status: 400, error: "validation_failed", fieldErrors: { valor: "Deve ser positivo" } } : undefined));
    (form.querySelector('input[name="titulo"]') as HTMLInputElement).value = "Pedido";
    (form.querySelector('input[name="valor"]') as HTMLInputElement).value = "-3";
    form.requestSubmit();
    await page?.flush();
    const valor = form.querySelector('input[name="valor"]') as HTMLInputElement;
    expect(valor.getAttribute("aria-invalid")).toBe("true");
    expect(page?.doc.getElementById(valor.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Deve ser positivo");
    expect(page?.doc.activeElement).toBe(valor);
    expect(page?.calls.find((call) => call.id === BASES_IDS.create)?.input.values).toEqual({ titulo: "Pedido", feito: false, valor: -3 });
  });

  test("success: the form resets and the success message is shown and announced", async () => {
    const form = await openForm();
    (form.querySelector('input[name="titulo"]') as HTMLInputElement).value = "Pedido novo";
    (form.querySelector('select[name="status"]') as HTMLSelectElement).value = "s-doing";
    form.requestSubmit();
    await page?.flush();
    expect(page?.calls.find((call) => call.id === BASES_IDS.create)?.input).toMatchObject({ values: { titulo: "Pedido novo", status: "s-doing", feito: false } });
    expect((form.querySelector('input[name="titulo"]') as HTMLInputElement).value).toBe("");
    expect(page?.doc.querySelector("ravi-form .ravi-status")?.textContent).toBe("Pedido recebido.");
    expect(page?.announced()).toBe("Pedido recebido.");
  });

  test("submitting from the button: it stays focusable while saving, focus comes back to it, the success is announced", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const form = await openForm(async (call) => {
      if (call.id === BASES_IDS.create) await held;
      return undefined;
    });
    const button = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    (form.querySelector('input[name="titulo"]') as HTMLInputElement).value = "Pedido novo";
    button.focus();
    form.requestSubmit(button);
    await page?.flush();
    // aria-disabled, not disabled: a disabled button would drop the person's focus to the page.
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(form.getAttribute("aria-busy")).toBe("true");
    expect(page?.doc.activeElement).toBe(button);
    // A second submit while saving is ignored.
    form.requestSubmit(button);
    // Focus lost on the way (a browser moving it to the page): it comes back to the button.
    button.blur();
    expect(page?.doc.activeElement).toBe(page?.doc.body);
    release();
    await page?.flush();
    expect(page?.calls.filter((call) => call.id === BASES_IDS.create).length).toBe(1);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(form.hasAttribute("aria-busy")).toBe(false);
    expect(page?.doc.activeElement).toBe(button);
    expect(page?.doc.querySelector("ravi-form .ravi-status")?.textContent).toBe("Pedido recebido.");
    expect(page?.announced()).toBe("Pedido recebido.");
  });

  test("no create capability: says so instead of a form", async () => {
    page = await openPage({
      body: `<ravi-form view="${VIEW_ID}"></ravi-form>`,
      fake: new FakeBase(describeOutput({ type: "list" }, { create: false }), []),
    });
    await page.ravi.ready;
    expect(squash(page.doc.querySelector("ravi-form")?.textContent)).toBe("Você não tem acesso a estes dados.");
  });
});

describe("errors and query text", () => {
  test("kinds by code, then by status", () => {
    const table: Array<[string, number, string]> = [
      ["connector_session_required", 401, "session"],
      ["connector_unauthorized", 401, "session"],
      ["connector_permission_required", 403, "denied"],
      ["base_forbidden", 403, "denied"],
      ["connector_not_allowlisted", 403, "denied"],
      ["not_declared", 0, "denied"],
      ["consent_required", 403, "consent"],
      ["data_paused", 423, "paused"],
      ["data_read_only", 423, "paused"],
      ["base_archived", 410, "paused"],
      ["version_conflict", 409, "conflict"],
      ["payload_invalid", 400, "invalid"],
      ["validation_failed", 400, "invalid"],
      ["unknown_property", 400, "invalid"],
      ["invalid_filter", 400, "invalid"],
      ["cursor_invalid", 400, "invalid"],
      ["idempotency_conflict", 409, "invalid"],
      ["limit_exceeded", 413, "invalid"],
      ["write_escapes_view", 403, "invalid"],
      ["not_found", 404, "gone"],
      ["view_invalid", 409, "gone"],
      ["connector_rate_limited", 429, "busy"],
      ["connector_unavailable", 502, "busy"],
      ["query_timeout", 504, "busy"],
      ["network_error", 0, "busy"],
      ["app_gateway_link_required", 403, "link"],
      ["connector_capability_unsupported", 400, "unsupported"],
      ["something_new", 500, "invalid"],
      ["something_new", 503, "busy"],
    ];
    for (const [code, status, kind] of table) expect([code, errorKind(code, status)]).toEqual([code, kind as ReturnType<typeof errorKind>]);
    const error = new RaviError("version_conflict", { status: 409, requestId: "req", current: { rowId: "r1", version: 2, values: {} } });
    expect(error).toMatchObject({ name: "RaviError", code: "version_conflict", kind: "conflict", retryable: false, status: 409, requestId: "req" });
    expect(error.current?.version).toBe(2);
  });

  test("where: eq-only pairs by column type; sort: up to three keys", () => {
    const columns = [
      ...COLUMNS,
      { key: "dono", name: "Dono", type: "person" as const, config: {}, required: false },
      { key: "tags", name: "Tags", type: "multi_select" as const, config: {}, required: false },
      { key: "prazo", name: "Prazo", type: "date" as const, config: {}, required: false },
      { key: "email", name: "E-mail", type: "email" as const, config: {}, required: false },
    ];
    expect(parseWhere("dono=@me; tags=urgente ;prazo=@today;email=@me;valor=3;titulo=", columns)).toEqual({
      and: [
        { prop: "dono", op: "contains", value: "$viewer.raviUserId" },
        { prop: "tags", op: "contains", value: "urgente" },
        { prop: "prazo", op: "eq", value: "$today" },
        { prop: "email", op: "eq", value: "$viewer.email" },
        { prop: "valor", op: "eq", value: 3 },
        { prop: "titulo", op: "is_empty" },
      ],
    });
    expect(parseWhere("status=@todo", columns)).toEqual({ prop: "status", op: "eq", value: { group: "todo" } });
    expect(() => parseWhere("nada=1", columns)).toThrow(RaviError);
    expect(() => parseWhere("valor=abc", columns)).toThrow(RaviError);
    expect(parseSort("a, -b,c,d")).toEqual([
      { prop: "a", dir: "asc" },
      { prop: "b", dir: "desc" },
      { prop: "c", dir: "asc" },
    ]);
    expect(parseSort("  ")).toBeUndefined();
  });

  test("where operators: != > >= < <= ~ by column type; an operator the column cannot take is invalid_filter", () => {
    const columns = [
      ...COLUMNS,
      { key: "dono", name: "Dono", type: "person" as const, config: {}, required: false },
      { key: "tags", name: "Tags", type: "multi_select" as const, config: {}, required: false },
      { key: "prazo", name: "Prazo", type: "date" as const, config: {}, required: false },
      { key: "aprov", name: "Aprovação", type: "approval" as const, config: {}, required: false },
      { key: "resumo", name: "Resumo", type: "agent" as const, config: {}, required: false },
    ];
    expect(parseWhere("valor>10;valor>=11;valor<20;valor<=21", columns)).toEqual({
      and: [
        { prop: "valor", op: "gt", value: 10 },
        { prop: "valor", op: "gte", value: 11 },
        { prop: "valor", op: "lt", value: 20 },
        { prop: "valor", op: "lte", value: 21 },
      ],
    });
    expect(parseWhere("prazo>2026-01-01;prazo>=@today;prazo<2026-12-31;prazo<=@now", columns)).toEqual({
      and: [
        { prop: "prazo", op: "after", value: "2026-01-01" },
        { prop: "prazo", op: "on_or_after", value: "$today" },
        { prop: "prazo", op: "before", value: "2026-12-31" },
        { prop: "prazo", op: "on_or_before", value: "$now" },
      ],
    });
    expect(parseWhere("titulo~pedido;tags~urgente;dono~@me", columns)).toEqual({
      and: [
        { prop: "titulo", op: "contains", value: "pedido" },
        { prop: "tags", op: "contains", value: "urgente" },
        { prop: "dono", op: "contains", value: "$viewer.raviUserId" },
      ],
    });
    expect(parseWhere("titulo!=x;titulo!=;status!=@done;tags!=urgente;feito!=true;valor!=3;prazo!=@today", columns)).toEqual({
      and: [
        { prop: "titulo", op: "neq", value: "x" },
        { prop: "titulo", op: "is_not_empty" },
        { prop: "status", op: "neq", value: { group: "done" } },
        { prop: "tags", op: "not_contains", value: "urgente" },
        { prop: "feito", op: "eq", value: false },
        { prop: "valor", op: "neq", value: 3 },
        { not: { prop: "prazo", op: "eq", value: "$today" } },
      ],
    });
    expect(parseWhere("aprov=pending;resumo=error", columns)).toEqual({
      and: [
        { prop: "aprov", op: "state_in", value: "pending" },
        { prop: "resumo", op: "state_in", value: "error" },
      ],
    });
    // Spaces around the operator; a value may hold the operator characters.
    expect(parseWhere(" titulo ~ a=b ", columns)).toEqual({ prop: "titulo", op: "contains", value: "a=b" });
    for (const bad of ["titulo>3", "status~todo", "feito<true", "valor~1", "aprov>pending", "nada!=1"]) expect(() => parseWhere(bad, columns)).toThrow(RaviError);
  });
});
