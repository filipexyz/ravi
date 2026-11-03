// Value normalization for Bases cells. Shared by the server (authoritative
// write path, type migrations, CSV) and the Console UI (pre-validation).
//
// Stored form (`base_rows.values_json[propertyId]`): empty values are absent
// keys; checkbox is `true` or absent; email is lowercased; date is
// `{ start, end }` with `YYYY-MM-DD` endpoints, or `toISOString()` instants
// when `config.includeTime` is true; select/status store an option id,
// multi_select option ids, person user ids, ref `{ type, id }` objects.
// approval stores the full `BaseApprovalValue` and agent the full
// `BaseAgentValue`; both are produced by the server, never stored from input.

import { BASE_PHONE_PATTERN, BASE_PROPERTY_KEY_PATTERN, BASES_LIMITS } from "./limits";
import { isValidDateOnly, isValidTimeZone, localDateString, normalizeBaseInstant, zonedMidnightUtc } from "./time";
import {
  BASE_AGENT_STATES,
  BASE_APPROVAL_STATES,
  BASE_OPTION_COLORS,
  BASE_RESERVED_KEYS,
  BASE_STATUS_GROUPS,
  type BaseAgentState,
  type BaseAgentValue,
  type BaseApprovalState,
  type BaseApprovalValue,
  type BaseCellValue,
  type BaseDateValue,
  type BaseOptionColor,
  type BaseProperty,
  type BasePropertyType,
  type BaseRefValue,
  type BaseSelectOption,
  type BaseStatusGroup,
  type BaseUserRef,
} from "./types";

export type BaseValueResult = { ok: true; value: unknown | undefined } | { ok: false; error: string };
export type BaseValueOptions = {
  timezone?: string;
  /** The stored value being replaced: archived options it already holds stay writable. */
  existing?: unknown;
};
/** `truncated`: the value converts but keeps fewer values than the source held. */
export type BaseConvertedValue = { value: unknown | undefined; cleared: boolean; truncated?: true };
export type BaseSelectOptionInput = {
  id?: string;
  name: string;
  color?: BaseOptionColor;
  group?: BaseStatusGroup;
  archived?: boolean;
};
export type BaseSelectOptionsResult = { ok: true; options: BaseSelectOption[] } | { ok: false; error: string };
export type BaseOptionPropertyType = "select" | "multi_select" | "status";

export const BASE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const BASE_REF_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
export const BASE_EMAIL_PATTERN = /^[^\s@"<>(),;:\\[\]]+@[^\s@"<>(),;:\\[\]]+\.[^\s@"<>(),;:\\[\]]+$/;
const NUMERIC_STRING_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const REF_ID_MAX_CHARS = 200;
const OPTION_NAME_MAX_CHARS = 100;

const absent: BaseValueResult = { ok: true, value: undefined };
const ok = (value: unknown): BaseValueResult => ({ ok: true, value });
const fail = (error: string): BaseValueResult => ({ ok: false, error });

const textEncoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function baseUtf8Bytes(value: string): number {
  return textEncoder.encode(value).length;
}

/**
 * True when a string in `value` (nested up to `depth` levels) contains U+0000,
 * which Postgres rejects in text and jsonb.
 */
export function baseHasNul(value: unknown, depth = 4): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (depth <= 0 || !value || typeof value !== "object") return false;
  const items = Array.isArray(value) ? value : Object.entries(value).flat();
  return items.some((item) => baseHasNul(item, depth - 1));
}

export const BASE_NUL_ERROR = "Values cannot contain NUL (U+0000) characters.";

/** True when `value` is a UUID string (any version, case-insensitive). */
export function isBaseUuid(value: unknown): value is string {
  return typeof value === "string" && BASE_UUID_PATTERN.test(value);
}

function optionKey(name: string) {
  return name.trim().normalize("NFC").toLocaleLowerCase("en-US");
}

/**
 * Finds an option by exact id, else by case-insensitive name (non-archived
 * options win over archived ones with the same name). Null when unknown.
 */
