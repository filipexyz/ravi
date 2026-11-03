// Static data (`<ravi-widget data=...>`, `example.json`) in friendly shapes,
// normalized to render records (CONTRACT 4.5): option names become options
// of a synthetic column config (the name is the id), people become inline
// `{ id, displayName, avatarUrl }` values plus a `users` map, dates become
// `{ start, end }`. Wrong types are diagnostics and the value is dropped.

import type { BaseOptionColor, BaseRefValue, BaseSelectOption, BaseStatusGroup, BaseUserRef } from "@/shared/bases/types";

import { OPTION_COLORS, type Diagnostic, type RenderColumn, type RenderRecord, type WidgetFieldSpec } from "../types";
import { humanizeKey } from "./fields";
import { parseDatePoint } from "./format";
import { messageLocale } from "./messages";

export type StaticNormalized = {
  record: RenderRecord;
  columns: Record<string, RenderColumn>;
  users: Record<string, BaseUserRef>;
  diagnostics: Diagnostic[];
};

const MAX_STATIC_RECORDS = 20;
const SELECT_PALETTE: readonly BaseOptionColor[] = ["blue", "green", "orange", "purple", "pink", "yellow", "brown", "red", "gray"];
const GROUP_COLORS: Record<BaseStatusGroup, BaseOptionColor> = { todo: "gray", in_progress: "blue", done: "green" };
const STATUS_GROUPS: readonly BaseStatusGroup[] = ["todo", "in_progress", "done"];
const DONE_WORDS = /^(conclu[ií]d[oa]s?|feit[oa]s?|pag[oa]s?|entregue|aprovad[oa]|fechad[oa]|finalizad[oa]|done|complete[d]?|finished|closed|paid|delivered|approved)$/i;
const TODO_WORDS = /^(a fazer|novo|nova|pendente|aberto|aberta|backlog|n[aã]o iniciad[oa]|to ?do|new|open|pending|not started)$/i;

function baseColumn(key: string, spec: WidgetFieldSpec): RenderColumn {
  return { key, name: spec.label?.trim() || humanizeKey(key), type: spec.type, config: {} };
}

function stableColor(name: string): BaseOptionColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return SELECT_PALETTE[hash % SELECT_PALETTE.length] as BaseOptionColor;
}

function guessGroup(name: string): BaseStatusGroup {
  const text = name.trim();
  if (DONE_WORDS.test(text)) return "done";
  if (TODO_WORDS.test(text)) return "todo";
  return "in_progress";
}

type Issue = (message: string) => void;

function addOption(column: RenderColumn, raw: unknown, issue: Issue): string | null {
  let name: string | null = null;
  let color: BaseOptionColor | null = null;
  let group: BaseStatusGroup | null = null;
  if (typeof raw === "string") name = raw;
  else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const object = raw as { name?: unknown; color?: unknown; group?: unknown };
    if (typeof object.name === "string") name = object.name;
    if (object.color !== undefined) {
      if (OPTION_COLORS.includes(object.color as BaseOptionColor)) color = object.color as BaseOptionColor;
      else issue(`expects "color" to be one of ${OPTION_COLORS.join(", ")}`);
    }
    if (object.group !== undefined) {
      if (STATUS_GROUPS.includes(object.group as BaseStatusGroup)) group = object.group as BaseStatusGroup;
      else issue(`expects "group" to be one of ${STATUS_GROUPS.join(", ")}`);
    }
  }
  name = name?.trim() ?? null;
  if (!name || name.length > 100) {
    issue('expects an option name or { "name", "color"?, "group"? }');
    return null;
  }
  const options = (column.config.options ??= []);
  if (!options.some((option) => option.name === name)) {
    const option: BaseSelectOption = { id: name, name, color: color ?? stableColor(name) };
    if (column.type === "status") {
      option.group = group ?? guessGroup(name);
      option.color = color ?? GROUP_COLORS[option.group];
    }
    options.push(option);
  }
  return name;
}

