// A widget's Library files → `CompiledWidget`: the template tree the renderer
// walks, the actions its buttons run, and a hash over what renders. Publish,
// proposals, `widgets/check` and the page kit all compile through here; any
// error diagnostic means no widget.

import { sha256Hex } from "../hash";
import { lintTemplateAccessibility } from "./a11y";
import {
  displaysForField,
  FILTERS,
  isEachFieldType,
  ITEM_PROPERTIES,
  ITEM_TYPES,
  PIECES,
  type EachFieldType,
} from "./catalog";
import { jsonKeyPosition, parseWidgetManifest } from "./manifest";
import {
  attrOf,
  literalAttr,
  parseWidgetTemplate,
  sortDiagnostics,
  WIDGET_TEMPLATE_FILE,
  type AstElement,
  type AstNode,
  type ParsedTemplate,
  type SourcePosition,
} from "./parse";
import { parseSetExpression } from "./set";
import { checkWidgetScript, WIDGET_SCRIPT_FILE } from "../script/check";
import { isJsonObject, parseJsonWithLines, type JsonPath } from "../theme/json";
import {
  hasErrors,
  type CompiledWidget,
  type Diagnostic,
  type LibraryFileText,
  type LibraryItemRef,
  type SetValue,
  type WidgetScriptRef,
  type TemplateAttrValue,
  type TemplateNode,
  type WidgetAction,
  type WidgetActionVerb,
  type WidgetFieldSpec,
  type WidgetFieldType,
  type WidgetManifest,
} from "../types";

export const WIDGET_EXAMPLE_FILE = "example.json";
export const MAX_EXAMPLE_RECORDS = 20;

export type CompileWidgetResult = {
  widget: CompiledWidget | null;
  manifest: WidgetManifest | null;
  /** Records from `example.json` (one object becomes a list of one); empty when absent or invalid. */
  example: unknown[];
  diagnostics: Diagnostic[];
};

export function compileWidget(
  files: readonly LibraryFileText[],
  options: { ref?: LibraryItemRef | null } = {},
): CompileWidgetResult {
  const read = (path: string) => files.find((file) => file.path === path)?.content;

  const { manifest, diagnostics: manifestDiagnostics } = parseWidgetManifest(read("widget.json"));

  const templateDiagnostics: Diagnostic[] = [];
  const source = read(WIDGET_TEMPLATE_FILE);
  let parsed: ParsedTemplate | null = null;
  if (source === undefined) {
    templateDiagnostics.push({
      severity: "error",
      code: "WIDGET_FILE_MISSING",
      message: "Add widget.html with the template: ravi-* pieces such as <ravi-card> and <ravi-field>.",
      file: WIDGET_TEMPLATE_FILE,
    });
  } else {
    parsed = parseWidgetTemplate(source);
    templateDiagnostics.push(...parsed.diagnostics);
  }

  const scriptSource = read(WIDGET_SCRIPT_FILE);
  let script: WidgetScriptRef | null = null;
  const scriptDiagnostics: Diagnostic[] = [];
  if (scriptSource !== undefined) {
    const result = checkWidgetScript(scriptSource);
    scriptDiagnostics.push(...result.diagnostics);
    script = { sha256: sha256Hex(scriptSource), bytes: result.bytes };
  }

  let checked: TemplateCheck | null = null;
  if (parsed && manifest) {
    checked = checkTemplate(parsed, manifest, script !== null);
    templateDiagnostics.push(...checked.diagnostics);
  }
  if (parsed) {
    for (const variant of parsed.variants) {
      templateDiagnostics.push(...lintTemplateAccessibility(variant.nodes, { variant: variant.name, fields: manifest?.fields ?? null }));
    }
  }

  const example = readExample(read(WIDGET_EXAMPLE_FILE), manifest);

  const diagnostics = [...manifestDiagnostics, ...sortDiagnostics(templateDiagnostics), ...example.diagnostics, ...scriptDiagnostics];
  if (!manifest || !parsed || !checked || hasErrors(diagnostics)) {
    return { widget: null, manifest, example: hasErrors(example.diagnostics) ? [] : example.records, diagnostics };
  }

  const { actions, buttons } = checked;
  const blocks = new Map(parsed.variants.map((variant) => [variant.name, variant.nodes] as const));
  const convert = (nodes: readonly AstNode[]) => toTemplateNodes(nodes, buttons);
  const defaultNodes = convert(blocks.get("default") ?? []);
  const variants: CompiledWidget["variants"] = { default: defaultNodes };
  for (const name of manifest.variants) {
    if (name === "default") continue;
    const nodes = blocks.get(name);
    variants[name] = nodes ? convert(nodes) : defaultNodes;
  }

  const widget: CompiledWidget = {
    v: 1,
    ref: options.ref ?? null,
    name: manifest.name,
    description: manifest.description,
    fields: manifest.fields,
    variants,
    actions,
    script,
    hash: compiledWidgetHash({ fields: manifest.fields, variants, actions, script }),
  };
  return { widget, manifest, example: example.records, diagnostics };
}