export function findBaseOption(options: readonly BaseSelectOption[] | undefined, ref: string): BaseSelectOption | null {
  if (!options || typeof ref !== "string") return null;
  const byId = options.find((option) => option.id === ref);
  if (byId) return byId;
  return findBaseOptionByName(options, ref);
}

/** Finds an option by case-insensitive name only, preferring non-archived options. */
export function findBaseOptionByName(options: readonly BaseSelectOption[] | undefined, name: string): BaseSelectOption | null {
  if (!options || typeof name !== "string") return null;
  const key = optionKey(name);
  if (!key) return null;
  const matches = options.filter((option) => optionKey(option.name) === key);
  return matches.find((option) => !option.archived) ?? matches[0] ?? null;
}

/** Field error for any attempt to write an `agent` cell through rows or views. */
export const BASE_AGENT_READONLY_ERROR = "agent_readonly";

/** Normalized `approval` input: the server turns it into a stored `BaseApprovalValue`. */
export type BaseApprovalIntent = { state: BaseApprovalState; note: string | null };

/** True for a normalized approval intent (as returned by `normalizeBaseValueInput` for `approval`). */
export function isBaseApprovalIntent(value: unknown): value is BaseApprovalIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    (BASE_APPROVAL_STATES as readonly unknown[]).includes(record.state) &&
    (record.note === null || typeof record.note === "string")
  );
}

/** State of a stored approval value; null when empty or malformed. */
export function baseApprovalState(stored: unknown): BaseApprovalState | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const state = (stored as Record<string, unknown>).state;
  return (BASE_APPROVAL_STATES as readonly unknown[]).includes(state) ? (state as BaseApprovalState) : null;
}

/** State of a stored agent value; null when empty or malformed. */
export function baseAgentState(stored: unknown): BaseAgentState | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const state = (stored as Record<string, unknown>).state;
  return (BASE_AGENT_STATES as readonly unknown[]).includes(state) ? (state as BaseAgentState) : null;
}

/** PT-BR labels for approval and agent states (display and CSV). */
export const BASE_APPROVAL_STATE_LABELS: Record<BaseApprovalState, string> = {
  pending: "Pendente",
  approved: "Aprovado",
  rejected: "Recusado",
};
export const BASE_AGENT_STATE_LABELS: Record<BaseAgentState, string> = {
  pending: "Preenchendo…",
  done: "Pronto",
  error: "Erro",
};

/**
 * The property an agent column's value is shaped like: its `output` type with
 * the agent's options. Used to validate fills and to display values.
 */
export function baseAgentOutputProperty(property: BaseProperty): BaseProperty {
  const output = property.config.output ?? "text";
  const config = output === "select" || output === "multi_select" ? { options: property.config.options ?? [] } : {};
  return { ...property, type: output, config };
}

/**
 * Validates an agent fill value against the column's output type. A checkbox
 * output keeps an explicit `false`; an empty value is null.
 */
export function normalizeBaseAgentOutput(property: BaseProperty, input: unknown, options: BaseValueOptions = {}): BaseValueResult {
  const output = baseAgentOutputProperty(property);
  if (output.type === "checkbox") {
    if (input === false || input === "false") return ok(false);
    const result = normalizeBaseValueInput(output, input, options);
    return result.ok ? ok(result.value === undefined ? null : result.value) : result;
  }
  const result = normalizeBaseValueInput(output, input, options);
  return result.ok ? ok(result.value === undefined ? null : result.value) : result;
}

function normalizeApprovalInput(input: unknown): BaseValueResult {
  if (input === "pending") return ok({ state: "pending", note: null } satisfies BaseApprovalIntent);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return fail('Expected "pending", { state, note? }, or null.');
  }
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "state" && key !== "note")) {
    return fail("Approval input only has state and note; the server fills who and when.");
  }
  if (!(BASE_APPROVAL_STATES as readonly unknown[]).includes(record.state)) {
    return fail("Approval state must be pending, approved, or rejected.");
  }
  let note: string | null = null;
  if (record.note !== undefined && record.note !== null) {
    if (typeof record.note !== "string") return fail("Approval note must be text.");
    const trimmed = record.note.trim();
    if (trimmed.length > BASES_LIMITS.approvalNoteChars) {
      return fail(`Approval notes are limited to ${BASES_LIMITS.approvalNoteChars} characters.`);
    }
    note = trimmed || null;
  }
  return ok({ state: record.state as BaseApprovalState, note } satisfies BaseApprovalIntent);
}

