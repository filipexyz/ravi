// Test harness for the Pages runtime: a happy-dom window with a page kit, a
// fake Bases view behind a mocked `fetch` of `/_ravi/connectors/exec`, and
// helpers to wait for the runtime. Used by `*.test.ts` in this folder only.

import { Window } from "happy-dom";

import type { BaseViewColumn, BaseViewDescribeResponse } from "@/shared/bases/types";
import type { CompiledWidget, KitInstance, PageKit } from "@/shared/widgets/types";

import { install, type InstallOptions, type Rt } from "./runtime";
import { BASES_IDS, type ViewRow } from "./view";

export const VIEW_ID = "11111111-1111-4111-8111-111111111111";

export const STATUS = [
  { id: "s-todo", name: "A fazer", color: "gray" as const, group: "todo" as const },
  { id: "s-doing", name: "Fazendo", color: "blue" as const, group: "in_progress" as const },
  { id: "s-done", name: "Feito", color: "green" as const, group: "done" as const },
];

export const COLUMNS: BaseViewColumn[] = [
  { key: "titulo", name: "Título", type: "text", config: {}, required: true },
  { key: "status", name: "Status", type: "status", config: { options: STATUS }, required: false },
  {
    key: "area",
    name: "Área",
    type: "select",
    config: {
      options: [
        { id: "a-ops", name: "Operações", color: "orange" },
        { id: "a-fin", name: "Financeiro", color: "purple" },
      ],
    },
    required: false,
  },
  { key: "feito", name: "Feito", type: "checkbox", config: {}, required: false },
  { key: "valor", name: "Valor", type: "number", config: {}, required: false },
  { key: "capa", name: "Capa", type: "url", config: {}, required: false },
];

export type Caps = Partial<BaseViewDescribeResponse["capabilities"]>;

export function describeOutput(layout: Record<string, unknown> = { type: "list" }, caps: Caps = {}): BaseViewDescribeResponse {
  return {
    id: VIEW_ID,
    baseId: "22222222-2222-4222-8222-222222222222",
    name: "Pedidos",
    description: null,
    layout: layout as BaseViewDescribeResponse["layout"],
    version: 1,
    columns: COLUMNS,
    capabilities: { read: true, aggregateOnly: false, writeColumns: ["titulo", "status", "area", "feito", "valor"], create: true, archive: true, manage: false, approve: [], ...caps },
    valid: true,
  };
}

export function sampleRows(): ViewRow[] {
  return [
    { rowId: "r1", version: 1, values: { titulo: "Pedido 1", status: "s-todo", area: "a-ops", feito: false, valor: 10 } },
    { rowId: "r2", version: 1, values: { titulo: "Pedido 2", status: "s-doing", area: null, feito: true, valor: 20 } },
    { rowId: "r3", version: 1, values: { titulo: "Pedido 3", status: "s-done", area: "a-fin", feito: false, valor: 30 } },
  ];
}

export type Call = { id: string; input: Record<string, unknown>; runtime: string | null };
/** What the fake server answers: an output, or `{ status, error, ...extra }`. */
export type Answer = { output: unknown } | { status: number; error: string; [key: string]: unknown };
export type Handler = (call: Call, fake: FakeBase) => Answer | undefined | Promise<Answer | undefined>;

/** A Bases view in memory: describe, query (one page of `limit`), get, create, update (version checked), archive. */
export class FakeBase {
  rows: ViewRow[];
  describe: BaseViewDescribeResponse;
  bodies: Record<string, string> = {};
  /** What `ravi.bases.charts.data` answers. */
  chart: unknown = null;
  seq = 0;

  constructor(describe: BaseViewDescribeResponse, rows: ViewRow[]) {
    this.describe = describe;
    this.rows = rows;
  }

  answer(call: Call): Answer {
    const { input } = call;
    const row = this.rows.find((candidate) => candidate.rowId === input.rowId);
    switch (call.id) {
      case BASES_IDS.describe:
        return { output: this.describe };
      case BASES_IDS.query: {
        const start = typeof input.cursor === "string" ? Number(input.cursor) : 0;
        const limit = typeof input.limit === "number" ? input.limit : 100;
        const page = this.rows.slice(start, start + limit);
        return { output: { columns: COLUMNS.map((column) => column.key), rows: page, nextCursor: start + limit < this.rows.length ? String(start + limit) : null, users: {} } };
      }
      case BASES_IDS.get:
        return row ? { output: { ...row, body: this.bodies[row.rowId] ?? null, users: {} } } : { status: 404, error: "not_found" };
      case BASES_IDS.create: {
        this.seq += 1;
        const created = { rowId: `new${this.seq}`, version: 1, values: input.values as Record<string, unknown> };
        this.rows = [created, ...this.rows];
        return { output: { rowId: created.rowId, version: 1 } };
      }
      case BASES_IDS.update: {
        if (!row) return { status: 404, error: "not_found" };
        if (row.version !== input.expectedVersion) return { status: 409, error: "version_conflict", current: row };
        const next = { rowId: row.rowId, version: row.version + 1, values: { ...row.values, ...(input.values as object) } };
        if (typeof input.body == "string") this.bodies[row.rowId] = input.body;
        this.rows = this.rows.map((candidate) => (candidate === row ? next : candidate));
        return { output: next };
      }
      case BASES_IDS.version:
        // Changes whenever a row does, like the server's fingerprint.
        return { output: { fingerprint: JSON.stringify(this.rows.map((one) => [one.rowId, one.version])) } };
      case "ravi.bases.charts.data":
        return this.chart ? { output: this.chart } : { status: 404, error: "not_found" };
      case BASES_IDS.archive:
        if (!row) return { status: 404, error: "not_found" };
        this.rows = this.rows.filter((candidate) => candidate !== row);
        return { output: { rowId: row.rowId, archived: true } };
      default:
        return { status: 403, error: "connector_not_allowlisted" };
    }
  }
}

