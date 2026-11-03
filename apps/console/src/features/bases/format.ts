// Pure helpers for the Bases inspector: words for types, layouts, filters,
// sorts and events, and value formatting. No React, no requests. Nothing here
// decides access: the screen only describes what the API returned.

import { BASE_SORTABLE_KINDS, isBaseSystemColumn, type BaseColumnKind } from "@/shared/bases/operators";
import { BASE_AGENT_STATE_LABELS, BASE_APPROVAL_STATE_LABELS, baseAgentState, baseApprovalState } from "@/shared/bases/values";
import type {
  BaseAgentValue,
  BaseApprovalValue,
  BaseCellValue,
  BaseDateValue,
  BaseDetail,
  BaseFilter,
  BaseFilterLeaf,
  BaseOptionColor,
  BaseProperty,
  BasePropertyConfig,
  BaseRefValue,
  BaseSelectOption,
  BaseSort,
  BaseSubscriptionEvent,
  BaseSystemColumn,
  BaseUserRef,
  BaseView,
  BaseViewColumn,
  BaseViewLayout,
  BaseViewPublic,
} from "@/shared/bases/types";
import { BASE_BODY_COLUMN } from "@/shared/bases/types";

export const LOCALE = "pt-BR";

export type AnyView = BaseView | BaseViewPublic;
export type ColumnType = BaseViewColumn["type"];

/** Managers receive the full view (filter, access); everyone else the public shape. */
export function isFullView(view: AnyView): view is BaseView {
  return "access" in view && "query" in view;
}

// ---------------------------------------------------------------------------
// Words

export const TYPE_LABELS: Record<ColumnType, string> = {
  text: "Texto",
  number: "Número",
  checkbox: "Caixa de seleção",
  date: "Data",
  select: "Seleção",
  multi_select: "Seleção múltipla",
  status: "Status",
  url: "Link",
  email: "E-mail",
  phone: "Telefone",
  person: "Pessoa",
  ref: "Referência",
  approval: "Aprovação",
  agent: "Agente",
  created_time: "Criada em",
  created_by: "Criada por",
  updated_time: "Editada em",
  updated_by: "Editada por",
  body: "Corpo",
};

const SYSTEM_COLUMN_NAMES: Record<BaseSystemColumn, string> = {
  created_time: "Criada em",
  created_by: "Criada por",
  updated_time: "Editada em",
  updated_by: "Editada por",
};

export const LAYOUT_LABELS: Record<BaseViewLayout["type"], string> = {
  table: "Tabela",
  board: "Quadro",
  list: "Lista",
  gallery: "Galeria",
  calendar: "Calendário",
  form: "Formulário",
  chart: "Gráfico",
};

export const STATUS_GROUP_LABELS = { todo: "A fazer", in_progress: "Fazendo", done: "Feito" } as const;

export const APPROVAL_STATE_LABELS = BASE_APPROVAL_STATE_LABELS;
export const AGENT_STATE_LABELS = BASE_AGENT_STATE_LABELS;

const AGENT_OUTPUT_LABELS: Record<NonNullable<BasePropertyConfig["output"]>, string> = {
  text: "texto",
  number: "número",
  checkbox: "caixa de seleção",
  select: "seleção",
  multi_select: "seleção múltipla",
  url: "link",
  date: "data",
};

/** "Número, moeda (BRL), 2 casas decimais", "Data com hora", "Agente, preenche texto". */
export function typeDetail(type: ColumnType, config: BasePropertyConfig = {}) {
  const label = TYPE_LABELS[type] ?? type;
  if (type === "date") return config.includeTime ? "Data com hora" : "Data";
  if (type === "number") {
    const parts: string[] = [];
    if (config.format === "percent") parts.push("porcentagem");
    if (config.format === "currency") parts.push(`moeda${config.currency ? ` (${config.currency.toUpperCase()})` : ""}`);
    if (typeof config.precision === "number") parts.push(`${config.precision} ${config.precision === 1 ? "casa decimal" : "casas decimais"}`);
    return parts.length ? `${label}, ${parts.join(", ")}` : label;
  }
  if (type === "agent" && config.output) {
    const by = config.agent ? `, pelo agente ${config.agent}` : "";
    return `${label}, preenche ${AGENT_OUTPUT_LABELS[config.output] ?? config.output}${by}`;
  }
  return label;
}

