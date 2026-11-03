// `<ravi-view>`: a Bases view as a list, board, table, gallery, calendar or
// form (a chart layout falls back to list). Each record is the kit's widget
// for this tag (fields mapped to view columns) or the default card; table
// cells are inline editors for every writable type but person and ref, and
// the record dialog ("Abrir", a widget's open, a calendar entry) edits the
// writable columns and the body. Approval cells offer "Aprovar"/"Recusar"
// and "Pedir aprovação"; agent cells are read-only. `where`, `search` and
// `sort` are observed: a change re-queries, and `searchable` adds a labelled
// search box (debounced). The element re-renders from state on every change,
// skips identical output and puts focus back on the same control (or record)
// afterwards; renders wait while one of its menus or dialogs is open.
//
// Headings: `heading-level` (default 2) is the level of the view's own
// headings (board lanes); card titles take the next level on a board and
// that level elsewhere.

import { renderDefaultCard } from "@/shared/widgets/render/card";
import { optionColor, renderField } from "@/shared/widgets/render/fields";
import { formatValue, intlLocale, parseDateRange } from "@/shared/widgets/render/format";
import { h, toHtml } from "@/shared/widgets/render/vnode";
import { renderWidget, widgetRecordTitle } from "@/shared/widgets/render/widget";
import type { BaseFilter } from "@/shared/bases/types";
import type { RenderContext, VNode, WidgetActionVerb } from "@/shared/widgets/types";

import { el, focusEl, focusKey, restoreFocus, sel, toDom } from "./dom";
import { asRaviError, RaviError } from "./errors";
import { buildForm, createForm, formColumns, openCreateDialog } from "./form";
import { parseWhere } from "./query";
import { bind, localDate, resolveSet, toRecord, writeKeys, type Binding } from "./records";
import type { Mounted, Rt } from "./runtime";
import { cardScripts, type CardScripts, type ScriptCard } from "./scripts";
import { openDialog, openMenu, type MenuItem } from "./ui";
import type { Live, QueryOptions, View, ViewInfo, ViewRow } from "./view";
import { headingLevelOf, variantOf } from "./widget";

/** `[option id (null: "Sem valor"), name, color, rows]`. */
type Lane = [id: string | null, name: string, color: string, rows: ViewRow[]];

type Flags = { can: (op: "update" | "create" | "archive", key?: string) => boolean; move: boolean; create: boolean; archive: boolean; open: boolean };

const LAYOUTS = /^(list|board|table|gallery|calendar|form)$/;
/** Types a card edits in place; the record dialog edits the rest. */
const CARD_EDITS = /^(select|status|checkbox|approval)$/;
const DATE_TYPES = /^(date|created_time|updated_time)$/;
const SEARCH_DELAY_MS = 300;
const BUTTON = "ravi-button ravi-button-";
const noop = () => {};
/** The children of a fragment: falsy entries dropped. */
const frag = (...children: Parameters<typeof h>[2][]) => h("div", null, ...children).children;

