// Text for one value by column type, config and display, with Intl in pt-BR
// or en (any other locale falls back to en). Date-only values (`YYYY-MM-DD`)
// never shift by time zone; instants show in `ctx.timeZone`. Values arrive in
// the Bases API shape; static data normalized by `static.ts` may also carry
// option names and inline people (`{ id, displayName, avatarUrl }`).

import type { BaseRefValue, BaseSelectOption, BaseStatusGroup, BaseUserRef } from "@/shared/bases/types";

import type { RenderColumn, RenderContext, TemplateFilter } from "../types";
import { messageLocale, messages } from "./messages";

export type FormatContext = Pick<RenderContext, "locale" | "timeZone" | "now" | "users">;

export type NumberKind = "number" | "currency" | "percent";

const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_DAYS = 7;
const DEFAULT_CURRENCY = "BRL";

// ---------------------------------------------------------------------------
// Intl, cached per locale and options

const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

/** The Intl locale used for formatting: `pt-BR` or `en-US`. */
export function intlLocale(locale: string): "pt-BR" | "en-US" {
  return messageLocale(locale) === "pt-BR" ? "pt-BR" : "en-US";
}

function numberFormat(locale: string, options: Intl.NumberFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

function dateFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = dateFormats.get(key);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat(locale, options);
    } catch {
      // Unknown time zone: fall back to UTC rather than failing the render.
      format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
    }
    dateFormats.set(key, format);
  }
  return format;
}

function relativeFormat(locale: string, numeric: "auto" | "always") {
  const key = `${locale}|${numeric}`;
  let format = relativeFormats.get(key);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric });
    relativeFormats.set(key, format);
  }
  return format;
}

// ---------------------------------------------------------------------------
// Emptiness

/** True when the cell holds nothing to show. `false` checkboxes are values; `0` is a value. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  if (typeof value === "number") return !Number.isFinite(value);
  return Array.isArray(value) && value.length === 0;
}

// ---------------------------------------------------------------------------
// Numbers

export function numberKind(column: Pick<RenderColumn, "config">): NumberKind {
  const format = column.config?.format;
  return format === "currency" ? "currency" : format === "percent" ? "percent" : "number";
}

function precisionOptions(column: Pick<RenderColumn, "config">, fallbackMax: number): Intl.NumberFormatOptions {
  const precision = column.config?.precision;
  if (typeof precision === "number" && Number.isInteger(precision) && precision >= 0 && precision <= 8) {
    return { minimumFractionDigits: precision, maximumFractionDigits: precision };
  }
  return { maximumFractionDigits: fallbackMax };
}

function currencyCode(column: Pick<RenderColumn, "config">) {
  const code = typeof column.config?.currency === "string" ? column.config.currency.toUpperCase() : DEFAULT_CURRENCY;
  return /^[A-Z]{3}$/.test(code) ? code : DEFAULT_CURRENCY;
}

/**
 * A number as `mode`: `number` with the column precision, `currency` with the
 * column's ISO currency (default BRL), `percent` (0.25 → 25%), or `compact`
 * ("R$ 12,4 mil", "1,2 mi"; compact keeps the column's currency or percent).
 */
export function formatNumber(
  value: number,
  column: Pick<RenderColumn, "config">,
  locale: string,
  mode: "number" | "currency" | "percent" | "compact",
): string {
  if (!Number.isFinite(value)) return "";
  const intl = intlLocale(locale);
  const kind = numberKind(column);
  if (mode === "percent" || (mode === "compact" && kind === "percent")) {
    return numberFormat(intl, { style: "percent", ...precisionOptions(column, 2) }).format(value);
  }
  if (mode === "compact") {
    const base: Intl.NumberFormatOptions = { notation: "compact", maximumFractionDigits: 1 };
    if (kind === "currency") return numberFormat(intl, { ...base, style: "currency", currency: currencyCode(column) }).format(value);
    return numberFormat(intl, base).format(value);
  }
  if (mode === "currency") {
    const digits = precisionOptions(column, 2);
    const options: Intl.NumberFormatOptions = { style: "currency", currency: currencyCode(column) };
    if (digits.minimumFractionDigits !== undefined) Object.assign(options, digits);
    return numberFormat(intl, options).format(value);
  }
  return numberFormat(intl, precisionOptions(column, 10)).format(value);
}

/** The number in its column format (currency, percent or plain). */
export function formatNumberByColumn(value: number, column: Pick<RenderColumn, "config">, locale: string) {
  return formatNumber(value, column, locale, numberKind(column));
}