export function listWords(items: string[], last = "e") {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} ${last} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString(LOCALE)} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Columns

export function propertyColumn(property: BaseProperty): BaseViewColumn {
  return { config: property.config ?? {}, key: property.key, name: property.name, required: property.required, type: property.type };
}

export function systemColumn(key: BaseSystemColumn): BaseViewColumn {
  return { config: {}, key, name: SYSTEM_COLUMN_NAMES[key], required: false, type: key };
}

export function bodyColumn(): BaseViewColumn {
  return { config: {}, key: BASE_BODY_COLUMN, name: "Corpo", required: false, type: "body" };
}

/** Descriptor of one key against the base schema (managers), or null when unknown. */
export function columnForKey(base: Pick<BaseDetail, "properties">, key: string): BaseViewColumn | null {
  if (key === BASE_BODY_COLUMN) return bodyColumn();
  if (isBaseSystemColumn(key)) return systemColumn(key);
  const property = base.properties.find((candidate) => candidate.key === key && !candidate.deletedAt);
  return property ? propertyColumn(property) : null;
}

/**
 * Column descriptors of a view in display order. Public views already carry
 * descriptors; full views name keys, resolved against the base's properties.
 */
export function viewColumns(base: Pick<BaseDetail, "properties">, view: AnyView): BaseViewColumn[] {
  if (!isFullView(view)) return view.columns;
  return view.columns.map((key) => columnForKey(base, key) ?? { config: {}, key, name: key, required: false, type: "text" as const });
}

/** Name of any key a filter or sort may name: active or deleted property, system column, or body. */
export function nameForKey(base: Pick<BaseDetail, "properties">, key: string) {
  if (key === BASE_BODY_COLUMN) return "Corpo";
  if (isBaseSystemColumn(key)) return SYSTEM_COLUMN_NAMES[key];
  const property = base.properties.find((candidate) => candidate.key === key || candidate.id === key);
  return property?.name ?? key;
}

export function isSortable(column: BaseViewColumn) {
  return column.type !== "body" && BASE_SORTABLE_KINDS.has(column.type as BaseColumnKind);
}

/**
 * The view people see every row through when they manage the base: the
 * default "All rows" view (the name the server gives it) when it still has no
 * filter, else the first view without a filter, else the first view.
 */
export function defaultViewId(views: AnyView[]) {
  const readable = views.filter((view) => view.capabilities.read && !view.capabilities.aggregateOnly);
  const unfiltered = readable.filter((view) => !isFullView(view) || !view.query.filter);
  return (
    unfiltered.find((view) => view.name === "All rows")?.id ?? unfiltered[0]?.id ?? readable[0]?.id ?? null
  );
}

// ---------------------------------------------------------------------------
// Options and colors

const OPTION_HUES: Record<BaseOptionColor, string> = {
  gray: "#8a8984",
  brown: "#9b6b4a",
  orange: "#dd7426",
  yellow: "#cfa112",
  green: "#2e9d5a",
  blue: "#3a7bd5",
  purple: "#8a5bd4",
  pink: "#d5508e",
  red: "#d8453a",
};

/** Inline colors for an option chip that follow the light and dark tokens. */
export function optionStyle(color: BaseOptionColor | undefined) {
  const hue = OPTION_HUES[color ?? "gray"] ?? OPTION_HUES.gray;
  return {
    backgroundColor: `color-mix(in srgb, ${hue} 15%, var(--rv-surface))`,
    color: `color-mix(in srgb, ${hue} 62%, var(--rv-ink))`,
    dot: hue,
  };
}

export function optionById(config: BasePropertyConfig | undefined, id: unknown): BaseSelectOption | undefined {
  if (typeof id !== "string") return undefined;
  return (config?.options ?? []).find((option) => option.id === id);
}

// ---------------------------------------------------------------------------
// Values

export function isEmptyValue(value: unknown) {
  if (value === null || value === undefined || value === "") return true;
  return Array.isArray(value) && value.length === 0;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value) return [value];
  return [];
}

