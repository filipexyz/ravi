// `widget.json`: the widget's name, description, typed fields and variants.
// Strict: unknown keys are errors, so a typo never silently drops a field
// setting. The parsed manifest is normalized (every field has `required` and
// `label`), which is the shape compiled widgets and the catalog carry.

import { isJsonObject, parseJsonWithLines, type JsonPath } from "../theme/json";
import {
  FIELD_ROLE_TYPES,
  FIELD_ROLES,
  WIDGET_FIELD_TYPES,
  WIDGET_VARIANTS,
  type Diagnostic,
  type FieldRole,
  type WidgetFieldSpec,
  type WidgetFieldType,
  type WidgetManifest,
  type WidgetVariant,
} from "../types";

export const WIDGET_MANIFEST_FILE = "widget.json";
export const WIDGET_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
export const MAX_WIDGET_FIELDS = 40;
export const MAX_WIDGET_NAME_LENGTH = 120;
export const MAX_WIDGET_DESCRIPTION_LENGTH = 1024;
export const MAX_FIELD_LABEL_LENGTH = 80;
export const MAX_FIELD_DESCRIPTION_LENGTH = 200;

/** `item` is the `{#each}` variable in every template, so it cannot name a field. */
export const RESERVED_FIELD_KEYS = ["item"];

const MANIFEST_KEYS = ["name", "description", "fields", "variants"];
/** Reserved for actions widget.js may run one day (JS-CONTRACT J6); refused until then. */
export const RESERVED_SCRIPT_ACTIONS_KEY = "scriptActions";
const FIELD_KEYS = ["type", "role", "required", "label", "description"];
// Single-line text: no control characters at all.
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;
// Multi-line text: line breaks and tabs are fine.
const MULTI_LINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Line and column of the key at `path` (its deepest key, for array entries),
 * or line 1 for the document itself.
 */
export function jsonKeyPosition(
  text: string,
  keyLine: (path: JsonPath) => number | undefined,
  path: JsonPath,
): { line: number; column?: number } {
  for (let end = path.length; end > 0; end--) {
    const prefix = path.slice(0, end);
    const line = keyLine(prefix);
    const key = prefix[prefix.length - 1];
    if (line === undefined || typeof key !== "string") continue;
    const index = (text.split("\n")[line - 1] ?? "").indexOf(JSON.stringify(key));
    return index < 0 ? { line } : { line, column: index + 1 };
  }
  return { line: 1 };
}