/**
 * Progress as a fraction 0..1 (clamped). Without `max`, a percent column is
 * already a fraction and any other number is out of 100.
 */
export function progressFraction(value: number, column: Pick<RenderColumn, "config">, max?: number | null): number {
  const limit = typeof max === "number" && Number.isFinite(max) && max > 0 ? max : numberKind(column) === "percent" ? 1 : 100;
  const fraction = value / limit;
  return Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
}

export function formatPercentFraction(fraction: number, locale: string): string {
  return numberFormat(intlLocale(locale), { style: "percent", maximumFractionDigits: 0 }).format(fraction);
}

// ---------------------------------------------------------------------------
// Options

/** The option a select/status/multi_select value names: by id, then by name (static data). */
export function optionFor(column: Pick<RenderColumn, "config">, value: unknown): BaseSelectOption | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const inline = value as Partial<BaseSelectOption>;
    if (typeof inline.name === "string") {
      const known = optionFor(column, inline.id ?? inline.name);
      return known ?? { id: inline.id ?? inline.name, name: inline.name, color: inline.color ?? "gray", group: inline.group };
    }
    return null;
  }
  if (typeof value !== "string" || !value) return null;
  const options = column.config?.options ?? [];
  return options.find((option) => option.id === value) ?? options.find((option) => option.name === value) ?? null;
}

const OPAQUE_OPTION_ID = /^[0-9a-z]{8}$/;

/** The option's name; unknown ids read "Opção desconhecida", unknown names (static data) show as written. */
export function optionName(column: Pick<RenderColumn, "config">, value: unknown, locale: string): string {
  const option = optionFor(column, value);
  if (option) return option.name;
  if (typeof value === "string" && value && !OPAQUE_OPTION_ID.test(value)) return value;
  return messages(locale).unknownOption;
}

export function optionValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return isEmptyValue(value) ? [] : [value];
}

export function statusGroupOf(column: Pick<RenderColumn, "config">, value: unknown): BaseStatusGroup | null {
  return optionFor(column, value)?.group ?? null;
}

// ---------------------------------------------------------------------------
// People

export type PersonRef = { id: string; name: string; avatarUrl: string | null; known: boolean };

/** People in a person/created_by/updated_by value: user ids looked up in `users`, or inline objects. */
export function personRefs(value: unknown, users: Record<string, BaseUserRef>, locale: string): PersonRef[] {
  const items = Array.isArray(value) ? value : isEmptyValue(value) ? [] : [value];
  const out: PersonRef[] = [];
  for (const item of items) {
    if (typeof item === "string" && item) {
      const user = users[item];
      const name = user?.displayName?.trim();
      out.push({
        id: item,
        name: name || messages(locale).unknownPerson,
        avatarUrl: user?.avatarUrl ?? null,
        known: Boolean(name),
      });
    } else if (item && typeof item === "object") {
      const inline = item as { id?: unknown; name?: unknown; displayName?: unknown; avatarUrl?: unknown };
      const name = typeof inline.displayName === "string" ? inline.displayName : typeof inline.name === "string" ? inline.name : "";
      const id = typeof inline.id === "string" && inline.id ? inline.id : name;
      const user = users[id];
      const shown = name.trim() || user?.displayName?.trim() || "";
      out.push({
        id,
        name: shown || messages(locale).unknownPerson,
        avatarUrl: typeof inline.avatarUrl === "string" ? inline.avatarUrl : (user?.avatarUrl ?? null),
        known: Boolean(shown),
      });
    }
  }
  return out;
}

/** "Ana Souza" → "AS", "ana" → "A", "Érica de Lima" → "ÉL"; "?" when nothing is left. */
export function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /^[\p{L}\p{N}]/u.test(word));
  if (!words.length) return "?";
  const first = Array.from(words[0] ?? "")[0] ?? "";
  if (words.length === 1) return first.toLocaleUpperCase();
  const last = Array.from(words[words.length - 1] ?? "")[0] ?? "";
  return `${first}${last}`.toLocaleUpperCase();
}

// ---------------------------------------------------------------------------
// Refs

export function refValues(value: unknown): BaseRefValue[] {
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return items.filter(
    (item): item is BaseRefValue =>
      Boolean(item) && typeof item === "object" && typeof (item as BaseRefValue).type === "string" && typeof (item as BaseRefValue).id === "string",
  );
}

export function refText(ref: BaseRefValue): string {
  return `${ref.type}:${ref.id}`;
}

// ---------------------------------------------------------------------------
// URLs