export function asRefArray(value: unknown): BaseRefValue[] {
  const items = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return items.filter(
    (item): item is BaseRefValue =>
      Boolean(item) && typeof item === "object" && typeof (item as BaseRefValue).type === "string" && typeof (item as BaseRefValue).id === "string",
  );
}

export function asDateValue(value: unknown): BaseDateValue | null {
  if (typeof value === "string" && value) return { end: null, start: value };
  if (value && typeof value === "object" && typeof (value as BaseDateValue).start === "string") {
    const date = value as BaseDateValue;
    return { end: typeof date.end === "string" && date.end ? date.end : null, start: date.start };
  }
  return null;
}

/** An approval cell, or null when empty or malformed. */
export function asApprovalValue(value: unknown): BaseApprovalValue | null {
  if (!baseApprovalState(value)) return null;
  const record = value as Partial<BaseApprovalValue>;
  const text = (item: unknown) => (typeof item === "string" && item ? item : null);
  return {
    decidedAt: text(record.decidedAt),
    decidedBy: text(record.decidedBy),
    note: text(record.note),
    requestedAt: text(record.requestedAt),
    requestedBy: text(record.requestedBy),
    state: record.state as BaseApprovalValue["state"],
  };
}

/** An agent cell, or null when empty or malformed. */
export function asAgentValue(value: unknown): BaseAgentValue | null {
  if (!baseAgentState(value)) return null;
  const record = value as Partial<BaseAgentValue>;
  return {
    error: typeof record.error === "string" && record.error ? record.error : null,
    inputsHash: typeof record.inputsHash === "string" ? record.inputsHash : "",
    state: record.state as BaseAgentValue["state"],
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    value: record.value ?? null,
  };
}

/** The column an agent column's value is shaped like: its output type with the agent's options. */
export function agentOutputColumn(column: Pick<BaseViewColumn, "config" | "key" | "name">): BaseViewColumn {
  const output = column.config.output ?? "text";
  const config = output === "select" || output === "multi_select" ? { options: column.config.options ?? [] } : {};
  return { config, key: column.key, name: column.name, required: false, type: output };
}

export function userName(users: Record<string, BaseUserRef>, id: string | null | undefined) {
  if (!id) return "Sistema";
  return users[id]?.displayName?.trim() || "Pessoa desconhecida";
}