export function mountView(rt: Rt, host: HTMLElement): Mounted {
  const { doc, msgs, kit } = rt;
  const attr = (name: string) => host.getAttribute(name)?.trim() || null;
  const list = (name: string) =>
    attr(name)
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  const id = attr("data-ravi-id");
  const prefix = id ? `ravi-${id}` : rt.uid("v");
  const instance = id ? kit.instances[id] : undefined;
  const level = headingLevelOf(attr("heading-level"));
  const variant = variantOf(attr("variant"), instance?.variant);
  let view: View | undefined;
  let info: ViewInfo;
  let live: Live | undefined;
  let layout = "list";
  let groupBy = "";
  let coverKey: string | null = null;
  let titleKey: string | null = null;
  let binding: Binding;
  /** The widget's `widget.js` on each card, when it has code. */
  let scripts: CardScripts | null = null;
  let fieldKeys: string[] = [];
  let tableKeys: string[] = [];
  let rows: ViewRow[] = [];
  let pageSize = 50;
  /** Calendar: the date column and the month shown (`[year, month 0..11]`). */
  let dateKey = "";
  let month: [number, number] = [0, 0];
  let searchText = attr("search") ?? "";
  let searchTimer: number | undefined;
  /** Where renders go: the host, or (with `searchable`) the region after the search box. */
  let region: HTMLElement = host;
  /** `[text, retry offered, is an error]` instead of the collection. */
  let message: [string, boolean, boolean] | null = null;
  let html = "";
  let hold = 0;
  let dirty = false;
  let announced = false;
  /** Said before the next loaded count (the calendar's new month). */
  let lead = "";
  let stopped = false;
  let settle!: () => void;
  const first = new Promise<void>((ok) => (settle = ok));

  const flags = (): Flags => {
    const can = (op: "update" | "create" | "archive", key?: string) => !host.hasAttribute("readonly") && view?.can(op, key) == true;
    return {
      can,
      move: layout == "board" && can("update", groupBy),
      create: host.hasAttribute("create") && can("create"),
      archive: host.hasAttribute("archive") && !binding.widget && can("archive"),
      // "Abrir" on default cards and table rows: the body, or columns the card cannot edit in place.
      open:
        !binding.widget &&
        view?.can("get") == true &&
        (!!info.col("body") || (layout != "table" && formColumns(info.columns, info.capabilities.writeColumns).some((column) => !CARD_EDITS.test(column.type) && can("update", column.key)))),
    };
  };

  const ctx = (f: Flags): RenderContext => ({
    ...rt.base(),
    users: view?.users ?? {},
    columns: binding.columns,
    can: {
      write: writeKeys(binding, (key) => f.can("update", key)),
      create: f.can("create"),
      archive: f.can("archive"),
      approve: writeKeys(binding, (key) => f.can("update", key) && !!info.capabilities.approve?.includes(key)),
    },
    editAll: layout == "table",
    variant,
    headingLevel: layout == "board" ? Math.min(6, level + 1) : level,
    idPrefix: prefix,
    interactive: true,
  });

  const rowCtx = (base: RenderContext, row: ViewRow, index: number): RenderContext => ({ ...base, idPrefix: `${prefix}-${index}`, interactive: row.version > 0 });

  const title = (row: ViewRow, c = ctx(flags())) => {
    const record = toRecord(row, binding);
    const column = titleKey ? binding.columns[titleKey] : undefined;
    return (binding.widget ? widgetRecordTitle(binding.widget, record, c) : column ? formatValue(column, record.values[column.key], c).trim() : "") || msgs.untitled;
  };

  /** Lanes in option order, plus "Sem valor" when it has rows or the column is a select (which can be cleared). */
  const lanes = () => {
    const column = info.col(groupBy);
    const out = (column?.config?.options ?? [])
      .filter((option) => !option.archived || rows.some((row) => row.values[groupBy] == option.id))
      .map((option): Lane => [option.id, option.name, option.color, []]);
    const none: Lane = [null, msgs.laneNoValue, "gray", []];
    for (const row of rows) (out.find((lane) => lane[0] == row.values[groupBy]) ?? none)[3].push(row);
    return none[3].length || column?.type == "select" ? [...out, none] : out;
  };

  /** Lanes `row` can move to. */
  const targets = (row: ViewRow) => lanes().filter((lane) => !lane[3].includes(row) && (lane[0] !== null || info.col(groupBy)?.type == "select"));

  const pending = (row: ViewRow) => ({ class: row.pending ? "ravi-pending" : null, "aria-busy": row.pending ? "true" : null });

  const openButton = (name: string, disabled: boolean) =>
    h("button", { class: `${BUTTON}ghost`, "data-ravi-op": "open", "aria-haspopup": "dialog", "aria-label": msgs.openFor(name), disabled }, msgs.open);

  const archiveButton = (name: string, disabled: boolean) =>
    h(
      "button",
      { class: `${BUTTON}ghost`, "data-ravi-op": "archive", "aria-haspopup": "dialog", "aria-label": `${msgs.confirmAction("archive")}: ${name}`, disabled },
      msgs.confirmAction("archive"),
    );

  const item = (row: ViewRow, index: number, base: RenderContext, f: Flags) => {
    const c = rowCtx(base, row, index);
    const record = toRecord(row, binding);
    const name = f.archive || f.move || f.open ? title(row, c) : "";
    return h(
      "li",
      { "data-ravi-item": row.rowId, ...pending(row) },
      binding.widget ? renderWidget(binding.widget, record, c) : renderDefaultCard({ record, titleKey, fieldKeys, coverKey }, c),
      (f.archive || f.move || f.open) &&
        h(
          "div",
          { class: "ravi-row ravi-justify-end ravi-gap-xs" },
          f.open && openButton(name, !c.interactive),
          f.archive && archiveButton(name, !c.interactive),
          f.move &&
            h(
              "button",
              { class: `${BUTTON}ghost`, "data-ravi-op": "move", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": msgs.moveToFor(name), disabled: !c.interactive },
              msgs.moveTo,
            ),
        ),
    );
  };

  /** The month grid: weekday columns, one cell per day with its rows as buttons that open the record dialog. */
  const calendar = (base: RenderContext) => {
    const [year, at] = month;
    const intl = intlLocale(rt.locale);
    const days = new Date(year, at + 1, 0).getDate();
    const today = localDate(new Date(rt.now()));
    const cells: Array<number | null> = Array(new Date(year, at, 1).getDay()).fill(null);
    for (let day = 1; day <= days; day += 1) cells.push(day);
    while (cells.length % 7) cells.push(null);
    const byDay = new Map<number, ViewRow[]>();
    for (const row of rows) {
      const start = parseDateRange(row.values[dateKey])?.start;
      const date = start && (start.kind == "date" ? start : { year: new Date(start.ms).getFullYear(), month: new Date(start.ms).getMonth() + 1, day: new Date(start.ms).getDate() });
      if (date && date.year == year && date.month == at + 1) byDay.set(date.day, [...(byDay.get(date.day) ?? []), row]);
    }
    // 2023-01-01 was a Sunday.
    const weekdays = Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2023, 0, 1 + index)));
    const name = (date: Date, options: Intl.DateTimeFormatOptions) => date.toLocaleDateString(intl, options);
    const weeks: Array<Array<number | null>> = [];
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
    return [
      h(
        "div",
        { class: "ravi-calendar-nav" },
        h("button", { class: `${BUTTON}secondary`, "data-ravi-op": "prev" }, msgs.previousMonth),
        h(`h${level}`, { id: `${prefix}-month` }, name(new Date(year, at, 1), { month: "long", year: "numeric" })),
        h("button", { class: `${BUTTON}secondary`, "data-ravi-op": "next" }, msgs.nextMonth),
      ),
      h(
        "table",
        { class: "ravi-calendar", "aria-labelledby": `${prefix}-month`, "data-ravi-collection": "" },
        h("thead", null, h("tr", null, weekdays.map((day) => h("th", { scope: "col", abbr: name(day, { weekday: "long", timeZone: "UTC" }) }, name(day, { weekday: "short", timeZone: "UTC" }))))),
        h(
          "tbody",
          null,
          weeks.map((week) =>
            h(
              "tr",
              null,
              week.map((day) => {
                if (!day) return h("td", null);
                const date = new Date(year, at, day);
                const current = localDate(date) == today;
                const list = byDay.get(day) ?? [];
                return h(
                  "td",
                  { "aria-current": current ? "date" : null },
                  h("span", { class: "ravi-day" }, h("span", { "aria-hidden": "true" }, String(day)), h("span", { class: "ravi-sr-only" }, name(date, { day: "numeric", month: "long" }) + (current ? `, ${msgs.today}` : ""))),
                  list.length > 0 &&
                    h(
                      "ul",
                      { role: "list" },
                      list.map((row) =>
                        h(
                          "li",
                          { "data-ravi-item": row.rowId, ...pending(row) },
                          h("button", { class: `${BUTTON}ghost`, "data-ravi-op": "open", "aria-haspopup": "dialog", disabled: !rowCtx(base, row, rows.indexOf(row)).interactive }, title(row, base)),
                        ),
                      ),
                    ),
                );
              }),
            ),
          ),
        ),
      ),
    ];
  };

  const build = (f: Flags | null): VNode[] => {
    if (!f) {
      const [text, retry, error] = message ?? [msgs.loading, false, false];
      return frag(h("p", { class: error ? "ravi-error" : "ravi-status", role: "status" }, text), retry && h("button", { class: `${BUTTON}secondary`, "data-ravi-op": "retry" }, msgs.retry));
    }
    const base = ctx(f);
    const cards = (list: ViewRow[]) => list.map((row) => item(row, rows.indexOf(row), base, f));
    return frag(
      f.create && h("div", { class: "ravi-row ravi-justify-end" }, h("button", { class: `${BUTTON}primary`, "data-ravi-op": "create", "aria-haspopup": "dialog" }, msgs.newItem)),
      layout == "calendar"
        ? calendar(base)
        : layout == "board"
        ? h(
            "div",
            { class: "ravi-board", "data-ravi-collection": "" },
            lanes().map(([lane, name, color, list], index) =>
              h(
                "section",
                { class: "ravi-lane", "aria-labelledby": `${prefix}-lane${index}`, "data-ravi-lane": lane ?? "" },
                h(`h${level}`, { class: "ravi-lane-header", id: `${prefix}-lane${index}` }, h("span", { class: `ravi-dot ravi-option-${optionColor(color)}`, "aria-hidden": "true" }), " ", msgs.lane(name, list.length)),
                list.length > 0 && h("ul", { role: "list", class: "ravi-lane-cards" }, cards(list)),
              ),
            ),
          )
        : !rows.length
          ? h("p", { class: "ravi-status", role: "status" }, msgs.empty)
          : layout == "table"
            ? h(
                "div",
                { class: "ravi-table-scroll", "data-ravi-collection": "" },
                h(
                  "table",
                  { class: "ravi-table" },
                  h("caption", { class: "ravi-sr-only" }, msgs.tableCaption(info.name)),
                  h(
                    "thead",
                    null,
                    h(
                      "tr",
                      null,
                      tableKeys.map((key) => h("th", { scope: "col" }, info.col(key)?.name ?? key)),
                      f.open && h("th", { scope: "col" }, h("span", { class: "ravi-sr-only" }, msgs.open)),
                      f.archive && h("th", { scope: "col" }, h("span", { class: "ravi-sr-only" }, msgs.confirmAction("archive"))),
                    ),
                  ),
                  h(
                    "tbody",
                    null,
                    rows.map((row, index) => {
                      const c = rowCtx(base, row, index);
                      const record = toRecord(row, binding);
                      return h(
                        "tr",
                        { "data-ravi-item": row.rowId, "data-ravi-row": row.rowId, ...pending(row) },
                        tableKeys.map((key, at) => {
                          const column = binding.columns[key];
                          const cell = column && renderField({ key, column, value: record.values[key], label: "hidden", editable: true, uid: `t${at}` }, c);
                          return key == titleKey ? h("th", { scope: "row" }, cell) : h("td", null, cell);
                        }),
                        f.open && h("td", null, openButton(title(row, c), !c.interactive)),
                        f.archive && h("td", null, archiveButton(title(row, c), !c.interactive)),
                      );
                    }),
                  ),
                ),
              )
            : h("ul", { role: "list", class: `ravi-${layout == "gallery" ? "gallery" : "list"}`, "data-ravi-collection": "" }, cards(rows)),
      !!live?.nextCursor && h("div", { class: "ravi-row ravi-justify-center" }, h("button", { class: `${BUTTON}secondary`, "data-ravi-op": "more" }, msgs.loadMore)),
    );
  };

  /** Rendered widget cards: the record root inside each item, keyed by row id. */
  const scriptCards = (): ScriptCard[] =>
    rows.flatMap((row) => {
      const card = host.querySelector<HTMLElement>(`${sel("data-ravi-item", row.rowId)} > [data-ravi-row]`);
      return card ? [[card, row.rowId, toRecord(row, binding)] as ScriptCard] : [];
    });

  const render = () => {
    if (stopped) return;
    if (hold) {
      dirty = true;
      return;
    }
    dirty = false;
    const f = live && !message ? flags() : null;
    const nodes = build(f);
    const next = toHtml(nodes);
    if (next != html) {
      html = next;
      const key = focusKey(region, doc.activeElement);
      region.replaceChildren(...toDom(doc, nodes));
      // Before focus comes back: mounted cards are put back in place of the fresh ones.
      scripts?.sync(f ? scriptCards() : []);
      if (f?.move) host.querySelectorAll<HTMLElement>("[data-ravi-lane] [data-ravi-item]").forEach((node) => node.setAttribute("draggable", "true"));
      restoreFocus(region, key, region.querySelector("[data-ravi-collection]") ?? region);
      rt.fire(host, "ravi:render", { rows: rows.length });
    } else scripts?.sync(f ? scriptCards() : []);
    host.removeAttribute("aria-busy");
    if (f && !announced) {
      announced = true;
      rt.announce(lead + msgs.loaded(rows.length));
      lead = "";
    }
    settle();
  };

  /** Holds renders while a menu or dialog is open. */
  const holding = async <T,>(pending: Promise<T>) => {
    hold += 1;
    try {
      return await pending;
    } finally {
      hold -= 1;
      if (!hold && dirty) render();
    }
  };

  const fail = (error: RaviError) => {
    // Removed or moved meanwhile: nothing to report on a detached host.
    if (stopped) return settle();
    live?.stop();
    live = undefined;
    rt.report(error, { target: host, view, op: "read" });
    message = rt.capture ? [msgs.capture, false, false] : [rt.stateText(error), /^(busy|invalid)$/.test(error.kind), true];
    render();
  };

  /** The query of the current attributes, search text and (calendar) month. */
  const options = (): QueryOptions => {
    const opts: QueryOptions = { sort: attr("sort"), search: searchText, limit: pageSize };
    if (layout != "calendar") return { ...opts, where: attr("where") };
    const [year, at] = month;
    const pad = (n: number) => String(n).padStart(2, "0");
    const range: BaseFilter = {
      and: [
        { prop: dateKey, op: "on_or_after", value: `${year}-${pad(at + 1)}-01` },
        { prop: dateKey, op: "before", value: at == 11 ? `${year + 1}-01-01` : `${year}-${pad(at + 2)}-01` },
      ],
    };
    const where = parseWhere(attr("where"), info.columns);
    return { ...opts, filter: where ? { and: [where, range] } : range };
  };

  /** (Re)starts the live query; rows from a query it replaced are ignored. */
  const query = async () => {
    if (!view || stopped) return;
    live?.stop();
    live = undefined;
    announced = false;
    host.setAttribute("aria-busy", "true");
    try {
      const mine: Live = view.live(options(), (next) => {
        if (live != mine) return;
        rows = next;
        message = null;
        render();
      });
      live = mine;
      await mine.load();
    } catch (thrown) {
      fail(asRaviError(thrown));
    }
  };

  /** `searchable`: a labelled search box before the collection; typing re-queries after a pause. */
  const searchBox = () => {
    const box = el(doc, "input", {
      type: "search",
      id: `${prefix}-search`,
      className: "ravi-input",
      value: searchText,
      maxLength: 200,
      onInput: () => {
        rt.win.clearTimeout(searchTimer);
        searchTimer = rt.win.setTimeout(() => {
          searchText = box.value;
          void query();
        }, SEARCH_DELAY_MS);
      },
    }) as HTMLInputElement;
    region = el(doc, "div");
    host.replaceChildren(el(doc, "div", { className: "ravi-search", role: "search" }, el(doc, "label", { htmlFor: box.id }, msgs.search), box), region);
  };

  const start = async () => {
    host.setAttribute("aria-busy", "true");
    try {
      view = rt.view(attr("view") ?? instance?.view ?? "");
      info = await view.describe();
      // Removed or moved while describing: start nothing (a new mount takes over a moved tag).
      if (stopped) return settle();
      const shape = (info.layout ?? {}) as { type?: string; groupBy?: string; coverProp?: string | null; dateProp?: string; title?: string; description?: string; submitLabel?: string; successMessage?: string };
      layout = attr("layout") ?? shape.type ?? "list";
      if (!LAYOUTS.test(layout)) layout = "list";
      // A form view may admit writers that cannot read it.
      if (layout != "form" && !info.capabilities?.read) throw new RaviError("base_forbidden");
      if (layout == "form") {
        // The create form, with the view layout's texts; no rows are read.
        const form = createForm(rt, view, host, `${prefix}-form`, { submitLabel: shape.submitLabel, success: shape.successMessage });
        host.replaceChildren(
          ...(form
            ? [shape.type == "form" && shape.title && el(doc, `h${level}`, { className: "ravi-title" }, shape.title), shape.type == "form" && shape.description && el(doc, "p", null, shape.description), ...form].filter(
                (node): node is HTMLElement => !!node,
              )
            : [el(doc, "p", { className: "ravi-status", role: "status" }, msgs.noPermission)]),
        );
        host.removeAttribute("aria-busy");
        rt.fire(host, "ravi:render", { rows: 0 });
        return settle();
      }
      dateKey = (shape.type == "calendar" ? shape.dateProp : null) ?? info.columns.find((column) => DATE_TYPES.test(column.type))?.key ?? "";
      if (layout == "calendar" && !DATE_TYPES.test(info.col(dateKey)?.type ?? "")) layout = "list";
      const today = new Date(rt.now());
      month = [today.getFullYear(), today.getMonth()];
      groupBy = attr("group-by") ?? (shape.type == "board" ? shape.groupBy : null) ?? "";
      if (layout == "board" && !/^(select|status)$/.test(info.col(groupBy)?.type ?? "")) layout = "list";
      coverKey = layout == "gallery" && shape.type == "gallery" ? (shape.coverProp ?? null) : null;
      binding = bind(info.columns, (layout != "table" && instance?.widget && kit.widgets[instance.widget]) || null, instance?.fields ?? {});
      scripts?.stop();
      scripts = cardScripts(rt, binding.widget);
      const cardTitle = attr("card-title");
      titleKey = cardTitle && info.col(cardTitle) ? cardTitle : info.titleKey;
      const visible = info.columns.filter((column) => column.type != "body").map((column) => column.key);
      fieldKeys = list("card-fields") ?? visible.filter((key) => key != titleKey && key != coverKey).slice(0, 4);
      tableKeys = list("columns")?.filter((key) => info.col(key)) ?? visible;
      pageSize = Math.min(200, Math.max(1, parseInt(attr("page-size") ?? "", 10) || 50));
      if (host.hasAttribute("searchable") && region == host) searchBox();
    } catch (thrown) {
      return fail(asRaviError(thrown));
    }
    await query();
  };

  const confirm = (verb: WidgetActionVerb, name: string, changes: { label: string; value: string }[]) =>
    holding(
      openDialog(doc, {
        title: msgs.confirmTitle(verb),
        text: msgs.confirmBody(verb, name, changes),
        actions: [
          [msgs.cancel, "cancel"],
          [msgs.confirmAction(verb), "ok", verb == "archive" ? "danger" : "primary"],
        ],
        focus: verb == "archive" ? "cancel" : "ok",
      }).done,
    ).then((value) => value == "ok");

  const archive = async (row: ViewRow) => {
    if (await confirm("archive", title(row), [])) await view?.archive(row.rowId, { target: host }).catch(noop);
  };

  const move = (row: ViewRow, [lane, name]: Lane) =>
    void view?.update(row.rowId, { [groupBy]: lane }, { target: host, saved: msgs.moved(title(row), name) }).catch(noop);

  const openMove = (row: ViewRow, button: HTMLElement, last: boolean) => {
    if (button.getAttribute("aria-expanded") != "true")
      void holding(
        openMenu(
          doc,
          button,
          msgs.moveTo,
          targets(row).map((lane): MenuItem => [lane[1], () => move(row, lane)]),
          last,
        ),
      );
  };

  /**
   * The record dialog ("Abrir", a widget's open without href, a calendar
   * entry): the row as `rows.get` reads it (the query row when the kit does
   * not declare it); read-only columns as text, the columns the viewer may
   * write (and the body) in a form that saves only what changed.
   */
  const details = async (row: ViewRow, name: string) => {
    if (!view) return;
    try {
      const full = view.can("get") ? await view.get(row.rowId) : row;
      const f = flags();
      const editable = formColumns(info.columns, info.capabilities.writeColumns).filter((column) => f.can("update", column.key));
      const shown = info.columns.filter((column) => column.type != "body" && !editable.includes(column));
      const body = !editable.some((column) => column.type == "body") && full.body;
      let handle: ReturnType<typeof openDialog> | undefined;
      const form =
        editable.length > 0 &&
        buildForm(
          rt,
          editable,
          `${prefix}-record`,
          msgs.save,
          (values) => (view as View).update(row.rowId, values, { target: host, quiet: true }),
          () => {
            rt.announce(msgs.saved);
            handle?.close("saved");
          },
          { ...full.values, body: full.body ?? null },
        );
      const content = [
        shown.length > 0 && el(doc, "dl", { className: "ravi-details" }, shown.map((column) => [el(doc, "dt", null, column.name), el(doc, "dd", null, view?.format(full, column.key) || msgs.noValue)])),
        body && el(doc, "div", { className: "ravi-body", style: { whiteSpace: "pre-wrap" } }, body),
        form,
      ];
      handle = openDialog(doc, { title: name || msgs.details, content, actions: [form ? [msgs.cancel, "cancel"] : [msgs.close, "cancel", "primary"]] });
      await holding(handle.done);
    } catch (thrown) {
      rt.report(asRaviError(thrown), { target: host, view, op: "get" });
    }
  };

  /** "Aprovar"/"Recusar" (a dialog with an optional note) or "Pedir aprovação" on an approval cell. */
  const decide = async (row: ViewRow, field: string, to: string) => {
    const key = binding.columnOf[field];
    const column = binding.columns[field];
    if (!view || !key || !column) return;
    if (to == "pending") return void view.update(row.rowId, { [key]: "pending" }, { target: host, saved: msgs.requested }).catch(noop);
    const approve = to == "approved";
    const note = el(doc, "textarea", { className: "ravi-input", rows: 3, maxLength: 1000 }) as HTMLTextAreaElement;
    const answer = await holding(
      openDialog(doc, {
        title: msgs.decideTitle(approve),
        text: msgs.decideBody(title(row), column.name),
        content: [el(doc, "div", { className: "ravi-form" }, el(doc, "label", null, msgs.note, note))],
        actions: [
          [msgs.cancel, "cancel"],
          [approve ? msgs.approve : msgs.reject, "ok", approve ? "primary" : "danger"],
        ],
      }).done,
    );
    if (answer != "ok") return;
    const text = note.value.trim();
    await view.update(row.rowId, { [key]: text ? { state: to, note: text } : { state: to } }, { target: host, saved: msgs.decided(approve) }).catch(noop);
  };

  /** Calendar: another month, announced. */
  const shift = (by: number) => {
    const date = new Date(month[0], month[1] + by, 1);
    month = [date.getFullYear(), date.getMonth()];
    // One announcement once the month loads: "novembro de 2026. 3 itens carregados."
    lead = `${date.toLocaleDateString(intlLocale(rt.locale), { month: "long", year: "numeric" })}. `;
    void query();
  };

  const action = async (row: ViewRow, index: number) => {
    const spec = binding.widget?.actions[index];
    if (!spec || !view) return;
    const c = ctx(flags());
    const name = title(row, c);
    if (spec.verb == "archive") return archive(row);
    if (spec.verb == "open") return details(row, name);
    let resolved: ReturnType<typeof resolveSet>;
    try {
      resolved = resolveSet(spec.set, binding, spec.verb, c);
    } catch (thrown) {
      return rt.report(asRaviError(thrown), { target: host, view, op: spec.verb });
    }
    if (spec.confirm && !(await confirm(spec.verb, name, resolved.changes))) return;
    await (spec.verb == "update" ? view.update(row.rowId, resolved.values, { target: host }) : view.create(resolved.values, { target: host })).catch(noop);
  };

  const more = async () => {
    const before = rows.length;
    try {
      const added = (await live?.more()) ?? 0;
      rt.announce(msgs.loaded(added));
      const next = rows[before];
      if (added && next) focusEl(host.querySelector(sel("data-ravi-item", next.rowId)) ?? host);
    } catch (thrown) {
      rt.report(asRaviError(thrown), { target: host, view, op: "read" });
    }
  };

  const on = (event: Event) => {
    const target = event.target as Element;
    const rowId = target.closest?.("[data-ravi-item]")?.getAttribute("data-ravi-item");
    const row = rows.find((candidate) => candidate.rowId == rowId);
    const f = live && !message && view ? flags() : null;
    const drag = (event as DragEvent).dataTransfer;
    const control = target.closest?.("[data-ravi-op],button[data-ravi-action],button[data-ravi-decide],[data-ravi-edit],[data-ravi-lane]") as HTMLButtonElement | null;
    if (!control || !host.contains(control)) return;
    const op = control.getAttribute("data-ravi-op");
    if (event.type == "click") {
      if (control.disabled || control.matches("[data-ravi-edit],[data-ravi-lane]")) return;
      if (op == "retry") {
        message = null;
        render();
        void start();
      } else if (!f || !view) return;
      else if (op == "more") void more();
      else if (op == "create") void holding(openCreateDialog(rt, view, host, `${prefix}-new`));
      else if (op == "prev" || op == "next") shift(op == "prev" ? -1 : 1);
      else if (!row) return;
      else if (op == "archive") void archive(row);
      else if (op == "move") openMove(row, control, false);
      else if (op == "open") void details(row, title(row));
      else if (control.hasAttribute("data-ravi-decide")) void decide(row, control.getAttribute("data-ravi-decide") ?? "", control.value);
      else void action(row, Number(control.getAttribute("data-ravi-action")));
    } else if (event.type == "keydown") {
      const key = (event as KeyboardEvent).key;
      if (op == "move" && row && f && /^Arrow(Down|Up)$/.test(key)) {
        event.preventDefault();
        openMove(row, control, key == "ArrowUp");
      }
    } else if (event.type == "change") {
      const editor = control as unknown as HTMLInputElement;
      const field = editor.getAttribute("data-ravi-edit") ?? "";
      const key = binding?.columnOf[field];
      const type = binding?.columns[field]?.type;
      if (!f || !row || !key) return;
      let value: unknown = editor.value.trim() || null;
      if (type == "multi_select") {
        value = Array.from(editor.closest("[data-ravi-field]")?.querySelectorAll<HTMLInputElement>("[data-ravi-opt]") ?? [], (box) => box.checked && box.value).filter(Boolean);
      } else if (editor.type == "checkbox") value = editor.checked;
      else if (value !== null && type == "number") value = Number(value);
      else if (value !== null && editor.type == "datetime-local") value = new Date(value as string).toISOString();
      if (typeof value == "number" && !Number.isFinite(value)) return rt.announce(msgs.invalid);
      void view?.update(row.rowId, { [key]: value }, { target: host }).catch(noop);
    } else if (!f?.move) return;
    else if (event.type == "dragstart") {
      if (row) drag?.setData("text/plain", row.rowId);
    } else {
      const dragged = rows.find((candidate) => candidate.rowId == drag?.getData("text/plain"));
      const lane = control.closest("[data-ravi-lane]")?.getAttribute("data-ravi-lane");
      if (lane == null) return;
      event.preventDefault();
      const to = event.type == "drop" && dragged && targets(dragged).find((candidate) => (candidate[0] ?? "") == lane);
      if (to && dragged) move(dragged, to);
    }
  };

  void start();
  return {
    first,
    on,
    // `where`, `search` and `sort` changed: query again (before the first describe answers, `start` reads them).
    attr: (name) => {
      if (!info || layout == "form" || stopped) return;
      if (name == "search") {
        searchText = attr("search") ?? "";
        const box = host.querySelector<HTMLInputElement>(".ravi-search input");
        if (box) box.value = searchText;
      }
      void query();
    },
    // A mount stopped before its first render still settles `first`, so `ravi.ready` never waits on it.
    stop: () => {
      stopped = true;
      rt.win.clearTimeout(searchTimer);
      live?.stop();
      live = undefined;
      scripts?.stop();
      scripts = null;
      settle();
    },
  };
}