function personValue(raw: unknown, users: Record<string, BaseUserRef>, issue: Issue): BaseUserRef | null {
  let name: string | null = null;
  let avatarUrl: string | null = null;
  if (typeof raw === "string") name = raw;
  else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const object = raw as { name?: unknown; displayName?: unknown; avatarUrl?: unknown };
    name = typeof object.name === "string" ? object.name : typeof object.displayName === "string" ? object.displayName : null;
    if (typeof object.avatarUrl === "string") avatarUrl = object.avatarUrl;
    else if (object.avatarUrl !== undefined && object.avatarUrl !== null) issue('expects "avatarUrl" to be a string');
  }
  name = name?.trim() ?? null;
  if (!name || name.length > 200) {
    issue('expects a name or { "name", "avatarUrl"? }');
    return null;
  }
  const user: BaseUserRef = { id: name, displayName: name, avatarUrl };
  users[name] ??= user;
  return user;
}

function refValue(raw: unknown, issue: Issue): BaseRefValue | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const object = raw as { type?: unknown; id?: unknown };
    const id = typeof object.id === "number" && Number.isFinite(object.id) ? String(object.id) : object.id;
    if (typeof object.type === "string" && object.type.trim() && typeof id === "string" && id.trim()) return { type: object.type.trim(), id: id.trim() };
  }
  issue('expects { "type", "id" }');
  return null;
}

function dateValue(raw: unknown, column: RenderColumn, issue: Issue): { start: string; end: string | null } | null {
  const point = (value: unknown) => {
    const parsed = parseDatePoint(value);
    if (parsed?.kind === "instant") column.config.includeTime = true;
    return parsed?.iso ?? null;
  };
  if (typeof raw === "string") {
    const start = point(raw);
    if (start) return { start, end: null };
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const object = raw as { start?: unknown; end?: unknown };
    const start = point(object.start);
    const end = object.end === undefined || object.end === null ? null : point(object.end);
    if (start && (end !== null || object.end === undefined || object.end === null)) return { start, end };
  }
  issue('expects a date "YYYY-MM-DD", an ISO instant with offset, or { "start", "end"? }');
  return null;
}

function normalizeInto(
  fields: Record<string, WidgetFieldSpec>,
  data: unknown,
  columns: Record<string, RenderColumn>,
  users: Record<string, BaseUserRef>,
  diagnostics: Diagnostic[],
  where: string,
): RenderRecord {
  const values: Record<string, unknown> = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    diagnostics.push({ severity: "error", code: "STATIC_DATA_INVALID", message: `${where}must be a JSON object of field values.` });
    return { id: null, version: null, values };
  }
  const input = data as Record<string, unknown>;
  for (const [key, spec] of Object.entries(fields)) {
    const column = (columns[key] ??= baseColumn(key, spec));
    const raw = input[key];
    const issue: Issue = (message) =>
      diagnostics.push({ severity: "error", code: "STATIC_VALUE_INVALID", message: `${where}field "${key}" (${spec.type}) ${message}.` });
    if (raw === undefined || raw === null) {
      if (spec.type === "checkbox") values[key] = false;
      continue;
    }
    switch (spec.type) {
      case "text":
      case "url":
      case "email":
      case "phone":
        if (typeof raw === "string") values[key] = raw;
        else issue("expects a string");
        break;
      case "number":
        if (typeof raw === "number" && Number.isFinite(raw)) values[key] = raw;
        else issue("expects a number");
        break;
      case "checkbox":
        if (typeof raw === "boolean") values[key] = raw;
        else issue("expects true or false");
        break;
      case "date": {
        const value = dateValue(raw, column, issue);
        if (value) values[key] = value;
        break;
      }
      case "select":
      case "status": {
        if (Array.isArray(raw)) {
          issue("expects one option, not a list");
          break;
        }
        const name = addOption(column, raw, issue);
        if (name) values[key] = name;
        break;
      }
      case "multi_select": {
        const names = (Array.isArray(raw) ? raw : [raw]).map((item) => addOption(column, item, issue)).filter((name): name is string => Boolean(name));
        if (names.length) values[key] = [...new Set(names)];
        break;
      }
      case "person": {
        const people = (Array.isArray(raw) ? raw : [raw]).map((item) => personValue(item, users, issue)).filter((user): user is BaseUserRef => Boolean(user));
        if (people.length) values[key] = people;
        break;
      }
      case "ref": {
        const refs = (Array.isArray(raw) ? raw : [raw]).map((item) => refValue(item, issue)).filter((ref): ref is BaseRefValue => Boolean(ref));
        if (refs.length) values[key] = refs;
        break;
      }
      default:
        break;
    }
  }
  return { id: null, version: null, values };
}