export function formatNumber(value: number, config: BasePropertyConfig = {}) {
  if (!Number.isFinite(value)) return "";
  const digits =
    typeof config.precision === "number" && config.precision >= 0 && config.precision <= 8
      ? { maximumFractionDigits: config.precision, minimumFractionDigits: config.precision }
      : { maximumFractionDigits: config.format === "plain" || !config.format ? 10 : 2 };
  if (config.format === "percent") return new Intl.NumberFormat(LOCALE, { style: "percent", ...digits }).format(value);
  if (config.format === "currency") {
    const currency = (config.currency ?? "BRL").toUpperCase();
    try {
      return new Intl.NumberFormat(LOCALE, { currency, style: "currency", ...digits }).format(value);
    } catch {
      return `${currency} ${new Intl.NumberFormat(LOCALE, digits).format(value)}`;
    }
  }
  return new Intl.NumberFormat(LOCALE, digits).format(value);
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function safeTimeZone(timezone: string | null | undefined) {
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

export function formatDateOnly(date: string) {
  const match = DATE_ONLY.exec(date);
  if (!match) return date;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" }).format(utc);
}

export function formatInstant(iso: string, timezone: string, withTime = true) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat(LOCALE, {
    day: "numeric",
    month: "short",
    timeZone: safeTimeZone(timezone),
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(time);
}

function formatDatePart(value: string, includeTime: boolean, timezone: string) {
  return DATE_ONLY.test(value) ? formatDateOnly(value) : formatInstant(value, timezone, includeTime);
}

export function formatDateValue(value: BaseDateValue, includeTime: boolean, timezone: string) {
  const start = formatDatePart(value.start, includeTime, timezone);
  return value.end ? `${start} → ${formatDatePart(value.end, includeTime, timezone)}` : start;
}

/**
 * Who an approval is waiting on or who decided it, and when:
 * `{ verb: "Aprovado por", name: "Ana", at }`. Null when nobody is recorded.
 */
export function approvalActor(value: BaseApprovalValue, users: Record<string, BaseUserRef>) {
  if (value.state === "pending") {
    return value.requestedBy || value.requestedAt
      ? { at: value.requestedAt, name: value.requestedBy ? userName(users, value.requestedBy) : null, verb: "Pedido por" }
      : null;
  }
  const verb = value.state === "approved" ? "Aprovado por" : "Recusado por";
  return value.decidedBy || value.decidedAt
    ? { at: value.decidedAt, name: value.decidedBy ? userName(users, value.decidedBy) : null, verb }
    : null;
}

/** "Aprovado por Ana: “ok”", "Pendente, pedido por Bruno". */
export function approvalWords(value: BaseApprovalValue, users: Record<string, BaseUserRef>) {
  const label = APPROVAL_STATE_LABELS[value.state];
  const person = value.state === "pending" ? value.requestedBy : value.decidedBy;
  const who = person ? (value.state === "pending" ? `, pedido por ${userName(users, person)}` : ` por ${userName(users, person)}`) : "";
  return `${label}${who}${value.note ? `: “${value.note}”` : ""}`;
}

/** Plain text of a cell, for history entries, titles, filter values and the CSV export. */
export function plainValue(
  column: Pick<BaseViewColumn, "type" | "config">,
  value: BaseCellValue | undefined,
  users: Record<string, BaseUserRef>,
  timezone: string,
): string {
  if (column.type === "checkbox") return value === true ? "Sim" : "Não";
  if (isEmptyValue(value)) return "";
  switch (column.type) {
    case "number":
      return typeof value === "number" ? formatNumber(value, column.config) : String(value);
    case "date": {
      const date = asDateValue(value);
      return date ? formatDateValue(date, Boolean(column.config.includeTime), timezone) : "";
    }
    case "created_time":
    case "updated_time":
      return typeof value === "string" ? formatInstant(value, timezone) : "";
    case "select":
    case "status":
      return optionById(column.config, value)?.name ?? "Opção desconhecida";
    case "multi_select":
      return asStringArray(value)
        .map((id) => optionById(column.config, id)?.name ?? "Opção desconhecida")
        .join(", ");
    case "person":
      return asStringArray(value)
        .map((id) => userName(users, id))
        .join(", ");
    case "created_by":
    case "updated_by":
      return userName(users, typeof value === "string" ? value : null);
    case "ref":
      return asRefArray(value)
        .map((ref) => `${ref.type} ${ref.id}`)
        .join(", ");
    case "approval": {
      const approval = asApprovalValue(value);
      return approval ? approvalWords(approval, users) : "";
    }
    case "agent": {
      const agent = asAgentValue(value);
      if (!agent) return "";
      const output = agentOutputColumn({ config: column.config, key: "", name: "" });
      const empty = agent.value === null || (output.type !== "checkbox" && isEmptyValue(agent.value));
      const text = empty ? "" : plainValue(output, agent.value as BaseCellValue, users, timezone);
      if (agent.state === "error") return agent.error ? `Erro: ${agent.error}` : "Erro";
      if (agent.state === "pending") return text ? `${text} (preenchendo…)` : AGENT_STATE_LABELS.pending;
      return text;
    }
    default:
      return typeof value === "string" ? value : JSON.stringify(value);
  }
}

/** Title of a row: the first projected text column with a value. */
export function rowTitle(columns: readonly BaseViewColumn[], values: Record<string, BaseCellValue> | undefined) {
  for (const column of columns) {
    if (column.type !== "text") continue;
    const value = values?.[column.key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Linha sem título";
}

/** One line of plain text from a markdown body, for table cells. */
export function bodyExcerpt(markdown: string, max = 90) {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Filters and sorts in words

export function membersById(base: Pick<BaseDetail, "members">): Record<string, BaseUserRef> {
  return Object.fromEntries(base.members.map((member) => [member.id, member]));
}

export type DescribeContext = {
  base: Pick<BaseDetail, "properties" | "timezone">;
  members: Record<string, BaseUserRef>;
};

const VARIABLE_WORDS: Record<string, string> = {
  "$viewer.raviUserId": "a pessoa que está vendo",
  "$viewer.email": "o e-mail de quem está vendo",
  "$viewer.raviOrgId": "a organização de quem está vendo",
  "$now": "agora",
  "$today": "hoje",
};

const WITHIN_WORDS: Record<string, string> = {
  today: "hoje",
  this_week: "nesta semana",
  this_month: "neste mês",
  this_year: "neste ano",
};

const DURATION_UNITS: Record<string, [string, string]> = {
  d: ["dia", "dias"],
  w: ["semana", "semanas"],
  mo: ["mês", "meses"],
  y: ["ano", "anos"],
};

function durationWords(value: string) {
  const match = /^(\d+)(d|w|mo|y)$/.exec(value);
  if (!match) return value;
  const count = Number(match[1]);
  const unit = DURATION_UNITS[match[2] ?? "d"] ?? ["dia", "dias"];
  return `${count} ${count === 1 ? unit[0] : unit[1]}`;
}

function columnOf(ctx: DescribeContext, key: string): Pick<BaseViewColumn, "type" | "config" | "name"> {
  if (key === BASE_BODY_COLUMN) return bodyColumn();
  if (isBaseSystemColumn(key)) return systemColumn(key);
  const property = ctx.base.properties.find((candidate) => candidate.key === key || candidate.id === key);
  if (property) return { config: property.config ?? {}, name: property.name, type: property.type };
  return { config: {}, name: key, type: "text" };
}

function valueWords(column: Pick<BaseViewColumn, "type" | "config">, value: unknown, ctx: DescribeContext): string {
  if (typeof value === "string" && VARIABLE_WORDS[value]) return VARIABLE_WORDS[value] as string;
  if (Array.isArray(value)) return listWords(value.map((item) => valueWords(column, item, ctx)));
  if (value === null || value === undefined) return "vazio";
  switch (column.type) {
    case "select":
    case "status":
    case "multi_select": {
      if (typeof value !== "string") return String(value);
      const option = optionById(column.config, value);
      if (option) return `“${option.name}”`;
      if (column.type === "status" && value in STATUS_GROUP_LABELS) {
        return `qualquer status “${STATUS_GROUP_LABELS[value as keyof typeof STATUS_GROUP_LABELS]}”`;
      }
      return "uma opção desconhecida";
    }
    case "approval":
      return typeof value === "string" && value in APPROVAL_STATE_LABELS
        ? `“${APPROVAL_STATE_LABELS[value as keyof typeof APPROVAL_STATE_LABELS]}”`
        : JSON.stringify(value);
    case "agent":
      return typeof value === "string" && value in AGENT_STATE_LABELS
        ? `“${AGENT_STATE_LABELS[value as keyof typeof AGENT_STATE_LABELS]}”`
        : JSON.stringify(value);
    case "person":
    case "created_by":
    case "updated_by":
      return typeof value === "string" ? userName(ctx.members, value) : String(value);
    case "checkbox":
      return value === true ? "marcado" : "não marcado";
    case "number":
      return typeof value === "number" ? formatNumber(value, column.config) : String(value);
    case "date":
    case "created_time":
    case "updated_time":
      if (typeof value === "string") return formatDatePart(value, Boolean(column.config.includeTime), ctx.base.timezone);
      return JSON.stringify(value);
    case "ref":
      if (value && typeof value === "object" && "type" in value && "id" in value) {
        const ref = value as BaseRefValue;
        return `${ref.type} ${ref.id}`;
      }
      return JSON.stringify(value);
    default:
      return typeof value === "string" ? `“${value}”` : JSON.stringify(value);
  }
}

function leafWords(leaf: BaseFilterLeaf, ctx: DescribeContext): string {
  const column = columnOf(ctx, leaf.prop);
  const name = column.name;
  const value = leaf.value;
  const v = () => valueWords(column, value, ctx);
  const vOr = () => (Array.isArray(value) ? listWords(value.map((item) => valueWords(column, item, ctx)), "ou") : v());
  // "qualquer um de" / "todos de" only read well with more than one value.
  const single = !Array.isArray(value) || value.length === 1;
  const arrayLike = column.type === "person" || column.type === "multi_select";
  switch (leaf.op) {
    case "is_empty":
      return `${name} está vazio`;
    case "is_not_empty":
      return `${name} não está vazio`;
    case "eq":
      if (column.type === "checkbox") return `${name} ${value === true ? "está marcado" : "não está marcado"}`;
      return `${name} é ${v()}`;
    case "neq":
      return `${name} não é ${v()}`;
    case "contains":
      return arrayLike ? `${name} inclui ${v()}` : `${name} contém ${v()}`;
    case "not_contains":
      return arrayLike ? `${name} não inclui ${v()}` : `${name} não contém ${v()}`;
    case "starts_with":
      return `${name} começa com ${v()}`;
    case "lt":
      return `${name} é menor que ${v()}`;
    case "lte":
      return `${name} é no máximo ${v()}`;
    case "gt":
      return `${name} é maior que ${v()}`;
    case "gte":
      return `${name} é pelo menos ${v()}`;
    case "between": {
      const pair = Array.isArray(value) ? value : [];
      return `${name} está entre ${valueWords(column, pair[0], ctx)} e ${valueWords(column, pair[1], ctx)}`;
    }
    case "before":
      return `${name} é antes de ${v()}`;
    case "after":
      return `${name} é depois de ${v()}`;
    case "on_or_before":
      return `${name} é até ${v()}`;
    case "on_or_after":
      return `${name} é a partir de ${v()}`;
    case "within": {
      if (typeof value === "string") return `${name} cai ${WITHIN_WORDS[value] ?? value}`;
      if (value && typeof value === "object" && "past" in value) return `${name} está nos últimos ${durationWords(String((value as { past: string }).past))}`;
      if (value && typeof value === "object" && "next" in value) return `${name} está nos próximos ${durationWords(String((value as { next: string }).next))}`;
      return `${name} está dentro de ${JSON.stringify(value)}`;
    }
    case "in":
    case "state_in":
      return single ? `${name} é ${v()}` : `${name} é ${vOr()}`;
    case "nin":
      return single ? `${name} não é ${v()}` : `${name} não é nenhum de ${v()}`;
    case "contains_any":
      return single ? `${name} inclui ${v()}` : `${name} inclui ${vOr()}`;
    case "contains_all":
      return single ? `${name} inclui ${v()}` : `${name} inclui todos: ${v()}`;
    default:
      return `${name} ${String(leaf.op).replace(/_/g, " ")} ${v()}`;
  }
}

/** A view filter in plain words: "Dono inclui a pessoa que está vendo e Status é “Feito”". */
export function filterWords(filter: BaseFilter | null | undefined, ctx: DescribeContext, nested = false): string {
  if (!filter) return "Todas as linhas";
  if ("and" in filter) {
    const text = filter.and.map((child) => filterWords(child, ctx, true)).join(" e ");
    return nested && filter.and.length > 1 ? `(${text})` : text;
  }
  if ("or" in filter) {
    const text = filter.or.map((child) => filterWords(child, ctx, true)).join(" ou ");
    return nested && filter.or.length > 1 ? `(${text})` : text;
  }
  if ("not" in filter) return `não (${filterWords(filter.not, ctx, true)})`;
  return leafWords(filter, ctx);
}

export function filterUsesViewer(filter: BaseFilter | null | undefined) {
  return Boolean(filter) && JSON.stringify(filter).includes("$viewer.");
}

const SORT_WORDS: Partial<Record<ColumnType, [string, string]>> = {
  text: ["de A a Z", "de Z a A"],
  url: ["de A a Z", "de Z a A"],
  email: ["de A a Z", "de Z a A"],
  phone: ["de A a Z", "de Z a A"],
  number: ["menores primeiro", "maiores primeiro"],
  checkbox: ["desmarcadas primeiro", "marcadas primeiro"],
  date: ["mais cedo primeiro", "mais tarde primeiro"],
  created_time: ["mais antigas primeiro", "mais novas primeiro"],
  updated_time: ["editadas há mais tempo primeiro", "editadas por último primeiro"],
  select: ["na ordem das opções", "na ordem inversa das opções"],
  status: ["na ordem das opções", "na ordem inversa das opções"],
};

export function sortDirectionWords(type: ColumnType, dir: BaseSort["dir"]) {
  const words = SORT_WORDS[type] ?? ["crescente", "decrescente"];
  return dir === "desc" ? words[1] : words[0];
}

export function sortWords(sort: BaseSort[], ctx: DescribeContext) {
  if (!sort.length) return "Na ordem em que as linhas foram adicionadas, as mais antigas primeiro";
  return sort
    .map((entry) => {
      const column = columnOf(ctx, entry.prop);
      return `${column.name}, ${sortDirectionWords(column.type, entry.dir)}`;
    })
    .join("; depois ");
}

export function layoutWords(layout: BaseViewLayout, ctx: DescribeContext) {
  const label = LAYOUT_LABELS[layout.type] ?? layout.type;
  if (layout.type === "board") return `${label} agrupado por ${columnOf(ctx, layout.groupBy).name}`;
  if (layout.type === "calendar") return `${label} por ${columnOf(ctx, layout.dateProp).name}`;
  return label;
}

// ---------------------------------------------------------------------------
// Activity

export type EventEntity = "base" | "property" | "view" | "chart" | "subscription" | "row";

const EVENT_WORDS: Record<string, { entity: EventEntity; verb: string }> = {
  "bases.base.created": { entity: "base", verb: "Base criada" },
  "bases.base.updated": { entity: "base", verb: "Detalhes da base alterados" },
  "bases.base.archived": { entity: "base", verb: "Base arquivada" },
  "bases.base.restored": { entity: "base", verb: "Base restaurada" },
  "bases.property.created": { entity: "property", verb: "Propriedade adicionada" },
  "bases.property.updated": { entity: "property", verb: "Propriedade alterada" },
  "bases.property.migrated": { entity: "property", verb: "Tipo da propriedade alterado" },
  "bases.property.deleted": { entity: "property", verb: "Propriedade excluída" },
  "bases.property.restored": { entity: "property", verb: "Propriedade restaurada" },
  "bases.view.created": { entity: "view", verb: "View criada" },
  "bases.view.updated": { entity: "view", verb: "View alterada" },
  "bases.view.archived": { entity: "view", verb: "View arquivada" },
  "bases.view.viewed_as": { entity: "view", verb: "View vista como outra pessoa" },
  "bases.chart.created": { entity: "chart", verb: "Gráfico criado" },
  "bases.chart.updated": { entity: "chart", verb: "Gráfico alterado" },
  "bases.chart.archived": { entity: "chart", verb: "Gráfico arquivado" },
  "bases.subscription.created": { entity: "subscription", verb: "Avisos de linhas ligados para uma instalação" },
  "bases.subscription.revoked": { entity: "subscription", verb: "Avisos de linhas desligados para uma instalação" },
  "bases.row.purged": { entity: "row", verb: "Linha excluída de vez" },
  "bases.rows.bulk_changed": { entity: "row", verb: "Linhas alteradas em lote" },
};

export function eventWords(type: string): { entity: EventEntity; verb: string } {
  const known = EVENT_WORDS[type];
  if (known) return known;
  const words = type.replace(/^bases\./, "").replace(/[._]+/g, " ").trim();
  return { entity: "base", verb: words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Alteração" };
}

const SUBSCRIPTION_EVENT_WORDS: Record<BaseSubscriptionEvent, string> = {
  "row.created": "linha criada",
  "row.updated": "linha alterada",
  "row.archived": "linha arquivada",
  "row.restored": "linha restaurada",
  "approval.requested": "aprovação pedida",
  "approval.decided": "aprovação decidida",
  "agent.requested": "agente acionado",
  "agent.backfill": "agente em linhas antigas",
};

export function subscriptionEventWords(events: readonly string[]) {
  return listWords(events.map((event) => SUBSCRIPTION_EVENT_WORDS[event as BaseSubscriptionEvent] ?? event));
}