export function kitFor(overrides: Partial<PageKit> = {}, instances: Record<string, Partial<KitInstance>> = {}, widgets: Record<string, CompiledWidget> = {}): PageKit {
  return {
    v: 1,
    runtime: "1.1.0",
    locale: "pt-BR",
    theme: null,
    widgets,
    instances: Object.fromEntries(
      Object.entries(instances).map(([key, value]) => [key, { tag: "ravi-view", view: VIEW_ID, widget: null, fields: {}, variant: "default", ...value } as KitInstance]),
    ),
    actions: Object.values(BASES_IDS).map((id) => ({ id, viewId: VIEW_ID })),
    uses: [...Object.values(BASES_IDS)],
    ...overrides,
  };
}

export type Page = {
  win: Window;
  doc: Document;
  rt: Rt;
  calls: Call[];
  fake: FakeBase;
  ravi: Record<string, unknown> & { ready: Promise<void> };
  /** Lets pending promises and microtasks run. */
  flush: (rounds?: number) => Promise<void>;
  /** The live region's current text. */
  announced: () => string;
  /** The status line's text (closed shadow root, through the runtime's handle). */
  statusText: () => string;
  close: () => Promise<void>;
};

export async function openPage(opts: {
  body: string;
  kit?: PageKit;
  head?: string;
  fake?: FakeBase;
  handler?: Handler;
  capture?: boolean;
  /** Runs on the window before the runtime installs (e.g. Page Chat's `ravi.chat`). */
  before?: (win: Window) => void;
  install?: InstallOptions;
}): Promise<Page> {
  const win = new Window({ url: "https://acme-site.ravi.page/" });
  // happy-dom reports `navigator.webdriver = true`; a person's browser does not.
  Object.defineProperty(win.navigator, "webdriver", { value: opts.capture === true, configurable: true });
  const doc = win.document as unknown as Document;
  const kit = opts.kit ?? kitFor();
  const json = JSON.stringify(kit).replace(/</g, "\\u003c");
  win.document.write(`<!doctype html><html><head><meta charset="utf-8">${opts.head ?? ""}<script type="application/json" id="ravi-kit">${json}</script></head><body>${opts.body}</body></html>`);
  const fake = opts.fake ?? new FakeBase(describeOutput(), sampleRows());
  const calls: Call[] = [];
  const fetchMock = async (url: string, init: RequestInit) => {
    if (url !== "/_ravi/connectors/exec" || init.method !== "POST") throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init.body)) as { id: string; input: Record<string, unknown> };
    const headers = init.headers as Record<string, string>;
    const call: Call = { id: body.id, input: body.input, runtime: headers["x-ravi-runtime"] ?? null };
    calls.push(call);
    const answer = (await opts.handler?.(call, fake)) ?? fake.answer(call);
    if ("output" in answer) return new Response(JSON.stringify({ ok: true, output: answer.output }), { status: 200, headers: { "x-request-id": `req-${calls.length}` } });
    const { status, ...rest } = answer;
    return new Response(JSON.stringify(rest), { status, headers: { "x-request-id": `req-${calls.length}` } });
  };
  (win as unknown as { fetch: unknown }).fetch = fetchMock;
  opts.before?.(win);
  const rt = install(win as unknown as globalThis.Window & typeof globalThis, { sleep: async () => {}, pollMs: 60_000, livePollMs: 60_000, chartMs: 60_000, random: () => 0.5, ...opts.install });
  const flush = async (rounds = 20) => {
    for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    win,
    doc,
    rt,
    calls,
    fake,
    ravi: (win as unknown as { ravi: Page["ravi"] }).ravi,
    flush,
    announced: () => doc.querySelector("[data-ravi-live]")?.textContent ?? "",
    statusText: () => {
      const section = rt.status.root?.querySelector("section");
      return section && !section.hidden ? (section.textContent ?? "") : "";
    },
    close: async () => {
      await win.happyDOM.close();
    },
  };
}

/** Text with whitespace collapsed. */
export const squash = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();