/**
 * Validates and normalizes one cell value for writing. `value: undefined`
 * means "store as absent". `options.timezone` (default UTC) converts
 * date-only input for `includeTime` properties to the instant of local midnight.
 */
export function normalizeBaseValueInput(
  property: BaseProperty,
  input: unknown,
  options: BaseValueOptions = {},
): BaseValueResult {
  if (input === undefined || input === null) return absent;
  if (baseHasNul(input)) return fail(BASE_NUL_ERROR);
  switch (property.type) {
    case "text":
      return normalizeText(input);
    case "number":
      return normalizeNumber(input);
    case "checkbox":
      return normalizeCheckbox(input);
    case "date":
      return normalizeDate(property, input, options.timezone ?? "UTC");
    case "select":
    case "status":
      return normalizeSingleOption(property, input, options.existing);
    case "multi_select":
      return normalizeMultiOption(property, input, options.existing);
    case "url":
      return normalizeUrl(input);
    case "email":
      return normalizeEmail(input);
    case "phone":
      return normalizePhone(input);
    case "person":
      return normalizePerson(input);
    case "ref":
      return normalizeRefs(input);
    case "approval":
      // An intent (`BaseApprovalIntent`); the server resolves it against the caller and the stored value.
      return normalizeApprovalInput(input);
    case "agent":
      return fail(BASE_AGENT_READONLY_ERROR);
    default:
      return fail("Unsupported property type.");
  }
}

function normalizeText(input: unknown) {
  if (typeof input === "number" && Number.isFinite(input)) return ok(String(input));
  if (typeof input !== "string") return fail("Expected text.");
  if (input === "") return absent;
  if (baseUtf8Bytes(input) > BASES_LIMITS.textBytes) return fail(`Text is limited to ${BASES_LIMITS.textBytes} bytes.`);
  return ok(input);
}

function normalizeNumber(input: unknown) {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) return fail("Expected a finite number.");
    return ok(input === 0 ? 0 : input);
  }
  if (typeof input !== "string") return fail("Expected a number.");
  const trimmed = input.trim();
  if (!trimmed) return absent;
  if (!NUMERIC_STRING_PATTERN.test(trimmed)) return fail("Expected a number.");
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return fail("Expected a finite number.");
  return ok(value === 0 ? 0 : value);
}

function normalizeCheckbox(input: unknown) {
  if (input === true) return ok(true);
  if (input === false) return absent;
  if (typeof input === "string") {
    const trimmed = input.trim().toLowerCase();
    if (trimmed === "true") return ok(true);
    if (trimmed === "false" || trimmed === "") return absent;
  }
  return fail("Expected true or false.");
}

function normalizeDateEndpoint(value: unknown, includeTime: boolean, timezone: string): string | { error: string } {
  if (typeof value !== "string") return { error: "Expected a date string." };
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    if (!isValidDateOnly(trimmed)) return { error: `Invalid date "${trimmed}".` };
    return includeTime ? zonedMidnightUtc(trimmed, timezone).toISOString() : trimmed;
  }
  const instant = normalizeBaseInstant(trimmed);
  if (!instant) return { error: `Invalid date "${trimmed}". Use YYYY-MM-DD or an ISO-8601 instant with an offset.` };
  if (!includeTime) return { error: "This date property has no time; use YYYY-MM-DD." };
  return instant;
}