/** `responsavel_tecnico` → `Responsavel tecnico`, the label when `widget.json` gives none. */
export function humanizeFieldKey(key: string) {
  const text = key.replace(/_+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function parseWidgetManifest(text: string | undefined): { manifest: WidgetManifest | null; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (text === undefined) {
    diagnostics.push({
      severity: "error",
      code: "WIDGET_FILE_MISSING",
      message: "Add widget.json with the widget's name, description and fields.",
      file: WIDGET_MANIFEST_FILE,
    });
    return { manifest: null, diagnostics };
  }

  const parsed = parseJsonWithLines(text);
  if (!parsed.ok) {
    diagnostics.push({
      severity: "error",
      code: "MANIFEST_JSON",
      message: `widget.json is not valid JSON: ${parsed.message}.`,
      file: WIDGET_MANIFEST_FILE,
      line: parsed.line,
      column: parsed.column,
    });
    return { manifest: null, diagnostics };
  }

  const error = (code: string, message: string, path: JsonPath) => {
    diagnostics.push({ severity: "error", code, message, file: WIDGET_MANIFEST_FILE, ...jsonKeyPosition(text, parsed.keyLine, path) });
  };

  const root = parsed.value;
  if (!isJsonObject(root)) {
    error("MANIFEST_SHAPE", 'widget.json must be an object: { "name", "description", "fields", "variants" }.', []);
    return { manifest: null, diagnostics };
  }

  for (const key of Object.keys(root)) {
    if (key === RESERVED_SCRIPT_ACTIONS_KEY) {
      error(
        "WIDGET_JS_ACTIONS_UNSUPPORTED",
        `Remove "${key}" from widget.json: widget.js is read-only for now; buttons that change records stay <ravi-button action=…> in widget.html.`,
        [key],
      );
      continue;
    }
    if (!MANIFEST_KEYS.includes(key)) {
      error("MANIFEST_UNKNOWN_KEY", `Remove "${key}" from widget.json; the keys are name, description, fields and variants.`, [key]);
    }
  }

  const name = readText(root.name, { max: MAX_WIDGET_NAME_LENGTH, multiLine: false });
  if (name.error) error("MANIFEST_NAME", `name ${name.error}.`, root.name === undefined ? [] : ["name"]);

  const description = readText(root.description, { max: MAX_WIDGET_DESCRIPTION_LENGTH, multiLine: true });
  if (description.error) {
    error(
      "MANIFEST_DESCRIPTION",
      `description ${description.error}; agents find the widget by it.`,
      root.description === undefined ? [] : ["description"],
    );
  }

  const fields: Record<string, WidgetFieldSpec> = {};
  if (!isJsonObject(root.fields)) {
    error(
      "MANIFEST_FIELDS",
      'fields must be an object of field key → { "type": ... }, e.g. { "titulo": { "type": "text", "required": true } }.',
      root.fields === undefined ? [] : ["fields"],
    );
  } else {
    const keys = Object.keys(root.fields);
    if (keys.length > MAX_WIDGET_FIELDS) {
      error("MANIFEST_TOO_MANY_FIELDS", `A widget takes at most ${MAX_WIDGET_FIELDS} fields; this one has ${keys.length}.`, ["fields"]);
    }
    for (const key of keys) {
      const field = readField(key, root.fields[key], (code, message, path) => error(code, message, ["fields", key, ...path]));
      if (field) fields[key] = field;
    }
  }

  const variants = readVariants(root.variants, (message) =>
    error("MANIFEST_VARIANTS", message, root.variants === undefined ? [] : ["variants"]),
  );

  if (diagnostics.length > 0) return { manifest: null, diagnostics };
  return {
    manifest: { name: name.value ?? "", description: description.value ?? "", fields, variants: variants ?? ["default"] },
    diagnostics,
  };
}

function readField(
  key: string,
  value: unknown,
  error: (code: string, message: string, path: JsonPath) => void,
): WidgetFieldSpec | null {
  let ok = true;
  const fail = (code: string, message: string, path: JsonPath = []) => {
    ok = false;
    error(code, message, path);
  };

  if (!WIDGET_FIELD_KEY_PATTERN.test(key)) {
    fail(
      "MANIFEST_FIELD_KEY",
      `Field key "${key}" must start with a lowercase letter and use only a-z, 0-9 and _ (at most 63 characters).`,
    );
  } else if (RESERVED_FIELD_KEYS.includes(key)) {
    fail("MANIFEST_FIELD_KEY", `Field key "${key}" is reserved for {#each … as item}; rename the field.`);
  }
  if (!isJsonObject(value)) {
    fail("MANIFEST_FIELD_SHAPE", `Field "${key}" must be an object such as { "type": "text" }.`);
    return null;
  }
  for (const property of Object.keys(value)) {
    if (!FIELD_KEYS.includes(property)) {
      fail(
        "MANIFEST_UNKNOWN_KEY",
        `Remove "${property}" from field "${key}"; a field takes type, role, required, label and description.`,
        [property],
      );
    }
  }

  const type = value.type;
  const validType = typeof type === "string" && (WIDGET_FIELD_TYPES as readonly string[]).includes(type);
  if (!validType) {
    fail(
      "MANIFEST_FIELD_TYPE",
      `Field "${key}" needs a type from: ${WIDGET_FIELD_TYPES.join(", ")}.`,
      type === undefined ? [] : ["type"],
    );
  }

  let role: FieldRole | undefined;
  if (value.role !== undefined) {
    if (typeof value.role !== "string" || !(FIELD_ROLES as readonly string[]).includes(value.role)) {
      fail("MANIFEST_FIELD_ROLE", `Field "${key}" role must be one of: ${FIELD_ROLES.join(", ")}.`, ["role"]);
    } else {
      role = value.role as FieldRole;
      const accepted = FIELD_ROLE_TYPES[role];
      if (validType && !accepted.includes(type as WidgetFieldType)) {
        fail(
          "MANIFEST_FIELD_ROLE",
          `Role "${role}" takes a ${accepted.join(" or ")} field; field "${key}" is ${type as string}.`,
          ["role"],
        );
      }
    }
  }

  if (value.required !== undefined && typeof value.required !== "boolean") {
    fail("MANIFEST_FIELD_REQUIRED", `Field "${key}" required must be true or false.`, ["required"]);
  }

  const label: TextResult =
    value.label === undefined ? { value: humanizeFieldKey(key) } : readText(value.label, { max: MAX_FIELD_LABEL_LENGTH, multiLine: false });
  if (label.error) fail("MANIFEST_FIELD_LABEL", `Field "${key}" label ${label.error}.`, ["label"]);

  const description: TextResult =
    value.description === undefined ? {} : readText(value.description, { max: MAX_FIELD_DESCRIPTION_LENGTH, multiLine: true });
  if (description.error) fail("MANIFEST_FIELD_DESCRIPTION", `Field "${key}" description ${description.error}.`, ["description"]);

  if (!ok) return null;
  const field: WidgetFieldSpec = { type: type as WidgetFieldType };
  if (role) field.role = role;
  field.required = value.required === true;
  field.label = label.value;
  if (description.value !== undefined) field.description = description.value;
  return field;
}

function readVariants(value: unknown, error: (message: string) => void): WidgetVariant[] | null {
  if (value === undefined) return ["default"];
  const allowed = WIDGET_VARIANTS.join(", ");
  if (!Array.isArray(value) || value.length === 0) {
    error(`variants must be a list from ${allowed} that includes "default", e.g. ["default", "compact"].`);
    return null;
  }
  const out: WidgetVariant[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !(WIDGET_VARIANTS as readonly string[]).includes(entry)) {
      error(`variants takes only ${allowed}; remove ${JSON.stringify(entry)}.`);
      return null;
    }
    if (out.includes(entry as WidgetVariant)) {
      error(`variants lists "${entry}" twice.`);
      return null;
    }
    out.push(entry as WidgetVariant);
  }
  if (!out.includes("default")) {
    error('variants must include "default": every other variant falls back to it.');
    return null;
  }
  return out;
}

type TextResult = { value?: string; error?: string };

function readText(value: unknown, options: { max: number; multiLine: boolean }): TextResult {
  if (value === undefined) return { error: "is required" };
  if (typeof value !== "string") return { error: "must be a string" };
  const text = value.trim();
  if (!text) return { error: "must not be empty" };
  if (text.length > options.max) return { error: `must be at most ${options.max} characters (has ${text.length})` };
  if ((options.multiLine ? MULTI_LINE_CONTROL : SINGLE_LINE_CONTROL).test(text)) {
    return { error: options.multiLine ? "must not contain control characters" : "must be one line without control characters" };
  }
  return { value: text };
}