/**
 * One static record in the friendly shapes of CONTRACT 4.5 → a render record,
 * its columns (synthetic option configs, `includeTime` when a date is an
 * instant) and the people it names. Unknown keys are ignored.
 */
export function normalizeStaticRecord(fields: Record<string, WidgetFieldSpec>, data: unknown): StaticNormalized {
  const { records, columns, users, diagnostics } = normalizeStaticRecords(fields, [data]);
  return { record: records[0] ?? { id: null, version: null, values: {} }, columns, users, diagnostics };
}

/** Several records sharing one set of columns (options merged across records, first color wins). */
export function normalizeStaticRecords(
  fields: Record<string, WidgetFieldSpec>,
  data: readonly unknown[],
): { records: RenderRecord[]; columns: Record<string, RenderColumn>; users: Record<string, BaseUserRef>; diagnostics: Diagnostic[] } {
  const columns: Record<string, RenderColumn> = {};
  const users: Record<string, BaseUserRef> = {};
  const diagnostics: Diagnostic[] = [];
  const list = data.slice(0, MAX_STATIC_RECORDS);
  if (data.length > MAX_STATIC_RECORDS) {
    diagnostics.push({ severity: "error", code: "STATIC_DATA_INVALID", message: `Static data holds at most ${MAX_STATIC_RECORDS} records.` });
  }
  const records = list.map((item, index) => normalizeInto(fields, item, columns, users, diagnostics, list.length > 1 ? `Record ${index + 1}: ` : ""));
  for (const [key, spec] of Object.entries(fields)) columns[key] ??= baseColumn(key, spec);
  return { records, columns, users, diagnostics: capitalize(diagnostics) };
}

/** `example.json` content (one record, or `{ "records": [...] }`) as a list of raw records. */
export function staticRecordList(data: unknown): unknown[] {
  if (data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as { records?: unknown }).records)) {
    return (data as { records: unknown[] }).records;
  }
  if (Array.isArray(data)) return data;
  return data === undefined || data === null ? [] : [data];
}

function capitalize(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic, message: diagnostic.message.charAt(0).toUpperCase() + diagnostic.message.slice(1) }));
}

// ---------------------------------------------------------------------------
// Invented examples

/**
 * One record of invented, obviously fake values from the field types, in
 * the static shape: names read "… de exemplo", e-mails use `example.test`,
 * phones are zeros, URLs point at `example.test`.
 */
export function exampleFromTypes(fields: Record<string, WidgetFieldSpec>, options: { locale?: string } = {}): Record<string, unknown> {
  const pt = messageLocale(options.locale ?? "pt-BR") === "pt-BR";
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const label = spec.label?.trim() || humanizeKey(key);
    switch (spec.type) {
      case "text":
        out[key] = pt ? `${label} de exemplo` : `Example ${label.toLocaleLowerCase()}`;
        break;
      case "number":
        out[key] = spec.role === "rating" ? 4 : spec.role === "progress" ? 40 : spec.role === "highlight" ? 1250 : 42;
        break;
      case "checkbox":
        out[key] = true;
        break;
      case "date":
        out[key] = "2026-01-15";
        break;
      case "select":
        out[key] = { name: pt ? "Opção A" : "Option A", color: "blue" };
        break;
      case "status":
        out[key] = { name: pt ? "Em andamento" : "In progress", color: "blue", group: "in_progress" };
        break;
      case "multi_select":
        out[key] = [
          { name: pt ? "Opção A" : "Option A", color: "blue" },
          { name: pt ? "Opção B" : "Option B", color: "green" },
        ];
        break;
      case "url":
        out[key] =
          spec.role === "image" ? "https://example.test/imagem.png" : spec.role === "avatar" ? "https://example.test/avatar.png" : "https://example.test/";
        break;
      case "email":
        out[key] = pt ? "pessoa@example.test" : "person@example.test";
        break;
      case "phone":
        out[key] = "(00) 0000-0000";
        break;
      case "person":
        out[key] = { name: pt ? "Pessoa Exemplo" : "Example Person" };
        break;
      case "ref":
        out[key] = { type: "example", id: "1" };
        break;
      default:
        break;
    }
  }
  return out;
}