/**
 * sha256 of the canonical JSON (sorted keys, no whitespace) of fields,
 * variants and actions. Template line numbers are left out, so reformatting
 * the file without changing what renders keeps the hash. A widget with
 * `widget.js` adds the script's sha256, so the hash of one without code is
 * what it was before widgets had code.
 */
export function compiledWidgetHash(input: Pick<CompiledWidget, "fields" | "variants" | "actions" | "script">): string {
  const variants: Record<string, unknown> = {};
  for (const [name, nodes] of Object.entries(input.variants)) variants[name] = nodes ? withoutLines(nodes) : nodes;
  return sha256Hex(canonicalJson({ fields: input.fields, variants, actions: input.actions, script: input.script?.sha256 }));
}

/** JSON with object keys sorted at every level and `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  const members = Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`);
  return `{${members.join(",")}}`;
}

function withoutLines(nodes: readonly TemplateNode[]): unknown[] {
  return nodes.map((node) => {
    switch (node.k) {
      case "el":
        return { k: node.k, piece: node.piece, attrs: node.attrs, children: withoutLines(node.children) };
      case "if":
        return { ...node, then: withoutLines(node.then), else: withoutLines(node.else) };
      case "each":
        return { ...node, children: withoutLines(node.children) };
      default:
        return node;
    }
  });
}

// ---------------------------------------------------------------------------
// Field checks, variants and actions

type TemplateCheck = {
  diagnostics: Diagnostic[];
  actions: WidgetAction[];
  /** Button node → index into `actions`. */
  buttons: Map<AstElement, number>;
};

/** `{#each}` variables in scope → iterated field type (null when that field is invalid). */
type Scope = ReadonlyMap<string, EachFieldType | null>;

