// The `set` attribute of `ravi-button`: `field=value` pairs separated by `;`,
// checked against the widget's field types. Values are literals or keywords;
// status targets a group (`@done`), never an option of one particular base.

import { WIDGET_FIELD_KEY_PATTERN } from "./manifest";
import type { Diagnostic, SetValue, WidgetActionVerb, WidgetFieldSpec } from "../types";

export type SetParseOptions = {
  /** The button's action; `@me` is valid only for `create`. */
  verb?: WidgetActionVerb;
  /** Where the attribute value starts in the file, for diagnostics. */
  at?: { line: number; column: number };
  file?: string;
};

const STATUS_GROUPS = { "@todo": "todo", "@in_progress": "in_progress", "@done": "done" } as const;
const KEYWORDS = ["@todo", "@in_progress", "@done", "@now", "@today", "@me"];
const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?$/;

export function parseSetExpression(
  text: string,
  fields: Record<string, WidgetFieldSpec>,
  options: SetParseOptions = {},
): { set: Record<string, SetValue>; diagnostics: Diagnostic[] } {
  const set: Record<string, SetValue> = {};
  const diagnostics: Diagnostic[] = [];

  const report = (code: string, message: string, offset: number) => {
    const diagnostic: Diagnostic = { severity: "error", code, message };
    if (options.file) diagnostic.file = options.file;
    if (options.at) Object.assign(diagnostic, positionIn(text, offset, options.at));
    diagnostics.push(diagnostic);
  };

  let offset = 0;
  let pairs = 0;
  for (const segment of text.split(";")) {
    const segmentStart = offset;
    offset += segment.length + 1;
    if (!segment.trim()) continue;
    pairs++;
    const leading = segment.length - segment.trimStart().length;
    const at = segmentStart + leading;
    const equals = segment.indexOf("=");
    if (equals < 0) {
      report("SET_SYNTAX", `Write field=value pairs separated by ";"; "${segment.trim()}" has no "=".`, at);
      continue;
    }
    const key = segment.slice(0, equals).trim();
    const rawValue = segment.slice(equals + 1);
    const value = rawValue.trim();
    const valueAt = segmentStart + equals + 1 + (rawValue.length - rawValue.trimStart().length);

    if (!key) {
      report("SET_SYNTAX", `Write the field key before "=" in "${segment.trim()}".`, at);
      continue;
    }
    const field = WIDGET_FIELD_KEY_PATTERN.test(key) ? fields[key] : undefined;
    if (!field) {
      const known = Object.keys(fields);
      report(
        "SET_UNKNOWN_FIELD",
        `set names "${key}", which is not a widget field${known.length ? `; fields: ${known.join(", ")}` : ""}.`,
        at,
      );
      continue;
    }
    if (Object.hasOwn(set, key)) {
      report("SET_DUPLICATE", `set gives "${key}" twice; keep one value.`, at);
      continue;
    }
    const parsed = parseValue(key, field, value, options.verb);
    if ("error" in parsed) report(parsed.code, parsed.error, valueAt);
    else set[key] = parsed.value;
  }

  if (pairs === 0) report("SET_SYNTAX", 'set is empty; write field=value pairs such as set="status=@done".', 0);
  return { set, diagnostics };
}

function parseValue(
  key: string,
  field: WidgetFieldSpec,
  value: string,
  verb: WidgetActionVerb | undefined,
): { value: SetValue } | { error: string; code: string } {
  const typeError = (expected: string) => ({
    code: "SET_TYPE",
    error: `${field.type} field "${key}" takes ${expected}; "${value}" does not fit.`,
  });

  if (value.includes("{") || value.includes("}")) {
    return { code: "SET_VALUE", error: `set values are literals or keywords, never {fields}: change "${value}".` };
  }
  if (value.startsWith("@") && !KEYWORDS.includes(value)) {
    return { code: "SET_VALUE", error: `Unknown keyword ${value}; use ${KEYWORDS.join(", ")}.` };
  }

  switch (field.type) {
    case "status":
      if (Object.hasOwn(STATUS_GROUPS, value)) return { value: { kind: "status_group", group: STATUS_GROUPS[value as keyof typeof STATUS_GROUPS] } };
      if (value.startsWith("@") || !value) return typeError("@todo, @in_progress, @done or an option name");
      return { value: { kind: "literal", value } };
    case "select":
      if (value.startsWith("@") || !value) return typeError("an option name");
      return { value: { kind: "literal", value } };
    case "text":
      if (value.startsWith("@")) return typeError("literal text");
      return { value: { kind: "literal", value } };
    case "checkbox":
      if (value === "true" || value === "false") return { value: { kind: "bool", value: value === "true" } };
      return typeError("true or false");
    case "number":
      if (NUMBER_LITERAL.test(value)) return { value: { kind: "number", value: Number(value) } };
      return typeError("a number such as 10 or 2.5");
    case "date":
      if (value === "@now") return { value: { kind: "now" } };
      if (value === "@today") return { value: { kind: "today" } };
      return typeError("@today or @now");
    case "person":
      if (value !== "@me") return typeError("@me (the viewer)");
      if (verb && verb !== "create") {
        return { code: "SET_ME", error: `@me works only with action="create"; remove "${key}=@me" from this ${verb} button.` };
      }
      return { value: { kind: "me" } };
    default:
      return { code: "SET_TYPE", error: `A button cannot set the ${field.type} field "${key}"; set takes text, number, checkbox, date, select, status and person fields.` };
  }
}

/** Line and column of `offset` in `text`, which starts at `at` in its file. */
function positionIn(text: string, offset: number, at: { line: number; column: number }) {
  let line = at.line;
  let column = at.column;
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
