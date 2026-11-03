import { afterEach, describe, expect, test } from "bun:test";

import { RaviError } from "./errors";
import { describeOutput, FakeBase, kitFor, openPage, sampleRows, squash, VIEW_ID, type Handler, type Page } from "./test-harness";
import { BASES_IDS, type View } from "./view";

let page: Page | null = null;

afterEach(async () => {
  await page?.close();
  page = null;
});

async function open(opts: { attrs?: string; handler?: Handler; kit?: ReturnType<typeof kitFor>; layout?: Record<string, unknown>; caps?: Parameters<typeof describeOutput>[1] } = {}) {
  page = await openPage({
    body: `<ravi-view data-ravi-id="r1" view="${VIEW_ID}" ${opts.attrs ?? ""}></ravi-view>`,
    kit: opts.kit ?? kitFor({}, { r1: {} }),
    fake: new FakeBase(describeOutput(opts.layout, opts.caps), sampleRows()),
    handler: opts.handler,
  });
  await page.ravi.ready;
  return page;
}

const host = (p: Page) => p.doc.querySelector("ravi-view") as HTMLElement;
const viewOf = (p: Page) => (p.ravi.bases as { view: (id: string) => View }).view(VIEW_ID);
const checkbox = (p: Page, rowId: string) => host(p).querySelector(`li[data-ravi-item="${rowId}"] input[data-ravi-edit="feito"]`) as HTMLInputElement;

function toggle(p: Page, rowId: string) {
  const box = checkbox(p, rowId);
  box.focus();
  box.checked = !box.checked;
  box.dispatchEvent(new p.win.Event("change", { bubbles: true }) as unknown as Event);
}

