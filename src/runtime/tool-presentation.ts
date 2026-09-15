import { getCliToolDefinition } from "../cli/tool-definitions.js";
import { getRuntimeBuiltinToolDefinition } from "../cli/tool-registry.js";
import { extractOptionName } from "../cli/utils.js";
import type { ChannelToolPresentation } from "../channels/runtime-events.js";

const MAX_TITLE_BYTES = 256;
const MAX_SUMMARY_BYTES = 1_024;
const MAX_PARAMETER_NAME_BYTES = 96;
const MAX_PARAMETER_LABEL_BYTES = 256;
const MAX_PARAMETER_VALUE_BYTES = 512;
const MAX_PARAMETERS = 8;

const SENSITIVE_FIELD =
  /(?:^|[._-])(?:authorization|cookie|credential|secret|token|password|passphrase|api[_-]?key|private[_-]?key|content|body|html|prompt|message|patch|env)(?:$|[._-])/i;
const LOCAL_PATH_FIELD = /(?:^|[._-])(?:path|file|filename|cwd|home|workspace|directory|dir|root)(?:$|[._-])/i;
const MACHINE_ONLY_FIELD = /^(?:json|asJson)$/i;

export function buildRuntimeToolPresentation(toolName: string, input: unknown): ChannelToolPresentation {
  const builtin = getRuntimeBuiltinToolDefinition(toolName);
  const cliTool = builtin ? undefined : getCliToolDefinition(toolName);
  const access = cliTool?.metadata.access;
  const effectiveInput = unwrapDynamicToolInput(toolName, input);
  const parameterOrder = cliTool
    ? [
        ...cliTool.metadata.args.map((argument) => argument.name),
        ...cliTool.metadata.options.map((option) => extractOptionName(option.flags)),
      ]
    : builtin
      ? Object.keys(effectiveInput)
      : [];
  const redactions = new Set(access?.redactions ?? []);
  const parameters = buildParameters({
    input: effectiveInput,
    order: parameterOrder,
    redactions,
    includeUnregisteredKeys: builtin !== undefined,
  });
  const summary = truncateUtf8(
    parameters
      .map((parameter) =>
        parameter.redacted
          ? `${parameter.label ?? parameter.name}=[redacted]`
          : `${parameter.label ?? parameter.name}=${parameter.value ?? ""}`,
      )
      .join(" · "),
    MAX_SUMMARY_BYTES,
  );
  const category = normalizeWireKind(builtin?.capability ?? access?.resource);
  const operation = builtin?.operation ?? access?.kind;
  const risk = builtin?.risk ?? access?.risk;

  return {
    title: truncateUtf8(
      sanitizeStaticText(builtin?.description ?? cliTool?.description ?? normalizeWireKind(toolName) ?? "tool") ||
        "tool",
      MAX_TITLE_BYTES,
    ),
    ...(summary ? { summary } : {}),
    ...(category ? { category } : {}),
    ...(operation ? { operation } : {}),
    ...(risk ? { risk } : {}),
    ...(parameters.length > 0 ? { parameters } : {}),
  };
}

function unwrapDynamicToolInput(toolName: string, input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  if (!record) return {};
  if (record.name === toolName && asRecord(record.args) !== undefined) {
    return asRecord(record.args) ?? {};
  }
  return record;
}

function buildParameters(input: {
  input: Record<string, unknown>;
  order: readonly string[];
  redactions: ReadonlySet<string>;
  includeUnregisteredKeys: boolean;
}): NonNullable<ChannelToolPresentation["parameters"]> {
  const keys = input.includeUnregisteredKeys
    ? [...new Set([...input.order, ...Object.keys(input.input).sort((left, right) => left.localeCompare(right))])]
    : [...new Set(input.order)];
  const parameters: NonNullable<ChannelToolPresentation["parameters"]> = [];

  for (const originalName of keys) {
    if (parameters.length >= MAX_PARAMETERS) break;
    if (MACHINE_ONLY_FIELD.test(originalName) || !(originalName in input.input)) {
      continue;
    }
    const value = input.input[originalName];
    if (value === undefined) continue;
    const name = portableParameterName(originalName);
    const canonicalFieldName = normalizeFieldName(originalName);
    const label =
      name === originalName ? undefined : truncateUtf8(sanitizeStaticText(originalName), MAX_PARAMETER_LABEL_BYTES);
    if (
      input.redactions.has(originalName) ||
      SENSITIVE_FIELD.test(canonicalFieldName) ||
      (typeof value === "string" && LOCAL_PATH_FIELD.test(canonicalFieldName))
    ) {
      parameters.push({
        name,
        ...(label ? { label } : {}),
        redacted: true,
      });
      continue;
    }
    const safeValue = safeParameterValue(value);
    if (safeValue === undefined) continue;
    parameters.push({
      name,
      ...(label ? { label } : {}),
      ...(safeValue.redacted ? { redacted: true } : { value: safeValue.value }),
    });
  }

  return parameters;
}

function safeParameterValue(value: unknown): { value: string; redacted?: false } | { redacted: true } | undefined {
  if (value === null) return { value: "null" };
  if (typeof value === "boolean" || typeof value === "number") {
    return { value: String(value) };
  }
  if (typeof value === "string") {
    const sanitized = sanitizeDynamicText(value);
    if (!sanitized) return undefined;
    if (sanitized === "[redacted]") return { redacted: true };
    return {
      value: truncateUtf8(sanitized, MAX_PARAMETER_VALUE_BYTES),
    };
  }
  if (Array.isArray(value)) {
    return { value: `${value.length} items` };
  }
  const record = asRecord(value);
  if (record) {
    return { value: `${Object.keys(record).length} fields` };
  }
  return undefined;
}

function sanitizeStaticText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeDynamicText(value: string): string {
  let next = sanitizeStaticText(value);
  next = next.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]");
  next = next.replace(/\b(?:sk|ghp|gho|github_pat|xox[aboprs])[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]");
  next = next.replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted]");
  next = next.replace(
    /\b(authorization|credential|secret|token|password|passphrase|api[_-]?key|private[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
    "$1=[redacted]",
  );
  next = next.replace(/(?:file:\/\/)?(?:\/Users|\/home|\/private|\/tmp|\/var\/folders)\/[^\s"'`]+/g, "[local path]");
  next = next.replace(/(?:^|[\s"'=])~\/[^\s"'`]+/g, (match) => `${match.slice(0, 1)}[local path]`);
  next = next.replace(/\b[A-Za-z]:\\Users\\[^\s"'`]+/g, "[local path]");
  return next.trim();
}

function portableParameterName(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z]+/, "")
    .slice(0, MAX_PARAMETER_NAME_BYTES);
  return normalized || "parameter";
}

function normalizeFieldName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function normalizeWireKind(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/[._-]+$/g, "")
    .slice(0, 96);
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(normalized) ? normalized : undefined;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let result = "";
  for (const character of value) {
    const candidate = `${result}${character}`;
    if (encoder.encode(candidate).byteLength > maximumBytes - 3) break;
    result = candidate;
  }
  return `${result}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