function normalizeDate(property: BaseProperty, input: unknown, timezone: string) {
  if (!isValidTimeZone(timezone)) return fail("Invalid time zone.");
  const includeTime = property.config.includeTime === true;
  let start: unknown;
  let end: unknown = null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return absent;
    const parts = trimmed.split("/");
    if (parts.length > 2) return fail("Expected a date or a start/end interval.");
    start = parts[0];
    end = parts.length === 2 ? parts[1] : null;
  } else if (input && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "start" && key !== "end")) {
      return fail("Date objects only have start and end.");
    }
    start = record.start;
    end = record.end ?? null;
  } else {
    return fail("Expected a date.");
  }
  const normalizedStart = normalizeDateEndpoint(start, includeTime, timezone);
  if (typeof normalizedStart !== "string") return fail(normalizedStart.error);
  let normalizedEnd: string | null = null;
  if (end !== null && end !== "") {
    const candidate = normalizeDateEndpoint(end, includeTime, timezone);
    if (typeof candidate !== "string") return fail(candidate.error);
    if (candidate < normalizedStart) return fail("Date end must not be before start.");
    normalizedEnd = candidate;
  }
  const value: BaseDateValue = { start: normalizedStart, end: normalizedEnd };
  return ok(value);
}

function storedOptionIds(existing: unknown): string[] {
  if (typeof existing === "string") return [existing];
  return Array.isArray(existing) ? existing.filter((id): id is string => typeof id === "string") : [];
}

function resolveWritableOption(property: BaseProperty, raw: unknown, kept: readonly string[]): { id: string } | { error: string } {
  if (typeof raw !== "string") return { error: "Expected an option id or name." };
  const option = findBaseOption(property.config.options, raw.trim());
  if (!option) return { error: `Unknown option "${raw}".` };
  if (option.archived && !kept.includes(option.id)) return { error: `Option "${option.name}" is archived.` };
  return { id: option.id };
}

function normalizeSingleOption(property: BaseProperty, input: unknown, existing: unknown) {
  if (input === "") return absent;
  const resolved = resolveWritableOption(property, input, storedOptionIds(existing));
  return "error" in resolved ? fail(resolved.error) : ok(resolved.id);
}

function normalizeMultiOption(property: BaseProperty, input: unknown, existing: unknown) {
  const items = typeof input === "string" ? (input === "" ? [] : [input]) : input;
  if (!Array.isArray(items)) return fail("Expected a list of option ids or names.");
  const kept = storedOptionIds(existing);
  const ids: string[] = [];
  for (const item of items) {
    const resolved = resolveWritableOption(property, item, kept);
    if ("error" in resolved) return fail(resolved.error);
    if (!ids.includes(resolved.id)) ids.push(resolved.id);
  }
  if (ids.length > BASES_LIMITS.multiSelectValues) return fail(`At most ${BASES_LIMITS.multiSelectValues} options.`);
  return ids.length ? ok(ids) : absent;
}

function normalizePerson(input: unknown) {
  const items = typeof input === "string" ? (input === "" ? [] : [input]) : input;
  if (!Array.isArray(items)) return fail("Expected a user id or a list of user ids.");
  const ids: string[] = [];
  for (const item of items) {
    if (typeof item !== "string" || !BASE_UUID_PATTERN.test(item.trim())) return fail("Expected user ids.");
    const id = item.trim().toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length > BASES_LIMITS.personValues) return fail(`At most ${BASES_LIMITS.personValues} people.`);
  return ids.length ? ok(ids) : absent;
}

/** Validates one `{ type, id }` reference; null when invalid. */
export function normalizeBaseRef(input: unknown): BaseRefValue | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "type" && key !== "id")) return null;
  const { type, id } = record;
  if (typeof type !== "string" || !BASE_REF_TYPE_PATTERN.test(type)) return null;
  if (typeof id !== "string" || id.length < 1 || id.length > REF_ID_MAX_CHARS) return null;
  return { type, id };
}