function checkTemplate(parsed: ParsedTemplate, manifest: WidgetManifest, hasScript: boolean): TemplateCheck {
  const { fields } = manifest;
  const diagnostics: Diagnostic[] = [];
  const sets = new Map<AstElement, Record<string, SetValue>>();
  const report = (severity: Diagnostic["severity"], code: string, message: string, pos: SourcePosition | null) => {
    diagnostics.push({ severity, code, message, file: WIDGET_TEMPLATE_FILE, line: pos?.line ?? 1, column: pos?.column ?? 1 });
  };

  const field = (key: string, pos: SourcePosition): WidgetFieldSpec | null => {
    const spec = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (spec) return spec;
    report("error", "TEMPLATE_UNKNOWN_FIELD", unknownFieldMessage(key, Object.keys(fields)), pos);
    return null;
  };

  /** Type of a path for attribute and filter checks: items count as their item type, item properties as text. */
  const resolve = (path: readonly string[], pos: SourcePosition, scope: Scope): WidgetFieldType | null => {
    const [head = "", property] = path;
    if (scope.has(head)) {
      const iterated = scope.get(head);
      if (!iterated) return null;
      if (property === undefined) return ITEM_TYPES[iterated];
      if (!ITEM_PROPERTIES[iterated].includes(property)) {
        report(
          "error",
          "TEMPLATE_ITEM_PATH",
          `${head} of a ${iterated} field has ${ITEM_PROPERTIES[iterated].map((name) => `${head}.${name}`).join(", ")}; ${path.join(".")} is not one of them.`,
          pos,
        );
        return null;
      }
      return "text";
    }
    // Item paths outside {#each} and dotted field paths were reported by the parser.
    if (path.length !== 1 || head === "item") return null;
    return field(head, pos)?.type ?? null;
  };

  const visit = (nodes: readonly AstNode[], scope: Scope) => {
    for (const node of nodes) {
      switch (node.k) {
        case "text":
          break;
        case "expr": {
          const type = resolve(node.path, node.pathPos, scope);
          if (!type) break;
          for (const filter of node.filters) {
            const accepts = FILTERS[filter].accepts;
            if (!accepts.includes(type)) {
              report(
                "error",
                "TEMPLATE_FILTER_TYPE",
                `The ${filter} filter takes a ${accepts.join(" or ")} value; ${node.path.join(".")} is ${type}.`,
                node.pathPos,
              );
            }
          }
          break;
        }
        case "if":
          resolve(node.path, node.pathPos, scope);
          visit(node.then, scope);
          visit(node.else, scope);
          break;
        case "each": {
          const inner = new Map(scope);
          let iterated: EachFieldType | null = null;
          const [head = ""] = node.path;
          if (node.path.length === 1 && !scope.has(head) && head !== "item") {
            const spec = field(head, node.pathPos);
            if (spec && isEachFieldType(spec.type)) iterated = spec.type;
            else if (spec) {
              report(
                "error",
                "TEMPLATE_EACH_TYPE",
                `{#each} iterates multi_select, person or ref fields; ${head} is ${spec.type}.`,
                node.pathPos,
              );
            }
          }
          if (Object.hasOwn(fields, node.as)) {
            report("error", "TEMPLATE_EACH_ALIAS", `"as ${node.as}" hides the field ${node.as}; use another name such as item.`, node.pos);
          }
          inner.set(node.as, iterated);
          visit(node.children, inner);
          break;
        }
        case "el":
          checkElement(node, scope);
          visit(node.children, scope);
          break;
      }
    }
  };

  const checkElement = (node: AstElement, scope: Scope) => {
    const piece = PIECES[node.piece];
    if (!piece) return;
    if (node.piece === "ravi-canvas" && !hasScript) {
      report(
        "error",
        "WIDGET_CANVAS_WITHOUT_SCRIPT",
        "<ravi-canvas> is the region widget.js draws in; add widget.js with an exported mount, or remove the canvas.",
        node.pos,
      );
    }
    for (const attr of node.attrs) {
      const spec = piece.attrs[attr.name];
      if (!spec) continue;
      if ("ref" in attr.value) {
        const type = resolve(attr.value.ref, attr.valuePos, scope);
        if (type && spec.fields && !spec.fields.includes(type)) {
          report(
            "error",
            "TEMPLATE_ATTRIBUTE_FIELD",
            `${attr.name} on <${node.piece}> takes a ${spec.fields.join(", ")} field; ${attr.value.ref.join(".")} is ${type}.`,
            attr.valuePos,
          );
        }
      } else if (spec.literal === "field-key") {
        const target = field(attr.value.lit, attr.valuePos);
        const display = attrOf(node, "display");
        if (target && display && "lit" in display.value) {
          const allowed = displaysForField(target);
          if (!allowed.includes(display.value.lit)) {
            report(
              "error",
              "TEMPLATE_ATTRIBUTE_VALUE",
              allowed.length
                ? `display="${display.value.lit}" does not fit the ${target.type} field ${attr.value.lit}; use one of ${allowed.join(", ")}.`
                : `${target.type} fields have no display options; remove display from <ravi-field name="${attr.value.lit}">.`,
              display.valuePos,
            );
          }
        }
      }
    }
    if (node.piece === "ravi-button") {
      const set = attrOf(node, "set");
      const verb = literalAttr(node, "action") as WidgetActionVerb | undefined;
      if (set && "lit" in set.value && (verb === "update" || verb === "create")) {
        const result = parseSetExpression(set.value.lit, fields, { verb, at: set.valuePos, file: WIDGET_TEMPLATE_FILE });
        diagnostics.push(...result.diagnostics);
        sets.set(node, result.set);
      }
    }
  };

  for (const variant of parsed.variants) visit(variant.nodes, new Map());

  // Variant blocks against the declared variants.
  const declared = manifest.variants;
  const blocks = new Set(parsed.variants.map((variant) => variant.name));
  if (parsed.hasVariantBlocks) {
    for (const variant of parsed.variants) {
      if (!declared.includes(variant.name)) {
        report(
          "error",
          "TEMPLATE_VARIANT_UNDECLARED",
          `widget.json variants does not list "${variant.name}"; add it there or remove this block.`,
          variant.pos,
        );
      }
    }
    if (!blocks.has("default")) {
      report(
        "error",
        "TEMPLATE_VARIANT_DEFAULT_MISSING",
        'Add a <ravi-variant name="default"> block: every other variant falls back to it.',
        parsed.variants[0]?.pos ?? null,
      );
    }
  }
  for (const name of declared) {
    if (name !== "default" && !blocks.has(name)) {
      report(
        "warning",
        "TEMPLATE_VARIANT_MISSING",
        `Variant "${name}" has no <ravi-variant name="${name}"> block in widget.html; it renders like default.`,
        parsed.variants[0]?.pos ?? null,
      );
    }
  }

  // Actions, in document order, one entry per distinct action.
  const actions: WidgetAction[] = [];
  const buttons = new Map<AstElement, number>();
  const indexByKey = new Map<string, number>();
  const collect = (nodes: readonly AstNode[]) => {
    for (const node of nodes) {
      if (node.k === "if") {
        collect(node.then);
        collect(node.else);
      } else if (node.k === "each") {
        collect(node.children);
      } else if (node.k === "el") {
        if (node.piece === "ravi-button") {
          const action = buttonAction(node, sets.get(node) ?? {});
          if (action) {
            const key = canonicalJson(action);
            let index = indexByKey.get(key);
            if (index === undefined) {
              index = actions.length;
              actions.push(action);
              indexByKey.set(key, index);
            }
            buttons.set(node, index);
          }
        }
        collect(node.children);
      }
    }
  };
  for (const variant of parsed.variants) collect(variant.nodes);

  return { diagnostics, actions, buttons };
}

