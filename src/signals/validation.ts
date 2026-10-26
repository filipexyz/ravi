import {
  SIGNAL_KINDS,
  SIGNAL_PRODUCER_CLASSES,
  SIGNAL_SCOPE_TYPES,
  SIGNAL_SEVERITIES,
  type ClearWhen,
  type SignalKind,
  type SignalProducerClass,
  type SignalScopeType,
  type SignalSeverity,
} from "./types.js";

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i;

export function parseDurationMs(value: string, label = "duration"): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid ${label}: ${value}. Use values like 30s, 5m, 6h, 7d.`);
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const factor =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : unit === "d"
              ? 86_400_000
              : 604_800_000;
  return Math.round(amount * factor);
}

export function normalizeKind(value: string): SignalKind {
  if ((SIGNAL_KINDS as readonly string[]).includes(value)) {
    return value as SignalKind;
  }
  throw new Error(`Invalid --kind: ${value}. Use fact|judgment.`);
}

export function normalizeProducerClass(
  value: string | undefined,
  kind: SignalKind,
  producerId: string,
): SignalProducerClass {
  const explicit = value?.trim().toLowerCase();
  if (explicit) {
    if (!(SIGNAL_PRODUCER_CLASSES as readonly string[]).includes(explicit)) {
      throw new Error(`Invalid producer class: ${value}. Use ${SIGNAL_PRODUCER_CLASSES.join("|")}.`);
    }
    return explicit as SignalProducerClass;
  }
  if (kind === "fact") {
    return "code";
  }
  const source = producerId.toLowerCase();
  if (source.includes("task-observer") || source.includes("observer:task")) {
    return "task-observer";
  }
  if (source.startsWith("observer:") || source.startsWith("observation:")) {
    return "observer";
  }
  if (source.startsWith("operator") || source.includes("operator-assistant")) {
    return "operator-assistant";
  }
  return "agent";
}

export function normalizeSeverity(value: string | undefined): SignalSeverity {
  const normalized = (value?.trim().toLowerCase() || "piggyback") as string;
  if (normalized === "p0") return "page";
  if ((SIGNAL_SEVERITIES as readonly string[]).includes(normalized)) {
    return normalized as SignalSeverity;
  }
  throw new Error(`Invalid --severity: ${value}. Use ${SIGNAL_SEVERITIES.join("|")}.`);
}

const SEVERITY_RANK: Record<SignalSeverity, number> = {
  ambient: 0,
  piggyback: 1,
  nudge: 2,
  interrupt: 3,
  page: 4,
};

export function severityRank(value: SignalSeverity): number {
  return SEVERITY_RANK[value];
}

export function minSeverity(left: SignalSeverity, right: SignalSeverity): SignalSeverity {
  return SEVERITY_RANK[left] <= SEVERITY_RANK[right] ? left : right;
}

export function producerClassCeiling(producerClass: SignalProducerClass): SignalSeverity {
  switch (producerClass) {
    case "code":
      return "page";
    case "task-observer":
    case "observer":
      return "nudge";
    case "agent":
    case "operator-assistant":
      return "piggyback";
  }
}

export function kindCeiling(kind: SignalKind): SignalSeverity {
  return kind === "fact" ? "page" : "piggyback";
}

export function effectiveSeverity(
  stored: SignalSeverity,
  kind: SignalKind,
  producerClass: SignalProducerClass,
): SignalSeverity {
  return minSeverity(minSeverity(stored, kindCeiling(kind)), producerClassCeiling(producerClass));
}

export function normalizeScope(value: string): { scopeType: SignalScopeType; scopeId: string } {
  const trimmed = value.trim();
  if (trimmed === "fleet") {
    return { scopeType: "fleet", scopeId: "fleet" };
  }
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(`Invalid --scope: ${value}. Use fleet or <person|chat|project|agent>:<id>.`);
  }
  const type = trimmed.slice(0, separator);
  const id = trimmed.slice(separator + 1);
  if (!(SIGNAL_SCOPE_TYPES as readonly string[]).includes(type) || type === "fleet") {
    throw new Error(`Invalid --scope type: ${type}. Use person|chat|project|agent|fleet.`);
  }
  return { scopeType: type as SignalScopeType, scopeId: id };
}

export function sanitizeSignalText(value: string, maxLength: number): string {
  return (
    value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\[system\]/gi, "[system-marker]")
      // Signal text sits inside a <ravi-signals> block: it must not close or
      // open one, nor pass for another speaker.
      .replace(/<\s*(\/?)\s*ravi-signals/gi, "&lt;$1ravi-signals")
      .replace(/^\s*(system|assistant|user|human|developer)\s*:/i, "")
      .replace(/```+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength)
  );
}