/** A handler that holds update answers until `release()`. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  const handler: Handler = async (call) => {
    if (call.id === BASES_IDS.update) await opened;
    return undefined;
  };
  return { handler, release: () => release() };
}

describe("optimistic writes", () => {
  test("an editor change shows at once as pending, then saves with an idempotency key and keeps focus", async () => {
    const { handler, release } = gate();
    const p = await open({ handler });
    const events: string[] = [];
    host(p).addEventListener("ravi:beforewrite", () => events.push("before"));
    host(p).addEventListener("ravi:write", () => events.push("write"));
    toggle(p, "r1");
    await p.flush();
    const item = host(p).querySelector('li[data-ravi-item="r1"]') as HTMLElement;
    expect(item.getAttribute("aria-busy")).toBe("true");
    expect(item.className).toContain("ravi-pending");
    expect(checkbox(p, "r1").checked).toBe(true);
    release();
    await p.flush();
    const update = p.calls.find((call) => call.id === BASES_IDS.update);
    expect(update?.input).toMatchObject({ rowId: "r1", values: { feito: true }, expectedVersion: 1 });
    expect(host(p).querySelector('li[data-ravi-item="r1"]')?.hasAttribute("aria-busy")).toBe(false);
    expect(checkbox(p, "r1").checked).toBe(true);
    expect(p.doc.activeElement).toBe(checkbox(p, "r1"));
    expect(p.announced()).toBe("Salvo.");
    expect(events).toEqual(["before", "write"]);
  });

  test("a canceled ravi:beforewrite sends nothing", async () => {
    const p = await open();
    host(p).addEventListener("ravi:beforewrite", (event) => event.preventDefault());
    toggle(p, "r1");
    await p.flush();
    expect(p.calls.some((call) => call.id === BASES_IDS.update)).toBe(false);
  });

  test("a failed write is undone, announced and shown with role=alert", async () => {
    const p = await open({ handler: (call) => (call.id === BASES_IDS.update ? { status: 400, error: "payload_invalid" } : undefined) });
    toggle(p, "r1");
    await p.flush();
    expect(checkbox(p, "r1").checked).toBe(false);
    expect(p.announced()).toBe("Não foi possível salvar. A alteração foi desfeita.");
    expect(p.rt.status.root?.querySelector('[role="alert"]')?.textContent).toBe("Não foi possível salvar. A alteração foi desfeita.");
    expect(p.statusText()).toContain("Fechar");
  });

  test("conflict, patched column unchanged on the server: resent once over current.version with a new key", async () => {
    const p = await open();
    // Someone else changed another column: the server now has version 2.
    p.fake.rows = p.fake.rows.map((row) => (row.rowId === "r1" ? { ...row, version: 2, values: { ...row.values, valor: 99 } } : row));
    toggle(p, "r1");
    await p.flush();
    const updates = p.calls.filter((call) => call.id === BASES_IDS.update);
    expect(updates.map((call) => call.input.expectedVersion)).toEqual([1, 2]);
    expect(updates[0]?.input.idempotencyKey).not.toBe(updates[1]?.input.idempotencyKey);
    expect(p.fake.rows.find((row) => row.rowId === "r1")?.values).toMatchObject({ feito: true, valor: 99 });
    expect(p.announced()).toBe("Salvo.");
  });

  test("conflict, patched column changed on the server: current adopted, ravi:conflict fired and announced", async () => {
    const p = await open();
    p.fake.rows = p.fake.rows.map((row) => (row.rowId === "r1" ? { ...row, version: 2, values: { ...row.values, feito: true, titulo: "Pedido 1 (editado)" } } : row));
    const conflicts: unknown[] = [];
    host(p).addEventListener("ravi:conflict", (event) => conflicts.push((event as CustomEvent).detail));
    toggle(p, "r1");
    await p.flush();
    expect(p.calls.filter((call) => call.id === BASES_IDS.update).length).toBe(1);
    expect(conflicts).toEqual([expect.objectContaining({ rowId: "r1", adopted: true })]);
    expect(host(p).querySelector('li[data-ravi-item="r1"] h2')?.textContent).toBe("Pedido 1 (editado)");
    expect(p.announced()).toBe("Alguém mudou esta linha");
  });

  test("conflict without row reads: nothing resent; the status line offers Reaplicar, which writes over current.version", async () => {
    const p = await open({
      handler: (call, fake) =>
        call.id === BASES_IDS.update && call.input.expectedVersion === 1 ? { status: 409, error: "version_conflict", current: { rowId: "r1", version: 5 } } : fake.answer(call),
    });
    p.fake.rows = p.fake.rows.map((row) => (row.rowId === "r1" ? { ...row, version: 5 } : row));
    toggle(p, "r1");
    await p.flush();
    expect(p.calls.filter((call) => call.id === BASES_IDS.update).length).toBe(1);
    expect(p.rt.status.root?.querySelector('[role="alert"]')?.textContent).toBe("Alguém mudou esta linha");
    expect(Array.from(p.rt.status.root?.querySelectorAll("button") ?? [], (button) => button.textContent)).toEqual(["Reaplicar", "Fechar"]);
    const reapply = Array.from(p.rt.status.root?.querySelectorAll("button") ?? []).find((button) => button.textContent === "Reaplicar") as HTMLButtonElement;
    reapply.click();
    await p.flush();
    const updates = p.calls.filter((call) => call.id === BASES_IDS.update);
    expect(updates.map((call) => call.input.expectedVersion)).toEqual([1, 5]);
    expect(p.fake.rows.find((row) => row.rowId === "r1")?.values.feito).toBe(true);
    expect(p.statusText()).toBe("");
  });

  test("two changes to one row inside one round trip: the second waits for the first and goes out over its version", async () => {
    const { handler, release } = gate();
    const p = await open({ handler });
    const conflicts: unknown[] = [];
    host(p).addEventListener("ravi:conflict", (event) => conflicts.push(event));
    toggle(p, "r1");
    await p.flush();
    toggle(p, "r1");
    await p.flush();
    // The page shows the latest choice at once; only the first write is out.
    expect(checkbox(p, "r1").checked).toBe(false);
    expect(p.calls.filter((call) => call.id === BASES_IDS.update).length).toBe(1);
    release();
    await p.flush();
    const updates = p.calls.filter((call) => call.id === BASES_IDS.update);
    expect(updates.map((call) => [call.input.values, call.input.expectedVersion])).toEqual([
      [{ feito: true }, 1],
      [{ feito: false }, 2],
    ]);
    expect(p.fake.rows.find((row) => row.rowId === "r1")).toMatchObject({ version: 3, values: { feito: false } });
    expect(checkbox(p, "r1").checked).toBe(false);
    expect(host(p).querySelector('li[data-ravi-item="r1"]')?.hasAttribute("aria-busy")).toBe(false);
    expect(conflicts).toEqual([]);
    expect(p.announced()).toBe("Salvo.");
  });

  test("a change queued behind a write that conflicted is judged against what the person saw", async () => {
    const { handler, release } = gate();
    const p = await open({ handler });
    // Someone else moved r1 to Feito (v2) before either write.
    p.fake.rows = p.fake.rows.map((row) => (row.rowId === "r1" ? { ...row, version: 2, values: { ...row.values, status: "s-done" } } : row));
    const conflicts: unknown[] = [];
    host(p).addEventListener("ravi:conflict", (event) => conflicts.push((event as CustomEvent).detail));
    const first = viewOf(p).update("r1", { status: "s-doing" }, { target: host(p) });
    const second = viewOf(p).update("r1", { status: "s-todo" }, { target: host(p) });
    release();
    await Promise.allSettled([first, second]);
    await p.flush();
    // Both went out over the version the person saw; neither overwrote the other person's change.
    expect(p.calls.filter((call) => call.id === BASES_IDS.update).map((call) => call.input.expectedVersion)).toEqual([1, 1]);
    expect(p.fake.rows.find((row) => row.rowId === "r1")?.values.status).toBe("s-done");
    expect(conflicts.length).toBe(2);
    expect(host(p).querySelector('li[data-ravi-item="r1"] [data-ravi-field="status"]')?.getAttribute("data-ravi-value")).toBe("Feito");
  });

  test("a write from a ravi:conflict listener goes out over the adopted row, not the failed write's", async () => {
    const p = await open();
    p.fake.rows = p.fake.rows.map((row) => (row.rowId === "r1" ? { ...row, version: 2, values: { ...row.values, feito: true } } : row));
    let retried: Promise<unknown> | null = null;
    host(p).addEventListener("ravi:conflict", () => {
      retried ??= viewOf(p).update("r1", { status: "s-todo" }, { target: host(p) });
    });
    await viewOf(p).update("r1", { feito: true }, { target: host(p) }).catch(() => undefined);
    expect(retried).not.toBeNull();
    expect(await retried).toMatchObject({ rowId: "r1", version: 3 });
    expect(p.calls.filter((call) => call.id === BASES_IDS.update).map((call) => call.input.expectedVersion)).toEqual([1, 2]);
    expect(p.fake.rows.find((row) => row.rowId === "r1")).toMatchObject({ version: 3, values: { feito: true, status: "s-todo" } });
  });

  test("an archive right after a change waits for it and archives over the version it returned", async () => {
    const { handler, release } = gate();
    const p = await open({ handler });
    const updated = viewOf(p).update("r2", { feito: false });
    const archived = viewOf(p).archive("r2");
    release();
    expect(await updated).toMatchObject({ rowId: "r2", version: 2 });
    expect(await archived).toBe(true);
    expect(p.calls.find((call) => call.id === BASES_IDS.archive)?.input).toMatchObject({ rowId: "r2", expectedVersion: 2 });
    expect(p.fake.rows.some((row) => row.rowId === "r2")).toBe(false);
  });

  test("create through the API: a temporary row while saving, then the server's row", async () => {
    const { handler, release } = gate();
    const p = await open({
      handler: async (call, fake) => {
        if (call.id === BASES_IDS.create) await handler({ ...call, id: BASES_IDS.update }, fake);
        return undefined;
      },
    });
    const created = viewOf(p).create({ titulo: "Novo" });
    await p.flush();
    const temp = host(p).querySelector("li[aria-busy]") as HTMLElement;
    expect(temp.textContent).toContain("Novo");
    release();
    expect(await created).toMatchObject({ rowId: "new1", version: 1 });
    await p.flush();
    expect(host(p).querySelector('li[data-ravi-item="new1"]')).not.toBeNull();
    expect(p.calls.find((call) => call.id === BASES_IDS.create)?.input.idempotencyKey).toBeString();
  });

  test("archive: not_found after an exec retry counts as archived", async () => {
    let attempts = 0;
    const p = await open({
      handler: (call) => {
        if (call.id !== BASES_IDS.archive) return undefined;
        attempts += 1;
        return attempts === 1 ? { status: 503, error: "connector_unavailable" } : { status: 404, error: "not_found" };
      },
    });
    expect(await viewOf(p).archive("r2")).toBe(true);
    await p.flush();
    expect(host(p).querySelector('li[data-ravi-item="r2"]')).toBeNull();
  });
});

describe("exec client", () => {
  test("not_declared: a Bases id for a view the kit does not declare is refused locally", async () => {
    page = await openPage({
      body: `<ravi-view view="${VIEW_ID}"></ravi-view>`,
      kit: kitFor({ actions: [{ id: BASES_IDS.describe, viewId: VIEW_ID }], uses: [] }),
    });
    await page.ravi.ready;
    const ids = page.calls.map((call) => call.id);
    expect(ids).toEqual([BASES_IDS.describe]);
    expect(squash(host(page).textContent)).toBe("Você não tem acesso a estes dados.");
    const error = await viewOf(page)
      .query()
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(RaviError);
    expect(error).toMatchObject({ code: "not_declared", kind: "denied", status: 0, retryable: false });
    const other = await (page.ravi.exec as (id: string, input: unknown) => Promise<unknown>)(BASES_IDS.query, { viewId: "33333333-3333-4333-8333-333333333333" }).catch((thrown: unknown) => thrown);
    expect(other).toMatchObject({ code: "not_declared" });
    expect(page.calls.length).toBe(1);
  });

  test("429, 503 and network errors retry after 2, 4 and 8 s with jitter and the same input", async () => {
    const delays: number[] = [];
    let attempts = 0;
    page = await openPage({
      body: "",
      handler: (call) => {
        if (call.id !== BASES_IDS.update) return undefined;
        attempts += 1;
        if (attempts === 1) return { status: 429, error: "connector_rate_limited" };
        if (attempts === 2) throw new Error("offline");
        if (attempts === 3) return { status: 503, error: "connector_unavailable" };
        return { output: { rowId: "r1", version: 2, values: {} } };
      },
      install: { sleep: async (ms) => void delays.push(ms), random: () => 1 },
    });
    await viewOf(page).update("r1", { feito: true }, { expectedVersion: 1 });
    const updates = page.calls.filter((call) => call.id === BASES_IDS.update);
    expect(updates.length).toBe(4);
    expect(new Set(updates.map((call) => call.input.idempotencyKey)).size).toBe(1);
    // random() = 1 gives the top of the ±25% jitter.
    expect(delays).toEqual([2500, 5000, 10000]);
  });

  test("after the retries, the error reaches the page with its kind and request id", async () => {
    page = await openPage({ body: "", handler: () => ({ status: 503, error: "connector_unavailable" }) });
    const errors: unknown[] = [];
    page.doc.addEventListener("ravi:error", (event) => errors.push((event as CustomEvent).detail));
    const error = await (page.ravi.exec as (id: string, input: unknown) => Promise<unknown>)("ravi.mail.send", {}).catch((thrown: unknown) => thrown);
    expect(error).toMatchObject({ code: "connector_unavailable", kind: "busy", retryable: true, status: 503, requestId: "req-4" });
    expect(page.calls.length).toBe(4);
    expect(errors).toEqual([expect.objectContaining({ code: "connector_unavailable", kind: "busy" })]);
  });

  test("session expiry: the status line says so and offers Continuar; editors go away", async () => {
    const p = await open({ handler: (call) => (call.id === BASES_IDS.update ? { status: 401, error: "connector_session_required" } : undefined) });
    toggle(p, "r1");
    await p.flush();
    expect(p.rt.status.root?.querySelector('[role="alert"]')?.textContent).toBe("Sua sessão nesta página terminou.");
    expect(host(p).querySelector("input[data-ravi-edit]")).toBeNull();
    expect(Array.from(p.rt.status.root?.querySelectorAll("button") ?? [], (button) => button.textContent)).toEqual(["Continuar"]);
    // The section is the labeled region "esta página".
    expect(p.rt.status.root?.querySelector("section")?.getAttribute("aria-label")).toBe("esta página");
  });

  test("link kind: explains ravi link in the status line", async () => {
    page = await openPage({ body: "", handler: () => ({ status: 403, error: "app_gateway_link_required" }) });
    await (page.ravi.exec as (id: string, input: unknown) => Promise<unknown>)("ravi.mail.send", {}).catch(() => {});
    expect(page.rt.status.root?.querySelector('[role="alert"]')?.textContent).toBe("Esta ação precisa do seu Ravi conectado: rode ravi link no terminal e tente de novo.");
    expect(page.announced()).toBe("Esta ação precisa do seu Ravi conectado: rode ravi link no terminal e tente de novo.");
  });

  test("paused data: status line (role=status) and the view stops offering writes", async () => {
    const p = await open({ handler: (call) => (call.id === BASES_IDS.update ? { status: 423, error: "data_paused" } : undefined) });
    toggle(p, "r1");
    await p.flush();
    expect(p.statusText()).toBe("Dados pausados pelo operador");
    expect(p.rt.status.root?.querySelector('[role="status"]')).not.toBeNull();
    expect(viewOf(p).can("update", "feito")).toBe(false);
    expect(host(p).querySelector("input[data-ravi-edit]")).toBeNull();
  });
});

describe("View API", () => {
  test("describe is cached; can() follows capabilities and declared ids; format() uses the column", async () => {
    page = await openPage({ body: "", fake: new FakeBase(describeOutput({ type: "list" }, { writeColumns: ["status"], archive: false }), sampleRows()) });
    const view = viewOf(page);
    expect(view.can("read")).toBeNull();
    await Promise.all([view.describe(), view.describe()]);
    await view.describe();
    expect(page.calls.filter((call) => call.id === BASES_IDS.describe).length).toBe(1);
    expect(view.can("read")).toBe(true);
    expect(view.can("update", "status")).toBe(true);
    expect(view.can("update", "titulo")).toBe(false);
    expect(view.can("archive")).toBe(false);
    expect(view.can("create")).toBe(true);
    expect(view.format({ values: { status: "s-doing" } }, "status")).toBe("Fazendo");
    expect(view.format({ values: { valor: 1234.5 } }, "valor")).toBe("1.234,5");
    const result = await view.query({ where: "status=s-todo", limit: 900 });
    expect(page.calls.at(-1)?.input).toMatchObject({ filter: { prop: "status", op: "eq", value: "s-todo" }, limit: 500 });
    expect(result.rows.length).toBe(3);
  });

  test("without ravi.bases.views.version declared: watch polls every interval while visible, one poller per view, and stops", async () => {
    page = await openPage({ body: "", install: { pollMs: 20 }, kit: kitFor({ actions: Object.values(BASES_IDS).filter((id) => id !== BASES_IDS.version).map((id) => ({ id, viewId: VIEW_ID })) }) });
    const view = viewOf(page);
    const seen: number[] = [];
    const stop = view.watch({}, (rows) => seen.push(rows.length));
    await stop.ready;
    expect(seen).toEqual([3]);
    const queries = () => page?.calls.filter((call) => call.id === BASES_IDS.query).length ?? 0;
    const hidden = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(page.doc), "hidden");
    Object.defineProperty(page.doc, "hidden", { configurable: true, get: () => true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(queries()).toBe(1);
    Object.defineProperty(page.doc, "hidden", { configurable: true, get: () => false });
    if (hidden) delete (page.doc as unknown as Record<string, unknown>).hidden;
    page.fake.rows = page.fake.rows.slice(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(queries()).toBeGreaterThan(1);
    expect(seen.at(-1)).toBe(2);
    stop();
    const after = queries();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(queries()).toBe(after);
  });

  test("near-live: the version fingerprint is read every livePollMs; the rows are read again only when it changes", async () => {
    page = await openPage({ body: "", install: { livePollMs: 15, pollMs: 60_000 } });
    const view = viewOf(page);
    const seen: number[] = [];
    const stop = view.watch({}, (rows) => seen.push(rows.length));
    await stop.ready;
    const count = (id: string) => page?.calls.filter((call) => call.id === id).length ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Several version reads; the first one only sets the baseline (one refresh), the rest match it.
    expect(count(BASES_IDS.version)).toBeGreaterThan(2);
    expect(count(BASES_IDS.query)).toBe(2);
    page.fake.rows = page.fake.rows.slice(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(count(BASES_IDS.query)).toBe(3);
    expect(seen.at(-1)).toBe(2);
    stop();
    const after = count(BASES_IDS.version);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(count(BASES_IDS.version)).toBe(after);
  });

  test("near-live: a refused version read falls back to the 30 s poll, quietly", async () => {
    page = await openPage({
      body: "",
      install: { livePollMs: 15, pollMs: 40 },
      handler: (call) => (call.id === BASES_IDS.version ? { status: 403, error: "connector_not_allowlisted" } : undefined),
    });
    const errors: unknown[] = [];
    page.doc.addEventListener("ravi:error", (event) => errors.push(event));
    const view = viewOf(page);
    const stop = view.watch({}, () => {});
    await stop.ready;
    await new Promise((resolve) => setTimeout(resolve, 150));
    // One refusal, then the classic poller reads the rows every pollMs and never asks for the version again.
    expect(page.calls.filter((call) => call.id === BASES_IDS.version).length).toBe(1);
    expect(page.calls.filter((call) => call.id === BASES_IDS.query).length).toBeGreaterThan(1);
    expect(errors).toEqual([]);
    expect(page.statusText()).toBe("");
    stop();
  });

  test("polls skip once the page used most of its 60 calls in the last minute", async () => {
    page = await openPage({ body: "" });
    const view = viewOf(page);
    const stop = view.watch({}, () => {});
    await stop.ready;
    for (let index = 0; index < 44; index += 1) await page.rt.exec.exec("ravi.mail.list", {}).catch(() => {});
    expect(page.rt.exec.used()).toBe(45);
    const before = page.calls.length;
    await view.tick();
    expect(page.calls.length).toBe(before);
    stop();
  });

  test("ravi.bases.view refuses ids that are not UUIDs", async () => {
    page = await openPage({ body: "" });
    expect(() => (page?.ravi.bases as { view: (id: string) => View }).view("pedidos")).toThrow(RaviError);
  });
});