function buttonAction(node: AstElement, set: Record<string, SetValue>): WidgetAction | null {
  const verb = literalAttr(node, "action") as WidgetActionVerb | undefined;
  if (!verb) return null;
  const href = attrOf(node, "href")?.value;
  return {
    verb,
    set: verb === "update" || verb === "create" ? set : {},
    href: verb === "open" && href && "ref" in href ? (href.ref[0] ?? null) : null,
    confirm: verb === "archive" || (verb !== "open" && literalAttr(node, "confirm") === "true"),
    label: literalText(node.children).replace(/\s+/g, " ").trim(),
  };
}

/** Literal text outside blocks, including inside inline pieces: the visible label as written. */
function literalText(nodes: readonly AstNode[]): string {
  return nodes.map((node) => (node.k === "text" ? node.v : node.k === "el" ? literalText(node.children) : "")).join("");
}

function toTemplateNodes(nodes: readonly AstNode[], buttons: ReadonlyMap<AstElement, number>): TemplateNode[] {
  return nodes.map((node): TemplateNode => {
    switch (node.k) {
      case "text":
        return { k: "text", v: node.v };
      case "expr":
        return { k: "expr", path: [...node.path], filters: [...node.filters] };
      case "if":
        return { k: "if", path: [...node.path], not: node.not, then: toTemplateNodes(node.then, buttons), else: toTemplateNodes(node.else, buttons) };
      case "each":
        return { k: "each", path: [...node.path], as: node.as, children: toTemplateNodes(node.children, buttons) };
      case "el": {
        const attrs: Record<string, TemplateAttrValue> = {};
        for (const attr of node.attrs) attrs[attr.name] = "ref" in attr.value ? { ref: [...attr.value.ref] } : { lit: attr.value.lit };
        const index = buttons.get(node);
        if (index !== undefined) attrs["data-ravi-action"] = { lit: String(index) };
        return { k: "el", piece: node.piece, attrs, children: toTemplateNodes(node.children, buttons), line: node.pos.line };
      }
    }
  });
}

function unknownFieldMessage(key: string, known: string[]) {
  const suggestion = closest(key, known);
  const hint = suggestion ? ` (did you mean "${suggestion}"?)` : "";
  return known.length
    ? `Unknown field "${key}"${hint}; widget.json fields: ${known.join(", ")}.`
    : `Unknown field "${key}"; declare it in widget.json fields first.`;
}

