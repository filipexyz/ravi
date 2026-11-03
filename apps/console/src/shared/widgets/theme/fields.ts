// `fields.json`: the theme's default display per field type and role, from
// the closed lists in types.ts (first entry is the runtime default). Unknown
// keys or displays are errors; a key the file leaves out keeps the default.

import {
  FIELD_ROLE_DISPLAYS,
  FIELD_ROLES,
  FIELD_TYPE_DISPLAYS,
  type Diagnostic,
  type FieldDisplayKey,
  type FieldDisplayRules,
  type FieldRole,
} from "../types";
import { isJsonObject, parseJsonWithLines } from "./json";

export const FIELDS_FILE = "fields.json";

const FIELD_DISPLAY_KEYS = Object.keys(FIELD_TYPE_DISPLAYS) as FieldDisplayKey[];

export function defaultFieldDisplayRules(): FieldDisplayRules {
  const types: Record<string, string> = {};
  for (const key of FIELD_DISPLAY_KEYS) types[key] = FIELD_TYPE_DISPLAYS[key][0];
  const roles: Record<string, string> = {};
  for (const role of FIELD_ROLES) roles[role] = FIELD_ROLE_DISPLAYS[role][0];
  return { types, roles } as FieldDisplayRules;
}

/** Parses fields.json (absent → defaults). Invalid entries report an error and keep the default. */
export function parseFieldsJson(text: string | undefined): { rules: FieldDisplayRules; diagnostics: Diagnostic[] } {
  const rules = defaultFieldDisplayRules();
  const diagnostics: Diagnostic[] = [];
  if (text === undefined) return { rules, diagnostics };
  const report = (code: string, message: string, line?: number) =>
    diagnostics.push({ severity: "error", code, message, file: FIELDS_FILE, ...(line ? { line } : {}) });

  const parsed = parseJsonWithLines(text);
  if (!parsed.ok) {
    diagnostics.push({
      severity: "error",
      code: "FIELDS_JSON_INVALID",
      message: `fields.json is not valid JSON: ${parsed.message}.`,
      file: FIELDS_FILE,
      line: parsed.line,
      column: parsed.column,
    });
    return { rules, diagnostics };
  }
  if (!isJsonObject(parsed.value)) {
    report("FIELDS_JSON_INVALID", 'fields.json must be an object with "types" and "roles".');
    return { rules, diagnostics };
  }

  const sections: Record<"types" | "roles", Record<string, readonly string[]>> = {
    types: FIELD_TYPE_DISPLAYS,
    roles: FIELD_ROLE_DISPLAYS,
  };
  for (const [section, value] of Object.entries(parsed.value)) {
    const line = parsed.keyLine([section]);
    if (section !== "types" && section !== "roles") {
      report("FIELDS_UNKNOWN_KEY", `Unknown key "${section}" in fields.json; it takes "types" and "roles".`, line);
      continue;
    }
    if (!isJsonObject(value)) {
      report("FIELDS_JSON_INVALID", `"${section}" must be an object of key → display.`, line);
      continue;
    }
    const allowed = sections[section];
    const target = rules[section] as Record<string, string>;
    for (const [key, display] of Object.entries(value)) {
      const keyLine = parsed.keyLine([section, key]);
      const displays = Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : undefined;
      if (!displays) {
        report(
          "FIELDS_UNKNOWN_KEY",
          `Unknown ${section === "types" ? "field type" : "role"} "${key}" in fields.json; use ${Object.keys(allowed).join(", ")}.`,
          keyLine,
        );
      } else if (typeof display !== "string" || !displays.includes(display)) {
        report(
          "FIELDS_UNKNOWN_DISPLAY",
          `${section}.${key} cannot be ${JSON.stringify(display)}; use ${displays.join(", ")}.`,
          keyLine,
        );
      } else {
        target[key] = display;
      }
    }
  }
  return { rules, diagnostics };
}

/** fields.json text for `rules` (the default theme and the Console editor). */
export function fieldsJsonFromRules(rules: FieldDisplayRules): string {
  const types: Record<string, string> = {};
  for (const key of FIELD_DISPLAY_KEYS) types[key] = rules.types[key];
  const roles: Record<string, string> = {};
  for (const role of FIELD_ROLES) roles[role] = rules.roles[role as FieldRole];
  return `${JSON.stringify({ types, roles }, null, 2)}\n`;
}
