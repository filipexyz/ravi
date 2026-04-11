export type InspectionSource =
  | "config-db"
  | "context-db"
  | "contact-db"
  | "session-db"
  | "adapter-db"
  | "cron-db"
  | "runtime-snapshot"
  | "live-omni"
  | "resolver"
  | "derived";

export type InspectionFreshness = "persisted" | "live" | "derived-now";

export interface InspectionMeta {
  source: InspectionSource;
  freshness: InspectionFreshness;
  via?: string;
}

interface PrintInspectionFieldOptions {
  empty?: string;
  indent?: number;
  labelWidth?: number;
}

interface PrintInspectionBlockOptions {
  indent?: number;
  labelWidth?: number;
}

function normalizeValue(value: unknown, empty: string): string {
  if (value === null || value === undefined || value === "") {
    return empty;
  }
  return String(value);
}

export function formatInspectionMeta(meta: InspectionMeta): string {
  const parts = [`source=${meta.source}`, `freshness=${meta.freshness}`];
  if (meta.via) {
    parts.push(`via=${meta.via}`);
  }
  return `[${parts.join(" ")}]`;
}

export function printInspectionField(
  label: string,
  value: unknown,
  meta: InspectionMeta,
  options: PrintInspectionFieldOptions = {},
): void {
  const indent = " ".repeat(options.indent ?? 2);
  const labelText = `${label}:`.padEnd(options.labelWidth ?? 14);
  const renderedValue = normalizeValue(value, options.empty ?? "-");
  console.log(`${indent}${labelText}${renderedValue}  ${formatInspectionMeta(meta)}`);
}

export function printInspectionBlock(
  label: string,
  meta: InspectionMeta,
  lines: string | string[],
  options: PrintInspectionBlockOptions = {},
): void {
  const indent = " ".repeat(options.indent ?? 2);
  const labelText = `${label}:`.padEnd(options.labelWidth ?? 14);
  console.log(`${indent}${labelText}${formatInspectionMeta(meta)}`);
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    console.log(`${indent}  ${line}`);
  }
}

export function formatInspectionSection(title: string, meta: InspectionMeta): string {
  return `${title} ${formatInspectionMeta(meta)}`;
}