function closest(key: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Math.max(2, Math.floor(key.length / 3)) + 1;
  for (const candidate of candidates) {
    const distance = editDistance(key, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

// ---------------------------------------------------------------------------
// example.json

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
const RESERVED_EMAIL_DOMAIN = /@(?:[A-Za-z0-9-]+\.)*(?:example\.(?:com|org|net)|[A-Za-z0-9-]+\.(?:example|test|invalid|localhost))$/i;
const ISO_DATE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;
const DIGIT_RUN = /\+?\d[\d\s().-]*\d/g;
/** Trailing zeros that mark a phone number as invented. */
export const INVENTED_PHONE_ZEROS = 8;
/** What `EXAMPLE_PERSONAL_DATA` suggests instead, per kind; each example passes the check. */
export const PERSONAL_DATA_HINT = {
  "e-mail address": "use an invented address at example.com, example.org or example.net, or a .test or .example domain (e.g. ana@example.com)",
  "phone number": "use an invented number whose last 8 digits are zeros (e.g. +55 11 90000-0000)",
} as const;

function readExample(text: string | undefined, manifest: WidgetManifest | null): { records: unknown[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (text === undefined) return { records: [], diagnostics };
  const parsed = parseJsonWithLines(text);
  if (!parsed.ok) {
    diagnostics.push({
      severity: "error",
      code: "EXAMPLE_JSON",
      message: `example.json is not valid JSON: ${parsed.message}.`,
      file: WIDGET_EXAMPLE_FILE,
      line: parsed.line,
      column: parsed.column,
    });
    return { records: [], diagnostics };
  }
  const at = (path: JsonPath) => jsonKeyPosition(text, parsed.keyLine, path);
  const error = (code: string, message: string, path: JsonPath) => {
    diagnostics.push({ severity: "error", code, message, file: WIDGET_EXAMPLE_FILE, ...at(path) });
  };

  const value = parsed.value;
  if (!isJsonObject(value)) {
    error("EXAMPLE_SHAPE", 'example.json must be one record { "field": value } or { "records": [ … ] }.', []);
    return { records: [], diagnostics };
  }

  let records: unknown[] = [value];
  let base: JsonPath[] = [[]];
  const keys = Object.keys(value);
  const recordsField = manifest ? Object.hasOwn(manifest.fields, "records") : false;
  if (keys.length === 1 && keys[0] === "records" && Array.isArray(value.records) && !recordsField) {
    const list = value.records as unknown[];
    if (list.length === 0 || !list.every(isJsonObject)) {
      error("EXAMPLE_SHAPE", "records must be a non-empty list of objects, one per record.", ["records"]);
      return { records: [], diagnostics };
    }
    if (list.length > MAX_EXAMPLE_RECORDS) {
      error("EXAMPLE_TOO_MANY", `example.json holds at most ${MAX_EXAMPLE_RECORDS} records; it has ${list.length}.`, ["records"]);
      return { records: [], diagnostics };
    }
    records = list;
    base = list.map((_, index) => ["records", index]);
  }

  records.forEach((record, index) => {
    scanPersonalData(record, base[index] ?? [], (path, kind) => {
      diagnostics.push({
        severity: "warning",
        code: "EXAMPLE_PERSONAL_DATA",
        message: `example.json ${path.join(".")} looks like a real ${kind}; ${PERSONAL_DATA_HINT[kind]}: org widgets are visible to every project.`,
        file: WIDGET_EXAMPLE_FILE,
        ...at(path),
      });
    });
  });
  return { records, diagnostics };
}

function scanPersonalData(value: unknown, path: JsonPath, report: (path: JsonPath, kind: "e-mail address" | "phone number") => void) {
  if (typeof value === "string") {
    if (looksLikeEmail(value)) report(path, "e-mail address");
    else if (looksLikePhone(value)) report(path, "phone number");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanPersonalData(entry, [...path, index], report));
    return;
  }
  if (isJsonObject(value)) {
    for (const [key, entry] of Object.entries(value)) scanPersonalData(entry, [...path, key], report);
  }
}

export function looksLikeEmail(text: string) {
  for (const match of text.matchAll(EMAIL_PATTERN)) if (!RESERVED_EMAIL_DOMAIN.test(match[0])) return true;
  return false;
}

/**
 * A phone number of 8+ digits, unless it is an invented one: its last
 * {@link INVENTED_PHONE_ZEROS} digits are zeros (`+55 11 90000-0000`,
 * `+5500000000000`, `(00) 0000-0000`).
 */
export function looksLikePhone(text: string) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim())) return false;
  const withoutDates = text.replace(ISO_DATE, " ");
  for (const match of withoutDates.matchAll(DIGIT_RUN)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 8 && !digits.endsWith("0".repeat(INVENTED_PHONE_ZEROS))) return true;
  }
  return false;
}
