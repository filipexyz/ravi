// `ravi.bases.view(uuid)`: one Bases view through the exec endpoint, with a
// cached describe, the newest version seen of each row, optimistic writes and
// one poller per view. Live queries (`watch`, the `<ravi-view>` element) see
// rows through `project()`: pending writes on top, archived rows gone.
//
// Writes follow pages-dados/detalhes.md: a new idempotency key per logical
// write (exec retries reuse it); a version conflict whose patched columns did
// not change in `current` is resent once on `current.version` with a new key,
// otherwise `current` is adopted and announced; without row reads (`current`
// has no values) nothing is resent and the status line offers "Reaplicar".
// Archive has no key: a `not_found` after an exec retry counts as done.
// Writes to one row go out one at a time (see `serial`). A `body` key in the
// values goes out as the row body.
//
// Near-live: when the kit declares `ravi.bases.views.version` for the view,
// the poller asks for the view's fingerprint every 5 s while the page is
// visible and re-reads the live queries only when it changed; otherwise (or
// once the version is refused) it re-reads them every 30 s.

import type { BaseFilter, BaseSort, BaseUserRef, BaseViewColumn, BaseViewDescribeResponse } from "@/shared/bases/types";
import { formatValue } from "@/shared/widgets/render/format";

import { asRaviError, RaviError } from "./errors";
import type { ExecMeta } from "./exec";
import { parseSort, parseWhere } from "./query";
import type { Rt } from "./runtime";

export const BASES_IDS = {
  describe: "ravi.bases.views.describe",
  query: "ravi.bases.views.query",
  get: "ravi.bases.views.rows.get",
  create: "ravi.bases.views.rows.create",
  update: "ravi.bases.views.rows.update",
  archive: "ravi.bases.views.rows.archive",
  version: "ravi.bases.views.version",
} as const;

export const POLL_MS = 30_000;
export const LIVE_POLL_MS = 5_000;
/** Polls skip a tick once the page used this many of its 60 calls in the last minute. */
const POLL_BUDGET_CEILING = 45;
const QUERY_LIMIT_MAX = 500;

export type ViewRow = {
  rowId: string;
  version: number;
  values: Record<string, unknown>;
  body?: string | null;
  /** A write on this row (or its creation, with version 0) is in flight. */
  pending?: boolean;
};

export type ViewInfo = BaseViewDescribeResponse & {
  col(key: string): BaseViewColumn | undefined;
  /** First projected text column. */
  titleKey: string | null;
};

export type QueryOptions = {
  filter?: BaseFilter | null;
  /** `key=value;key2=@me` (see query.ts). */
  where?: string | null;
  sort?: BaseSort[] | string | null;
  /** Case-insensitive contains over the view's text-like columns (1..200 chars). */
  search?: string | null;
  limit?: number;
  cursor?: string | null;
};

export type QueryResult = { columns: string[]; rows: ViewRow[]; nextCursor: string | null; users: Record<string, BaseUserRef> };

export type WriteOptions = {
  /** Receives the `ravi:*` events (default: the document). */
  target?: EventTarget | null;
  expectedVersion?: number;
  /** No announcement or status line (events still fire). */
  quiet?: boolean;
  /** Announcement on success instead of "Salvo.". */
  saved?: string;
};

export type ViewOp = "read" | "get" | "create" | "update" | "archive";

/** A live query: the rows it loaded (projected), more pages, re-reads. */
export type Live = {
  readonly rows: ViewRow[];
  nextCursor: string | null;
  load(): Promise<void>;
  /** The next page; resolves with the number of new rows. */
  more(): Promise<number>;
  /** Re-reads everything loaded so far (up to 500 rows) in one query. */
  refresh(): Promise<void>;
  stop(): void;
};

type LiveState = Live & { server: ViewRow[]; stamp: number; loaded: boolean; emit(): void };