function normalizeRefs(input: unknown) {
  const items = Array.isArray(input) ? input : [input];
  const refs: BaseRefValue[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const ref = normalizeBaseRef(item);
    if (!ref) return fail("Expected { type, id } references.");
    const key = `${ref.type}\u0000${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  if (refs.length > BASES_LIMITS.refValues) return fail(`At most ${BASES_LIMITS.refValues} references.`);
  return refs.length ? ok(refs) : absent;
}

function normalizeUrl(input: unknown) {
  if (typeof input !== "string") return fail("Expected a URL.");
  const trimmed = input.trim();
  if (!trimmed) return absent;
  if (trimmed.length > BASES_LIMITS.urlChars) return fail(`URLs are limited to ${BASES_LIMITS.urlChars} characters.`);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail("Expected an http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return fail("Expected an http or https URL.");
  return ok(trimmed);
}

function normalizeEmail(input: unknown) {
  if (typeof input !== "string") return fail("Expected an email address.");
  const value = input.trim().toLowerCase();
  if (!value) return absent;
  if (value.length > BASES_LIMITS.emailChars || !BASE_EMAIL_PATTERN.test(value)) return fail("Expected an email address.");
  return ok(value);
}

function normalizePhone(input: unknown) {
  if (typeof input !== "string") return fail("Expected a phone number.");
  const value = input.trim();
  if (!value) return absent;
  if (!BASE_PHONE_PATTERN.test(value)) return fail("Expected a phone number.");
  return ok(value);
}

/** API value of a stored cell: checkbox absent becomes false; other absent cells are undefined. */
export function baseValueToApi(property: Pick<BaseProperty, "type">, stored: unknown): BaseCellValue | undefined {
  if (property.type === "checkbox") return stored === true;
  if (stored === undefined || stored === null) return undefined;
  return stored as BaseCellValue;
}

function formatNumber(property: BaseProperty, value: number) {
  const precision = property.config.precision;
  const fixed = (n: number, fallback?: number) => {
    const digits = precision ?? fallback;
    return digits === undefined ? String(n) : n.toFixed(digits);
  };
  if (property.config.format === "percent") return `${fixed(Number((value * 100).toPrecision(15)))}%`;
  if (property.config.format === "currency") {
    const amount = fixed(value, 2);
    return property.config.currency ? `${property.config.currency} ${amount}` : amount;
  }
  return fixed(value);
}

/**
 * Plain-text rendering of an API value, used for text conversion and CSV
 * export. Dates use ISO forms (`start` or `start/end`); options use names;
 * people use display names from `users` when known, else ids.
 */
export function displayBaseValue(
  property: BaseProperty,
  apiValue: unknown,
  users?: Record<string, Pick<BaseUserRef, "displayName">>,
): string {
  if (apiValue === undefined || apiValue === null) return property.type === "checkbox" ? "false" : "";
  switch (property.type) {
    case "text":
    case "url":
    case "email":
    case "phone":
      return typeof apiValue === "string" ? apiValue : String(apiValue);
    case "number":
      return typeof apiValue === "number" ? formatNumber(property, apiValue) : String(apiValue);
    case "checkbox":
      return apiValue === true ? "true" : "false";
    case "date": {
      const value = apiValue as Partial<BaseDateValue>;
      if (typeof apiValue === "string") return apiValue;
      if (typeof value.start !== "string") return "";
      return value.end ? `${value.start}/${value.end}` : value.start;
    }
    case "select":
    case "status":
      return typeof apiValue === "string" ? optionName(property, apiValue) : "";
    case "multi_select":
      return Array.isArray(apiValue) ? apiValue.map((id) => optionName(property, String(id))).join(", ") : "";
    case "person":
      return Array.isArray(apiValue)
        ? apiValue.map((id) => users?.[String(id)]?.displayName || String(id)).join(", ")
        : "";
    case "ref":
      return Array.isArray(apiValue)
        ? apiValue
            .map((ref) => (ref && typeof ref === "object" ? `${(ref as BaseRefValue).type}:${(ref as BaseRefValue).id}` : ""))
            .filter(Boolean)
            .join(", ")
        : "";
    case "approval": {
      const state = baseApprovalState(apiValue);
      return state ? BASE_APPROVAL_STATE_LABELS[state] : "";
    }
    case "agent": {
      const value = apiValue as Partial<BaseAgentValue>;
      if (value.value === undefined || value.value === null) return "";
      return displayBaseValue(baseAgentOutputProperty(property), value.value, users);
    }
    default:
      return "";
  }
}

/** Display text of an approval value with who decided (PT-BR), for read-only cells. */
export function describeBaseApproval(
  value: Partial<BaseApprovalValue> | null | undefined,
  users?: Record<string, Pick<BaseUserRef, "displayName">>,
): string {
  const state = baseApprovalState(value);
  if (!state) return "";
  const label = BASE_APPROVAL_STATE_LABELS[state];
  const by = state === "pending" ? value?.requestedBy : value?.decidedBy;
  const name = by ? users?.[by]?.displayName || by : null;
  return name ? `${label} (${name})` : label;
}

function optionName(property: BaseProperty, id: string) {
  return property.config.options?.find((option) => option.id === id)?.name ?? id;
}

const OPTION_TYPES: ReadonlySet<BasePropertyType> = new Set(["select", "multi_select", "status"]);

function mapOption(from: BaseProperty, to: BaseProperty, id: unknown): string | null {
  if (typeof id !== "string") return null;
  const target = to.config.options ?? [];
  if (target.some((option) => option.id === id)) return id;
  const source = from.config.options?.find((option) => option.id === id);
  if (!source) return null;
  const byName = findBaseOptionByName(target, source.name);
  return byName && !byName.archived ? byName.id : null;
}

function mapOptionByName(to: BaseProperty, name: string): string | null {
  const option = findBaseOptionByName(to.config.options, name);
  return option && !option.archived ? option.id : null;
}

function convertDate(from: BaseProperty, to: BaseProperty, stored: unknown, timezone: string): unknown | undefined {
  if (!stored || typeof stored !== "object") return undefined;
  const value = stored as Partial<BaseDateValue>;
  const fromTime = from.config.includeTime === true;
  const toTime = to.config.includeTime === true;
  const convert = (endpoint: unknown): string | null => {
    if (typeof endpoint !== "string") return null;
    if (fromTime === toTime) return endpoint;
    if (toTime) return isValidDateOnly(endpoint) ? zonedMidnightUtc(endpoint, timezone).toISOString() : null;
    const instant = normalizeBaseInstant(endpoint);
    return instant ? localDateString(new Date(instant), timezone) : null;
  };
  const start = convert(value.start);
  if (!start) return undefined;
  const end = value.end ? convert(value.end) : null;
  const result = normalizeBaseValueInput(to, { start, end: end && end >= start ? end : null }, { timezone });
  return result.ok ? result.value : undefined;
}

type ConvertFlags = { truncated: boolean };

function convertInner(
  from: BaseProperty,
  to: BaseProperty,
  stored: unknown,
  timezone: string,
  flags: ConvertFlags,
): unknown | undefined {
  if (from.type === "date" && to.type === "date") return convertDate(from, to, stored, timezone);

  if (OPTION_TYPES.has(from.type) && OPTION_TYPES.has(to.type)) {
    const sourceIds = Array.isArray(stored) ? stored : [stored];
    const mapped: string[] = [];
    let dropped = false;
    for (const id of sourceIds) {
      const target = mapOption(from, to, id);
      if (!target) dropped = true;
      else if (!mapped.includes(target)) mapped.push(target);
    }
    if (!mapped.length) return undefined;
    // A single-option target keeps the first option only.
    const kept = mapped.slice(0, to.type === "multi_select" ? BASES_LIMITS.multiSelectValues : 1);
    flags.truncated = dropped || kept.length < mapped.length;
    return to.type === "multi_select" ? kept : kept[0];
  }

  if (from.type === to.type) {
    const result = normalizeBaseValueInput(to, stored, { timezone });
    return result.ok ? result.value : undefined;
  }

  if (from.type === "number" && to.type === "text") return typeof stored === "number" ? String(stored) : undefined;

  const text = displayBaseValue(from, baseValueToApi(from, stored));
  if (!text) return undefined;
  if (OPTION_TYPES.has(to.type)) {
    if (to.type !== "multi_select") return mapOptionByName(to, text) ?? undefined;
    const ids: string[] = [];
    let dropped = false;
    for (const part of text.split(",")) {
      const id = mapOptionByName(to, part);
      if (id && !ids.includes(id)) ids.push(id);
      else if (!id && part.trim()) dropped = true;
    }
    if (!ids.length) return undefined;
    flags.truncated = dropped || ids.length > BASES_LIMITS.multiSelectValues;
    return ids.slice(0, BASES_LIMITS.multiSelectValues);
  }
  const result = normalizeBaseValueInput(to, text, { timezone });
  return result.ok ? result.value : undefined;
}

/**
 * Converts a stored value for a property type change or an `includeTime`
 * toggle. Values that cannot be converted are cleared (`cleared: true`).
 * A value that converts but keeps fewer values than the source (a
 * `multi_select` becoming a `select` keeps its first option; options or
 * comma-separated parts with no match in the target are dropped) is
 * `truncated: true`.
 */
export function convertBaseValue(
  from: BaseProperty,
  to: BaseProperty,
  stored: unknown,
  options: { timezone: string },
): BaseConvertedValue {
  if (stored === undefined || stored === null) return { value: undefined, cleared: false };
  const flags: ConvertFlags = { truncated: false };
  const value = convertInner(from, to, stored, options.timezone, flags);
  if (value === undefined) return { value: undefined, cleared: true };
  return flags.truncated ? { value, cleared: false, truncated: true } : { value, cleared: false };
}

function randomOptionId(taken: Set<string>) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  for (;;) {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    let id = "";
    for (const byte of bytes) id += alphabet[byte % 36];
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * Merges an options input into the existing options. An input with an `id`
 * updates that option. An input without one reuses the existing option with
 * the same name (case-insensitive, NFC; one in the state the input asks for
 * first, then config order) that no input references by id or claimed: it
 * keeps that option's id, color, and group unless given, and is active unless
 * `archived: true`. Other inputs get random ids. Colors default by cycling,
 * status options default to group `todo`, and existing options missing from
 * the input are kept as archived.
 */
export function normalizeSelectOptions(
  type: BaseOptionPropertyType,
  existing: readonly BaseSelectOption[],
  input: readonly BaseSelectOptionInput[],
): BaseSelectOptionsResult {
  const existingById = new Map(existing.map((option) => [option.id, option]));
  const taken = new Set(existing.map((option) => option.id));
  const referenced = new Set(input.map((item) => item?.id));
  const existingByName = new Map<string, BaseSelectOption[]>();
  for (const option of existing) {
    if (referenced.has(option.id)) continue;
    const key = optionKey(option.name);
    existingByName.set(key, [...(existingByName.get(key) ?? []), option]);
  }
  // Id-less items claim a same-name option: first one in the state they ask
  // for (active unless `archived: true`), then any, so input order never
  // decides which id stays active.
  const nameMatches = new Map<number, BaseSelectOption>();
  const claimed = new Set<string>();
  for (const sameStateOnly of [true, false]) {
    input.forEach((item, index) => {
      if (!item || typeof item.name !== "string" || item.id !== undefined || nameMatches.has(index)) return;
      const archived = item.archived === true;
      const match = (existingByName.get(optionKey(item.name)) ?? []).find(
        (option) => !claimed.has(option.id) && (!sameStateOnly || (option.archived === true) === archived),
      );
      if (!match) return;
      nameMatches.set(index, match);
      claimed.add(match.id);
    });
  }
  const usedIds = new Set<string>();
  const options: BaseSelectOption[] = [];

  const build = (
    id: string,
    name: string,
    color: unknown,
    group: unknown,
    archived: boolean,
  ): BaseSelectOption | string => {
    if (typeof color !== "string" || !(BASE_OPTION_COLORS as readonly string[]).includes(color)) {
      return `Invalid color for option "${name}".`;
    }
    const option: BaseSelectOption = { id, name, color: color as BaseOptionColor };
    if (type === "status") {
      const resolvedGroup = group ?? "todo";
      if (typeof resolvedGroup !== "string" || !(BASE_STATUS_GROUPS as readonly string[]).includes(resolvedGroup)) {
        return `Invalid group for option "${name}".`;
      }
      option.group = resolvedGroup as BaseStatusGroup;
    }
    if (archived) option.archived = true;
    return option;
  };

  for (const [index, item] of input.entries()) {
    if (!item || typeof item !== "object" || typeof item.name !== "string") return { ok: false, error: "Options need a name." };
    const name = item.name.trim();
    if (!name || name.length > OPTION_NAME_MAX_CHARS) {
      return { ok: false, error: `Option names are 1-${OPTION_NAME_MAX_CHARS} characters.` };
    }
    if (baseHasNul(name)) return { ok: false, error: BASE_NUL_ERROR };
    let prior: BaseSelectOption | undefined;
    if (item.id !== undefined) {
      prior = existingById.get(item.id);
      if (!prior) return { ok: false, error: `Unknown option id "${item.id}".` };
    } else {
      prior = nameMatches.get(index);
    }
    const id = prior?.id ?? randomOptionId(taken);
    if (usedIds.has(id)) return { ok: false, error: `Option "${name}" is listed twice.` };
    usedIds.add(id);
    const color = item.color ?? prior?.color ?? BASE_OPTION_COLORS[options.length % BASE_OPTION_COLORS.length];
    // Listing a name means the option should exist: a name-matched archived option comes back.
    const archived = item.archived ?? (item.id !== undefined ? prior?.archived : false) ?? false;
    const option = build(id, name, color, item.group ?? prior?.group, archived);
    if (typeof option === "string") return { ok: false, error: option };
    options.push(option);
  }

  for (const prior of existing) {
    if (usedIds.has(prior.id)) continue;
    const option = build(prior.id, prior.name, prior.color, prior.group, true);
    if (typeof option === "string") return { ok: false, error: option };
    options.push(option);
  }

  if (options.length > BASES_LIMITS.optionsPerProperty) {
    return { ok: false, error: `At most ${BASES_LIMITS.optionsPerProperty} options, including archived ones.` };
  }
  const names = new Set<string>();
  for (const option of options) {
    if (option.archived) continue;
    const key = optionKey(option.name);
    if (names.has(key)) return { ok: false, error: `Option names must be unique: "${option.name}".` };
    names.add(key);
  }
  return { ok: true, options };
}

/** Default options for a new `status` property. */
export function defaultStatusOptions(): BaseSelectOption[] {
  const taken = new Set<string>();
  return [
    { id: randomOptionId(taken), name: "Not started", color: "gray", group: "todo" },
    { id: randomOptionId(taken), name: "In progress", color: "blue", group: "in_progress" },
    { id: randomOptionId(taken), name: "Done", color: "green", group: "done" },
  ];
}

const TRANSLITERATIONS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ı: "i",
};
const RESERVED_KEYS: ReadonlySet<string> = new Set(BASE_RESERVED_KEYS);
const KEY_MAX_CHARS = 63;

/**
 * Derives a property key from a display name (accents transliterated,
 * `[a-z0-9_]`, starting with a letter), avoiding reserved and `taken` keys
 * with `_2`, `_3`, ... suffixes.
 */
export function basePropertyKeyFromName(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .split("")
    .map((char) => TRANSLITERATIONS[char] ?? char)
    .join("")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) base = "property";
  if (!/^[a-z]/.test(base)) base = `p_${base}`;
  base = base.slice(0, KEY_MAX_CHARS).replace(/_+$/, "");
  let candidate = base;
  for (let n = 2; RESERVED_KEYS.has(candidate) || taken.has(candidate) || !BASE_PROPERTY_KEY_PATTERN.test(candidate); n += 1) {
    const suffix = `_${n}`;
    candidate = `${base.slice(0, KEY_MAX_CHARS - suffix.length).replace(/_+$/, "")}${suffix}`;
  }
  return candidate;
}