/** "https://www.example.test/a/" → "example.test/a". */
export function urlText(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** Host without `www.`, or the text when it does not parse. */
export function urlDomain(value: string): string {
  try {
    const host = new URL(value).hostname;
    return host ? host.replace(/^www\./i, "") : value;
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Dates

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export type DatePoint = { kind: "date"; year: number; month: number; day: number; iso: string } | { kind: "instant"; ms: number; iso: string };

export function parseDatePoint(value: unknown): DatePoint | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = DATE_ONLY.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (year < 1 || month < 1 || month > 12 || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
    return { kind: "date", year, month, day, iso: text };
  }
  if (INSTANT.test(text)) {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) return null;
    return { kind: "instant", ms, iso: new Date(ms).toISOString() };
  }
  return null;
}

/** `{ start, end }` from a date cell (`BaseDateValue`), a date string or an instant. */
export function parseDateRange(value: unknown): { start: DatePoint; end: DatePoint | null } | null {
  if (typeof value === "string") {
    const start = parseDatePoint(value);
    return start ? { start, end: null } : null;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const range = value as { start?: unknown; end?: unknown };
    const start = parseDatePoint(range.start);
    if (!start) return null;
    return { start, end: parseDatePoint(range.end) };
  }
  return null;
}

function zonedYmd(ms: number, timeZone: string) {
  const parts = dateFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day") };
}

function pointYmd(point: DatePoint, timeZone: string) {
  return point.kind === "date" ? { year: point.year, month: point.month, day: point.day } : zonedYmd(point.ms, timeZone);
}

function dayNumber(ymd: { year: number; month: number; day: number }) {
  return Math.round(Date.UTC(ymd.year, ymd.month - 1, ymd.day) / DAY_MS);
}

function safeZone(timeZone: string) {
  return typeof timeZone === "string" && timeZone ? timeZone : "UTC";
}

/** "16 de out." in the current year, "16 de out. de 2025" otherwise; instants add the time when `withTime`. */
export function formatDatePoint(point: DatePoint, ctx: FormatContext, withTime: boolean): string {
  const intl = intlLocale(ctx.locale);
  const timeZone = safeZone(ctx.timeZone);
  const today = zonedYmd(ctx.now.getTime(), timeZone);
  const ymd = pointYmd(point, timeZone);
  const options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (ymd.year !== today.year) options.year = "numeric";
  if (point.kind === "date") {
    return dateFormat(intl, { ...options, timeZone: "UTC" }).format(new Date(Date.UTC(point.year, point.month - 1, point.day)));
  }
  if (withTime) {
    options.hour = intl === "pt-BR" ? "2-digit" : "numeric";
    options.minute = "2-digit";
  }
  return dateFormat(intl, { ...options, timeZone }).format(new Date(point.ms));
}

/**
 * Relative text within 7 days ("hoje", "amanhã", "ontem", "em 2 dias",
 * "há 3 dias"; instants on the same day in minutes or hours), else the date.
 */
export function formatRelative(point: DatePoint, ctx: FormatContext, withTime: boolean): string {
  const intl = intlLocale(ctx.locale);
  const timeZone = safeZone(ctx.timeZone);
  const nowMs = ctx.now.getTime();
  const days = dayNumber(pointYmd(point, timeZone)) - dayNumber(zonedYmd(nowMs, timeZone));
  if (point.kind === "instant") {
    const deltaMs = point.ms - nowMs;
    const minutes = Math.round(deltaMs / 60000);
    if (Math.abs(deltaMs) < 60000) return relativeFormat(intl, "auto").format(0, "second");
    if (Math.abs(minutes) < 60) return relativeFormat(intl, "always").format(minutes, "minute");
    if (days === 0) return relativeFormat(intl, "always").format(Math.round(deltaMs / 3600000), "hour");
  }
  if (Math.abs(days) > RELATIVE_DAYS) return formatDatePoint(point, ctx, withTime);
  // "auto" only for -1..1: pt-BR would say "depois de amanhã" for 2.
  return relativeFormat(intl, Math.abs(days) <= 1 ? "auto" : "always").format(days, "day");
}

export type DateDisplay = "date" | "relative" | "datetime";

function columnHasTime(column: Pick<RenderColumn, "type" | "config">) {
  return column.type === "created_time" || column.type === "updated_time" || Boolean(column.config?.includeTime);
}

/** A formatted date or range with the ISO value of each end (`<time datetime>`). */
export type DateText = { start: { text: string; iso: string }; end: { text: string; iso: string } | null };

/** The date mode a field display names: `relative`, `datetime`, else `date`. */
export function dateDisplay(display: string | undefined): DateDisplay {
  return display === "relative" ? "relative" : display === "datetime" ? "datetime" : "date";
}

/** The value's date or range as text plus ISO values, or null when it is not a date. */
export function formatDateParts(column: Pick<RenderColumn, "type" | "config">, value: unknown, ctx: FormatContext, display: DateDisplay): DateText | null {
  const range = parseDateRange(value);
  if (!range) return null;
  const withTime = display === "datetime" || columnHasTime(column);
  const one = (point: DatePoint) => ({
    text: display === "relative" ? formatRelative(point, ctx, withTime) : formatDatePoint(point, ctx, withTime),
    iso: point.iso,
  });
  return { start: one(range.start), end: range.end ? one(range.end) : null };
}

export function formatDateValue(column: Pick<RenderColumn, "type" | "config">, value: unknown, ctx: FormatContext, display: DateDisplay): string {
  const parts = formatDateParts(column, value, ctx, display);
  if (!parts) return typeof value === "string" ? value : "";
  return parts.end ? `${parts.start.text} – ${parts.end.text}` : parts.start.text;
}

// ---------------------------------------------------------------------------
// One value as text

export function isDateColumn(type: RenderColumn["type"]) {
  return type === "date" || type === "created_time" || type === "updated_time";
}

export function isPersonColumn(type: RenderColumn["type"]) {
  return type === "person" || type === "created_by" || type === "updated_by";
}

const APPROVAL_STATE_TEXT: Record<string, string> = { pending: "Pendente", approved: "Aprovado", rejected: "Recusado" };

/**
 * Approval and agent cells degrade to plain text here: the approval state, or
 * the agent's value formatted as its output type. Null for other columns.
 */
function structuredValue(column: RenderColumn, value: unknown): { column: RenderColumn; value: unknown } | { text: string } | null {
  if (column.type !== "approval" && column.type !== "agent") return null;
  const object = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  if (column.type === "approval") return { text: APPROVAL_STATE_TEXT[String(object.state)] ?? "" };
  if (object.value === null || object.value === undefined) return { text: "" };
  const output = column.config?.output ?? "text";
  return { column: { ...column, type: output, config: { options: column.config?.options } }, value: object.value };
}

/**
 * The value as text, by type and display. Empty values give "" (callers
 * show the "Sem valor" marker); checkboxes always read Sim/Não.
 */
export function formatValue(column: RenderColumn, value: unknown, ctx: FormatContext, display?: string): string {
  const msgs = messages(ctx.locale);
  if (column.type === "checkbox") return value === true ? msgs.yes : msgs.no;
  if (isEmptyValue(value)) return "";
  const structured = structuredValue(column, value);
  if (structured) return "text" in structured ? structured.text : formatValue(structured.column, structured.value, ctx, display);
  const type = column.type;
  if (type === "number") {
    if (typeof value !== "number") return String(value);
    switch (display) {
      case "compact":
        return formatNumber(value, column, ctx.locale, "compact");
      case "currency":
        return formatNumber(value, column, ctx.locale, "currency");
      case "percent":
      case "bar":
      case "ring":
        // Progress displays: a percent column is a fraction, any other number is out of 100.
        return numberKind(column) === "percent"
          ? formatNumber(value, column, ctx.locale, "percent")
          : formatPercentFraction(value / 100, ctx.locale);
      case "number":
        return formatNumber(value, column, ctx.locale, "number");
      default:
        return formatNumberByColumn(value, column, ctx.locale);
    }
  }
  if (isDateColumn(type)) return formatDateValue(column, value, ctx, dateDisplay(display));
  if (type === "select" || type === "status") return optionName(column, value, ctx.locale);
  if (type === "multi_select") return optionValues(value).map((item) => optionName(column, item, ctx.locale)).join(", ");
  if (isPersonColumn(type)) {
    const people = personRefs(value, ctx.users, ctx.locale);
    if (display === "initials") return people.map((person) => initials(person.name)).join(", ");
    return people.map((person) => person.name).join(", ");
  }
  if (type === "ref") return refValues(value).map(refText).join(", ");
  if (type === "url" && typeof value === "string") return display === "domain" ? urlDomain(value) : urlText(value);
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * The value as `data-ravi-value` text for agents: ISO date (`start/end` for a
 * range), plain number, `true`/`false`, option names, person ids, `type:id`;
 * lists comma-joined.
 */
export function rawValueText(column: Pick<RenderColumn, "type" | "config">, value: unknown): string {
  if (column.type === "checkbox") return value === true ? "true" : "false";
  if (isEmptyValue(value)) return "";
  if (column.type === "approval" || column.type === "agent") {
    const object = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    if (column.type === "approval") return typeof object.state === "string" ? object.state : "";
    const inner = object.value;
    if (inner === null || inner === undefined) return "";
    return rawValueText({ type: column.config?.output ?? "text", config: { options: column.config?.options } }, inner);
  }
  const type = column.type;
  if (type === "number") return String(value);
  if (isDateColumn(type)) {
    const range = parseDateRange(value);
    if (!range) return typeof value === "string" ? value : "";
    return range.end ? `${range.start.iso}/${range.end.iso}` : range.start.iso;
  }
  if (type === "select" || type === "status" || type === "multi_select") {
    return optionValues(value)
      .map((item) => optionFor(column, item)?.name ?? (typeof item === "string" ? item : ""))
      .filter(Boolean)
      .join(",");
  }
  if (isPersonColumn(type)) return personRefs(value, {}, "en").map((person) => person.id).join(",");
  if (type === "ref") return refValues(value).map(refText).join(",");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

// ---------------------------------------------------------------------------
// Template filters

type FilterPlan = {
  dateMode: DateDisplay | null;
  numberMode: "number" | "currency" | "compact" | null;
  currency: boolean;
  initials: boolean;
};

function filterPlan(filters: readonly TemplateFilter[]): FilterPlan {
  const plan: FilterPlan = { dateMode: null, numberMode: null, currency: false, initials: false };
  for (const filter of filters) {
    if (filter === "date" || filter === "relative") plan.dateMode = filter;
    else if (filter === "initials") plan.initials = true;
    else if (filter === "currency") {
      plan.currency = true;
      if (plan.numberMode !== "compact") plan.numberMode = "currency";
    } else if (filter === "compact") plan.numberMode = "compact";
    else if (filter === "number") plan.numberMode = "number";
  }
  return plan;
}

function filterNumber(plan: FilterPlan, column: RenderColumn, value: unknown): number | null {
  if (!plan.numberMode || (column.type !== "number" && column.type !== "text")) return null;
  if (typeof value === "number") return value;
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
}

/**
 * `{path | f1 | f2}`: date filters pick the date mode, number filters the
 * number mode (`currency | compact` is a compact currency), and `initials`
 * applies to the final text. A filter that does not fit the value's type is
 * ignored.
 */
export function applyFilters(filters: readonly TemplateFilter[], column: RenderColumn, value: unknown, ctx: FormatContext): string {
  const plan = filterPlan(filters);
  let text: string;
  const numeric = filterNumber(plan, column, value);
  if (plan.numberMode && numeric !== null) {
    const numberColumn = plan.currency && numberKind(column) !== "currency" ? { ...column, config: { ...column.config, format: "currency" as const } } : column;
    text = formatNumber(numeric, numberColumn, ctx.locale, plan.numberMode);
  } else if (plan.dateMode && parseDateRange(value)) {
    const dateColumn = isDateColumn(column.type) ? column : { ...column, type: "date" as const };
    text = formatDateValue(dateColumn, value, ctx, plan.dateMode);
  } else {
    text = formatValue(column, value, ctx);
  }
  if (plan.initials) {
    if (isPersonColumn(column.type)) return personRefs(value, ctx.users, ctx.locale).map((person) => initials(person.name)).join(", ");
    return text ? initials(text) : "";
  }
  return text;
}

/**
 * The date `{path | filters}` shows, as `applyFilters` formats it, with ISO
 * values; null when the filters show initials or a number, or the value is
 * not a date.
 */
export function filteredDateParts(filters: readonly TemplateFilter[], column: RenderColumn, value: unknown, ctx: FormatContext): DateText | null {
  const plan = filterPlan(filters);
  if (plan.initials || filterNumber(plan, column, value) !== null) return null;
  if (plan.dateMode && parseDateRange(value)) {
    return formatDateParts(isDateColumn(column.type) ? column : { ...column, type: "date" }, value, ctx, plan.dateMode);
  }
  return isDateColumn(column.type) && !isEmptyValue(value) ? formatDateParts(column, value, ctx, "date") : null;
}

export function applyFilter(filter: TemplateFilter, column: RenderColumn, value: unknown, ctx: FormatContext): string {
  return applyFilters([filter], column, value, ctx);
}