export type View = {
  readonly id: string;
  readonly info: ViewInfo | null;
  readonly users: Record<string, BaseUserRef>;
  paused: boolean;
  describe(): Promise<ViewInfo>;
  query(opts?: QueryOptions): Promise<QueryResult>;
  /** One row with its body (`rows.get`). */
  get(rowId: string): Promise<ViewRow>;
  /** Loads, then re-reads on change (near-live) or every 30 s while the page is visible. Returns `stop()` (with `ready` and `more()`). */
  watch(opts: QueryOptions, cb: (rows: ViewRow[]) => void): (() => void) & { ready: Promise<void>; more: () => Promise<number> };
  live(opts: QueryOptions, cb: (rows: ViewRow[]) => void): Live;
  create(values: Record<string, unknown>, opts?: WriteOptions): Promise<ViewRow | null>;
  update(rowId: string, values: Record<string, unknown>, opts?: WriteOptions): Promise<ViewRow | null>;
  archive(rowId: string, opts?: WriteOptions): Promise<boolean>;
  /** `true`, `false`, or `null` before describe answers. */
  can(op: ViewOp, key?: string): boolean | null;
  /** The server refused `op` (`denied`): stop offering it. */
  deny(op: ViewOp): void;
  format(row: Pick<ViewRow, "values">, key: string): string;
  notify(): void;
  /** One poll: re-reads the live queries older than the poll interval. */
  tick(): Promise<void>;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const noop = () => {};
const clampLimit = (limit: number) => Math.min(QUERY_LIMIT_MAX, Math.max(1, Math.floor(limit)));

export function createView(rt: Rt, id: string): View {
  const users: Record<string, BaseUserRef> = {};
  const latest = new Map<string, ViewRow>();
  const overlays = new Map<string, Array<{ values: Record<string, unknown>; archived: boolean }>>();
  const created: ViewRow[] = [];
  const gone = new Set<string>();
  const denied = new Set<ViewOp>();
  const lives = new Set<LiveState>();
  let info: ViewInfo | null = null;
  let described: Promise<ViewInfo> | null = null;
  let timer: number | null = null;
  let polling = false;
  let seq = 0;
  /** Last fingerprint seen; `slow` once the server refused the version (back to the 30 s poll). */
  let fingerprint: string | null = null;
  let slow = false;

  const call = (name: keyof typeof BASES_IDS, input: Record<string, unknown>, meta?: ExecMeta) => rt.exec.exec(BASES_IDS[name], { viewId: id, ...input }, meta);
  const near = () => !slow && rt.exec.declared(BASES_IDS.version, { viewId: id });
  /** `values` with a `body` key as the row input: the body goes apart. */
  const split = (values: Record<string, unknown>) => {
    const { body, ...rest } = values;
    return "body" in values ? { values: rest, body } : { values };
  };
  const notify = () => lives.forEach((live) => live.emit());

  /** Keeps the newest version of each row; an older one (a poll that raced a write) gives the newer. */
  const seen = (row: ViewRow) => {
    const known = latest.get(row.rowId);
    if (known && known.version > row.version) return known;
    latest.set(row.rowId, row);
    return row;
  };

  const project = (rows: readonly ViewRow[]) => {
    const out = [...created];
    for (const row of rows) {
      const list = overlays.get(row.rowId) ?? [];
      if (gone.has(row.rowId) || list.some((entry) => entry.archived)) continue;
      const base = seen(row);
      out.push(list.length ? { ...base, values: Object.assign({ ...base.values }, ...list.map((entry) => entry.values)), pending: true } : base);
    }
    return out;
  };

  const augment = (output: BaseViewDescribeResponse): ViewInfo => {
    const columns = output.columns ?? [];
    return {
      ...output,
      columns,
      col: (key) => columns.find((column) => column.key == key),
      titleKey: columns.find((column) => column.type == "text")?.key ?? null,
    };
  };

  const query = async (opts: QueryOptions = {}): Promise<QueryResult> => {
    const input: Record<string, unknown> = {};
    const filter = opts.filter ?? (opts.where ? parseWhere(opts.where, (await view.describe()).columns) : null);
    const sort = typeof opts.sort === "string" ? parseSort(opts.sort) : opts.sort;
    if (filter) input.filter = filter;
    if (sort?.length) input.sort = sort;
    const search = opts.search?.trim().slice(0, 200);
    if (search) input.search = search;
    if (opts.limit) input.limit = clampLimit(opts.limit);
    if (opts.cursor) input.cursor = opts.cursor;
    const output = (await call("query", input)) as QueryResult;
    Object.assign(users, output.users);
    return { ...output, rows: (output.rows ?? []).map(seen) };
  };

  const live = (opts: QueryOptions, cb: (rows: ViewRow[]) => void): Live => {
    const limit = clampLimit(opts.limit ?? 100);
    const read = async (count: number, cursor?: string | null) => {
      const result = await query({ ...opts, limit: count, cursor });
      state.stamp = rt.now();
      state.nextCursor = result.nextCursor;
      return result.rows;
    };
    const state: LiveState = {
      server: [],
      nextCursor: null,
      stamp: 0,
      loaded: false,
      get rows() {
        return project(state.server);
      },
      emit: () => state.loaded && cb(state.rows),
      load: async () => {
        state.server = await read(limit);
        state.loaded = true;
        state.emit();
      },
      more: async () => {
        if (!state.nextCursor) return 0;
        const rows = (await read(limit, state.nextCursor)).filter((row) => !state.server.some((known) => known.rowId === row.rowId));
        state.server = [...state.server, ...rows];
        state.emit();
        return rows.length;
      },
      refresh: async () => {
        state.server = await read(clampLimit(Math.max(limit, state.server.length)));
        state.emit();
      },
      stop: () => {
        lives.delete(state);
        schedule();
      },
    };
    lives.add(state);
    schedule();
    return state;
  };

  const schedule = (reset?: boolean) => {
    if (timer !== null && (reset || !lives.size)) {
      rt.win.clearInterval(timer);
      timer = null;
    }
    if (lives.size && timer === null && !rt.capture) timer = rt.win.setInterval(() => void view.tick(), near() ? rt.livePollMs : rt.pollMs);
  };

  // -------------------------------------------------------------------------
  // Writes

  const fire = (opts: WriteOptions, type: string, detail: Record<string, unknown>, cancelable?: boolean) =>
    rt.fire(opts.target, type, { viewId: id, ...detail }, cancelable);

  const done = (opts: WriteOptions, detail: Record<string, unknown>) => {
    if (!opts.quiet) rt.announce(opts.saved ?? rt.msgs.saved);
    fire(opts, "ravi:write", detail);
  };

  const overlay = (rowId: string, values: Record<string, unknown>, archived: boolean) => {
    const entry = { values, archived };
    overlays.set(rowId, [...(overlays.get(rowId) ?? []), entry]);
    notify();
    return () => {
      const rest = (overlays.get(rowId) ?? []).filter((other) => other !== entry);
      if (rest.length) overlays.set(rowId, rest);
      else overlays.delete(rowId);
    };
  };

  const store = (row: ViewRow) => {
    const clean: ViewRow = { rowId: row.rowId, version: row.version, values: row.values ?? {} };
    if (row.body !== undefined) clean.body = row.body;
    latest.set(row.rowId, clean);
    for (const state of lives) state.server = state.server.map((known) => (known.rowId === row.rowId ? clean : known));
    return clean;
  };

  const drop = (rowId: string) => {
    gone.add(rowId);
    for (const state of lives) state.server = state.server.filter((row) => row.rowId !== rowId);
  };

  const versionOf = (row: ViewRow | null | undefined, opts: WriteOptions) => {
    const version = opts.expectedVersion ?? row?.version;
    if (!version) throw new RaviError("payload_invalid");
    return version;
  };

  /** Per row, the row the next write goes out over (see `serial`). */
  const queued = new Map<string, Promise<ViewRow | null>>();

  /**
   * Writes to one row go out one at a time: `job` runs once the row's earlier
   * writes settle, over the row the last of them left (the row it stored; when
   * it failed, the row it went out over with the values the person saw,
   * `shown`). A change made while another is in flight so goes out over the
   * version that one returned instead of conflicting with it, and a conflict
   * is still judged against what the person saw.
   */
  const serial = <T extends ViewRow | null>(rowId: string, shown: Record<string, unknown>, job: (base: ViewRow | null) => Promise<T>) => {
    let base: ViewRow | null = null;
    const run = (queued.get(rowId) ?? Promise.resolve(null)).then((row) => job((base = row ?? latest.get(rowId) ?? null)));
    // The entry goes as `run` settles, before the caller's own handlers: a
    // write made from them (a `ravi:conflict` listener) must not chain onto it.
    const clear = () => queued.get(rowId) === next && queued.delete(rowId);
    const next: Promise<ViewRow | null> = run.then(
      (row) => (clear(), row ?? base),
      () => (clear(), base && { ...base, values: { ...base.values, ...shown } }),
    );
    queued.set(rowId, next);
    return run;
  };

  const key = () => rt.win.crypto?.randomUUID?.() ?? `ravi-${rt.now().toString(36)}-${(seq += 1)}-${Math.random().toString(36).slice(2, 10)}`;

  const readable = (error: RaviError) => Object.keys(error.current?.values ?? {}).length > 0;

  /** Reacts to a failed write and gives the error back to throw. `values` given: a conflict may offer "Reaplicar". */
  const fail = (error: RaviError, op: ViewOp, opts: WriteOptions, rowId?: string, values?: Record<string, unknown>) => {
    const current = error.current;
    if (error.kind === "conflict") {
      const adopted = readable(error);
      if (current && adopted) store(current);
      fire(opts, "ravi:conflict", { rowId, values, current: current ?? null, adopted });
      if (!opts.quiet) {
        rt.announce(rt.msgs.conflict);
        if (!adopted && values && rowId) {
          rt.status.show("error", rt.msgs.conflict, {
            label: rt.msgs.reapply,
            run: () => void view.update(rowId, values, { ...opts, expectedVersion: current?.version }).catch(noop),
          });
        }
      }
    } else rt.report(error, { target: opts.target, view, op, quiet: opts.quiet });
    if (error.code === "not_found" && rowId) drop(rowId);
    notify();
    return error;
  };

  const send = async (rowId: string, values: Record<string, unknown>, expectedVersion: number, base: ViewRow | null, resent: boolean): Promise<ViewRow> => {
    try {
      return (await call("update", { rowId, ...split(values), expectedVersion, idempotencyKey: key() })) as ViewRow;
    } catch (thrown) {
      const error = asRaviError(thrown);
      const current = error.current;
      // The patched columns did not change in `current`: resend once over it, with a new key.
      if (error.code === "version_conflict" && current && base && !resent && readable(error) && Object.keys(values).every((name) => same(current.values[name], base.values[name]))) {
        return send(rowId, values, current.version, current, true);
      }
      throw error;
    }
  };

  const view: View = {
    id,
    users,
    paused: false,
    get info() {
      return info;
    },
    describe: () =>
      (described ??= call("describe", {}).then(
        (output) => (info = augment(output as BaseViewDescribeResponse)),
        (error: unknown) => {
          described = null;
          throw asRaviError(error);
        },
      )),
    query,
    get: async (rowId) => {
      const { users: more, ...row } = (await call("get", { rowId })) as ViewRow & { users?: Record<string, BaseUserRef> };
      Object.assign(users, more);
      return seen(row);
    },
    live,
    watch: (opts, cb) => {
      const state = live(opts, cb);
      const ready = state.load().catch((error: unknown) => rt.report(asRaviError(error), { view, op: "read" }));
      return Object.assign(() => state.stop(), { ready, more: () => state.more() });
    },
    tick: async () => {
      if (polling || rt.doc.hidden || rt.sessionExpired || rt.exec.used() >= POLL_BUDGET_CEILING) return;
      polling = true;
      // A failed poll stays quiet unless it changes what the page can do.
      const quiet = (error: unknown) => {
        const failure = asRaviError(error);
        if (failure.kind === "session" || failure.kind === "paused") rt.report(failure, { view, op: "read" });
        return failure;
      };
      try {
        const live = near();
        if (live) {
          let next: unknown;
          try {
            next = ((await call("version", {})) as { fingerprint?: unknown }).fingerprint;
          } catch (error) {
            // Refused (an older host allowlist, a view without row reads): back to the 30 s poll.
            if (/^(denied|gone|unsupported|invalid)$/.test(quiet(error).kind)) {
              slow = true;
              schedule(true);
            }
            return;
          }
          if (next === fingerprint) return;
          fingerprint = typeof next == "string" ? next : null;
        }
        for (const state of lives) {
          if (!state.loaded || (!live && rt.now() - state.stamp < rt.pollMs - 1000)) continue;
          await state.refresh().catch(quiet);
        }
      } finally {
        polling = false;
      }
    },
    can: (op, column) => {
      if (!info) return null;
      const caps = info.capabilities;
      const ok = (name: keyof typeof BASES_IDS) => !rt.sessionExpired && !denied.has(op) && rt.exec.declared(BASES_IDS[name], { viewId: id });
      if (op === "read" || op === "get") return caps.read && ok(op === "read" ? "query" : "get");
      if (view.paused || !ok(op)) return false;
      return op === "update" ? (column === undefined ? caps.writeColumns.length > 0 : caps.writeColumns.includes(column)) : caps[op];
    },
    deny: (op) => {
      denied.add(op);
      notify();
    },
    format: (row, name) => {
      const column = info?.col(name);
      return column
        ? formatValue({ key: name, name: column.name, type: column.type, config: column.config ?? {} }, row.values[name], {
            locale: rt.locale,
            timeZone: rt.timeZone,
            now: new Date(rt.now()),
            users,
          })
        : "";
    },
    notify,
    update: async (rowId, values, opts = {}) => {
      versionOf(latest.get(rowId), opts);
      if (!fire(opts, "ravi:beforewrite", { op: "update", rowId, values }, true)) return null;
      const release = overlay(rowId, values, false);
      try {
        const row = await serial(rowId, values, async (base) => store(await send(rowId, values, versionOf(base, opts), base, false)));
        release();
        notify();
        done(opts, { op: "update", rowId, row });
        return row;
      } catch (thrown) {
        release();
        throw fail(asRaviError(thrown), "update", opts, rowId, values);
      }
    },
    create: async (values, opts = {}) => {
      if (!fire(opts, "ravi:beforewrite", { op: "create", values }, true)) return null;
      const temp: ViewRow | null = lives.size ? { rowId: `pending-${(seq += 1)}`, version: 0, values: { ...values }, pending: true } : null;
      if (temp) {
        created.unshift(temp);
        notify();
      }
      const untemp = () => temp && created.splice(created.indexOf(temp), 1);
      try {
        const output = (await call("create", { ...split(values), idempotencyKey: key() })) as { rowId: string; version: number };
        untemp();
        const row = store({ rowId: output.rowId, version: output.version, values: { ...values } });
        for (const state of lives) {
          state.server = [row, ...state.server.filter((known) => known.rowId !== row.rowId)];
          void state.refresh().catch(noop);
        }
        notify();
        done(opts, { op: "create", rowId: row.rowId, row });
        return row;
      } catch (thrown) {
        untemp();
        throw fail(asRaviError(thrown), "create", opts);
      }
    },
    archive: async (rowId, opts = {}) => {
      versionOf(latest.get(rowId), opts);
      if (!fire(opts, "ravi:beforewrite", { op: "archive", rowId }, true)) return false;
      const release = overlay(rowId, {}, true);
      const meta = { attempts: 0 };
      try {
        await serial(rowId, {}, async (base) => {
          await call("archive", { rowId, expectedVersion: versionOf(base, opts) }, meta);
          return null;
        });
      } catch (thrown) {
        const error = asRaviError(thrown);
        // Archive has no idempotency key: not_found after a retry means the first attempt archived it.
        if (error.code !== "not_found" || meta.attempts < 2) {
          release();
          throw fail(error, "archive", opts, rowId);
        }
      }
      release();
      drop(rowId);
      notify();
      done(opts, { op: "archive", rowId });
      return true;
    },
  };
  return view;
}