export function assertSignalTitle(value: string): string {
  const title = sanitizeSignalText(value, 120);
  if (!title) {
    throw new Error("--title is required.");
  }
  return title;
}

const OP_ALIASES: Record<string, "gt" | "gte" | "lt" | "lte" | "eq" | "neq"> = {
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte",
  "==": "eq",
  "=": "eq",
  "!=": "neq",
};

type Clause = { field: string; op: "gt" | "gte" | "lt" | "lte" | "eq" | "neq"; value: number };

function parseClause(text: string): Clause {
  const match = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(>=|<=|==|!=|>|=|<)\s*(-?\d+(?:\.\d+)?)$/.exec(text.trim());
  if (!match) {
    throw new Error(`Invalid clear expression clause: ${text}. Use field >= number.`);
  }
  return { field: match[1], op: OP_ALIASES[match[2]], value: Number(match[3]) };
}

export function parseClearExpression(expr: string): { clauses: Clause[]; joins: Array<"and" | "or"> } {
  const tokens = expr.trim().split(/\s+(and|or)\s+/i);
  if (tokens.length === 0 || tokens.length % 2 === 0) {
    throw new Error(`Invalid clear expression: ${expr}.`);
  }
  const clauses: Clause[] = [];
  const joins: Array<"and" | "or"> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (index % 2 === 0) {
      clauses.push(parseClause(tokens[index]));
    } else {
      joins.push(tokens[index].toLowerCase() as "and" | "or");
    }
  }
  if (clauses.length > 3) {
    throw new Error("A clear expression supports at most three clauses.");
  }
  return { clauses, joins };
}

export function evaluateClearExpression(expr: string, fields: Record<string, unknown>): boolean {
  const parsed = parseClearExpression(expr);
  let result = compareClause(parsed.clauses[0], fields);
  for (let index = 0; index < parsed.joins.length; index += 1) {
    const next = compareClause(parsed.clauses[index + 1], fields);
    result = parsed.joins[index] === "and" ? result && next : result || next;
  }
  return result;
}

function compareClause(clause: Clause, fields: Record<string, unknown>): boolean {
  const raw = fields[clause.field];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return false;
  }
  switch (clause.op) {
    case "gt":
      return value > clause.value;
    case "gte":
      return value >= clause.value;
    case "lt":
      return value < clause.value;
    case "lte":
      return value <= clause.value;
    case "eq":
      return value === clause.value;
    case "neq":
      return value !== clause.value;
  }
}

export function validateClearWhen(clearWhen: ClearWhen, kind: SignalKind): ClearWhen {
  if (kind === "judgment" && clearWhen.type !== "decay" && clearWhen.type !== "manual") {
    throw new Error("A judgment clear rule must be decay or manual.");
  }
  if (kind === "fact" && (clearWhen.type === "decay" || clearWhen.type === "manual")) {
    throw new Error("A fact clear rule must be probe, metric, or producer_resolve.");
  }
  switch (clearWhen.type) {
    case "probe": {
      if (!clearWhen.probe.trim()) throw new Error("Probe id is required.");
      parseClearExpression(clearWhen.expr);
      if (clearWhen.recheck_ms < 1000) throw new Error("Probe recheck must be at least 1s.");
      if (clearWhen.grace_ms < 0) throw new Error("Probe grace must be >= 0.");
      return clearWhen;
    }
    case "metric": {
      if (!clearWhen.field.trim()) throw new Error("Metric field is required.");
      if (!Number.isFinite(clearWhen.value)) throw new Error("Metric value must be a number.");
      return clearWhen;
    }
    case "producer_resolve": {
      if (clearWhen.ttl_ms <= 0) throw new Error("producer_resolve requires a positive ttl.");
      return clearWhen;
    }
    case "decay": {
      if (clearWhen.after_ms <= 0) throw new Error("decay requires a positive duration.");
      return clearWhen;
    }
    case "manual":
      return clearWhen;
  }
}

export function parseMetricSpec(value: string): { field: string; op: Clause["op"]; value: number } {
  const match = /^([a-zA-Z_][a-zA-Z0-9_.]*)\s*(>=|<=|==|!=|>|=|<)\s*(-?\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid --clear-metric: ${value}. Use field>=number.`);
  }
  return { field: match[1], op: OP_ALIASES[match[2]], value: Number(match[3]) };
}

export function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}
