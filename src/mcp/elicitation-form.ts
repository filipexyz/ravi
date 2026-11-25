/**
 * What an MCP elicitation request asks, and whether an answer fits it
 * (spec mcp, Elicitation).
 *
 * This module is the shape of a request and the arithmetic of an answer, with
 * no surface and no I/O: reading a server's `elicitation/create` params into a
 * flat plan Ravi will serve (`planMcpElicitation`), refusing shapes it does
 * not serve or that look like a secret, and checking one value or a whole
 * content object against that plan.
 *
 * It is shared by the gateway's handler (`src/mcp/elicitation.ts`, which asks
 * in a chat) and by the Slack modal (`src/channels/slack/mcp-elicitation.ts`),
 * so both surfaces accept exactly the same answers.
 */

/** Forms with more fields than this are declined. */
export const MCP_ELICITATION_MAX_FIELDS = 8;

/** The words a person reads on a choice; one list, so every surface agrees. */
export const MCP_ELICITATION_LABEL = {
  yes: "Sim",
  no: "Não",
  skip: "Pular esta pergunta",
  send: "Enviar",
  accept: "Aceitar",
  refuse: "Recusar",
} as const;

export const MAX_ELICITATION_MESSAGE_CHARS = 1_500;
export const MAX_ELICITATION_LABEL_CHARS = 100;
export const MAX_ELICITATION_DESCRIPTION_CHARS = 300;
export const MAX_ELICITATION_TEXT_ANSWER_CHARS = 2_000;
export const MAX_ELICITATION_URL_CHARS = 2_048;
export const MAX_ELICITATION_CHOICES = 12;

const FIELD_NAME_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;

// ============================================================================
// Request plan
// ============================================================================

export type McpElicitationFieldKind = "string" | "number" | "integer" | "boolean" | "enum";

export interface McpElicitationField {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  kind: McpElicitationFieldKind;
  /** string */
  minLength?: number;
  maxLength?: number;
  format?: "email" | "uri" | "date" | "date-time";
  /** number, integer */
  minimum?: number;
  maximum?: number;
  /** enum: what the person picks, and the value sent for it. */
  choices?: { label: string; value: string }[];
}

export type McpElicitationRefusal =
  | "unsupported_request"
  | "unsupported_form"
  | "too_many_fields"
  | "secret_field"
  | "unsafe_url";

export type McpElicitationPlan =
  | { ok: true; mode: "form"; message: string; fields: McpElicitationField[] }
  | { ok: true; mode: "url"; message: string; url: URL }
  | { ok: false; mode: "form" | "url" | "unknown"; code: McpElicitationRefusal; fieldCount: number };

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The URL, or null when the text is not one. */
export function parseElicitationUrl(text: string): URL | null {
  try {
    return new URL(text);
  } catch {
    // no-cause: text that is not a URL is reported as null; each caller refuses it.
    return null;
  }
}

/**
 * Every line or paragraph break a renderer may draw: CR LF, CR, vertical tab,
 * form feed, NEXT LINE (U+0085), LINE SEPARATOR (U+2028) and PARAGRAPH
 * SEPARATOR (U+2029). They all become "\n", so the quotation below marks
 * every visual line a server wrote.
 */
const LINE_BREAKS = /\r\n|[\r\u000b\u000c\u0085\u2028\u2029]/g;
/** The same breaks with "\n" itself, to split a text into the lines a person sees. */
const LINE_BREAKS_ANY = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;
/**
 * Removed outright: C0 controls other than the newline, DEL, C1 controls, and
 * the bidi marks, embeddings, overrides and isolates (U+061C, U+200E, U+200F,
 * U+202A-U+202E, U+2066-U+2069), which can reorder what a person reads.
 */
const INVISIBLE_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Printable text of at most `max` characters: every line break normalized to
 * "\n", other control and bidi characters removed, and a longer text cut with
 * an ellipsis that counts inside `max` (a choice label must fit the 100
 * characters a chat question takes).
 */
export function cleanElicitationText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(LINE_BREAKS, "\n").replace(INVISIBLE_CONTROLS, " ").trim();
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  // Never leave half of a surrogate pair before the ellipsis.
  const kept = text.slice(0, max - 1).replace(/[\ud800-\udbff]$/, "");
  return `${kept}…`;
}

/** A label or a choice: one line, every run of whitespace (newlines included) one space. */
export function oneLineElicitationText(value: unknown, max: number): string {
  return cleanElicitationText(typeof value === "string" ? value.replace(/[\s\u0085]+/g, " ") : value, max);
}

/** The most lines of one server text a person is shown; the rest is cut with an ellipsis line. */
export const MAX_QUOTED_SERVER_LINES = 12;

/**
 * Server text (a message, a description) as a quotation, so it can never pass
 * for Ravi's own lines: every line starts with `> ` (an empty line is `>`),
 * leading and trailing blank lines go, runs of blank lines become one, and
 * at most `maxLines` lines are kept. Ravi's own lines never start with `>`.
 */
export function quoteMcpServerText(text: string, maxLines = MAX_QUOTED_SERVER_LINES): string {
  const lines: string[] = [];
  // Split on every break a renderer may draw, even in text that was not cleaned first.
  for (const raw of text.split(LINE_BREAKS_ANY)) {
    const line = raw.replace(INVISIBLE_CONTROLS, " ").trimEnd();
    if (!line && (lines.length === 0 || lines.at(-1) === "")) continue;
    lines.push(line);
  }
  while (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) return "";
  const kept = lines.length > maxLines ? [...lines.slice(0, maxLines - 1), "…"] : lines;
  return kept.map((line) => (line ? `> ${line}` : ">")).join("\n");
}

const SECRET_SUBSTRINGS = ["password", "passwd", "passphrase", "passcode", "token", "secret", "otp", "cvv", "cvc"];
const SECRET_WORDS = new Set(["code", "card", "pin", "senha"]);

/** Whether a field asks for something that must never travel through a chat. */
export function isSecretLookingField(name: string, schema: Record<string, unknown>): boolean {
  if (schema.format === "password" || schema.writeOnly === true) return true;
  for (const source of [name, typeof schema.title === "string" ? schema.title : ""]) {
    const lowered = source.toLowerCase();
    if (SECRET_SUBSTRINGS.some((part) => lowered.includes(part))) return true;
    const words = source
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (words.some((word) => SECRET_WORDS.has(word))) return true;
  }
  return false;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** One property of a flat form, or null when Ravi does not serve its shape. */
function planField(name: string, schema: unknown, required: boolean): McpElicitationField | null {
  if (!FIELD_NAME_PATTERN.test(name) || !plainObject(schema)) return null;
  if ("pattern" in schema) return null; // Not part of the primitive schemas; never run a server's regex on an answer.
  const label = oneLineElicitationText(schema.title, MAX_ELICITATION_LABEL_CHARS) || name;
  const description = cleanElicitationText(schema.description, MAX_ELICITATION_DESCRIPTION_CHARS);
  const base = { name, label, required, ...(description ? { description } : {}) };
  const type = schema.type;

  if (type === "string" && (Array.isArray(schema.enum) || Array.isArray(schema.oneOf))) {
    const choices: { label: string; value: string }[] = [];
    if (Array.isArray(schema.enum)) {
      const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
      for (const [index, value] of schema.enum.entries()) {
        if (typeof value !== "string") return null;
        const shown =
          oneLineElicitationText(names[index], MAX_ELICITATION_LABEL_CHARS) ||
          oneLineElicitationText(value, MAX_ELICITATION_LABEL_CHARS);
        choices.push({ label: shown, value });
      }
    } else {
      for (const option of schema.oneOf as unknown[]) {
        if (!plainObject(option) || typeof option.const !== "string") return null;
        const shown =
          oneLineElicitationText(option.title, MAX_ELICITATION_LABEL_CHARS) ||
          oneLineElicitationText(option.const, MAX_ELICITATION_LABEL_CHARS);
        choices.push({ label: shown, value: option.const });
      }
    }
    const labels = choices.map((choice) => choice.label.replace(/\s+/g, " ").trim().toLowerCase());
    const total = choices.length + (required ? 0 : 1);
    if (choices.length === 0 || total < 2 || total > MAX_ELICITATION_CHOICES) return null;
    if (labels.some((label) => !label) || new Set(labels).size !== labels.length) return null;
    if (!required && labels.includes(MCP_ELICITATION_LABEL.skip.toLowerCase())) return null;
    return { ...base, kind: "enum", choices };
  }
  if (type === "string") {
    const format = schema.format;
    if (format !== undefined && format !== "email" && format !== "uri" && format !== "date" && format !== "date-time") {
      return null;
    }
    const minLength = nonNegativeInteger(schema.minLength);
    const maxLength = nonNegativeInteger(schema.maxLength);
    if (
      (schema.minLength !== undefined && minLength === undefined) ||
      (schema.maxLength !== undefined && maxLength === undefined)
    ) {
      return null;
    }
    return {
      ...base,
      kind: "string",
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(format ? { format } : {}),
    };
  }
  if (type === "number" || type === "integer") {
    const minimum = finiteNumber(schema.minimum);
    const maximum = finiteNumber(schema.maximum);
    if (
      (schema.minimum !== undefined && minimum === undefined) ||
      (schema.maximum !== undefined && maximum === undefined)
    ) {
      return null;
    }
    return {
      ...base,
      kind: type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
    };
  }
  if (type === "boolean") return { ...base, kind: "boolean" };
  return null;
}

/** Read an MCP elicitation request into what Ravi will ask, or the reason it declines. */
export function planMcpElicitation(params: unknown): McpElicitationPlan {
  if (!plainObject(params)) return { ok: false, mode: "unknown", code: "unsupported_request", fieldCount: 0 };
  const message = cleanElicitationText(params.message, MAX_ELICITATION_MESSAGE_CHARS);
  const mode = params.mode === undefined ? "form" : params.mode;

  if (mode === "url") {
    const raw = typeof params.url === "string" ? params.url.trim() : "";
    const url = raw && raw.length <= MAX_ELICITATION_URL_CHARS ? parseElicitationUrl(raw) : null;
    if (
      !url ||
      url.href.length > MAX_ELICITATION_URL_CHARS || // what the person reads is the parsed form, which may be longer
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      return { ok: false, mode: "url", code: "unsafe_url", fieldCount: 0 };
    }
    return { ok: true, mode: "url", message, url };
  }
  if (mode !== "form") return { ok: false, mode: "unknown", code: "unsupported_request", fieldCount: 0 };

  const schema = params.requestedSchema;
  if (!plainObject(schema) || (schema.type !== undefined && schema.type !== "object")) {
    return { ok: false, mode: "form", code: "unsupported_form", fieldCount: 0 };
  }
  const properties = schema.properties ?? {};
  if (!plainObject(properties)) return { ok: false, mode: "form", code: "unsupported_form", fieldCount: 0 };
  const names = Object.keys(properties);
  if (names.length > MCP_ELICITATION_MAX_FIELDS) {
    return { ok: false, mode: "form", code: "too_many_fields", fieldCount: names.length };
  }
  const required = schema.required ?? [];
  if (!Array.isArray(required) || !required.every((name) => typeof name === "string" && names.includes(name))) {
    return { ok: false, mode: "form", code: "unsupported_form", fieldCount: names.length };
  }
  for (const name of names) {
    const property = properties[name];
    if (isSecretLookingField(name, plainObject(property) ? property : {})) {
      return { ok: false, mode: "form", code: "secret_field", fieldCount: names.length };
    }
  }
  const fields: McpElicitationField[] = [];
  for (const name of names) {
    const field = planField(name, properties[name], required.includes(name));
    if (!field) return { ok: false, mode: "form", code: "unsupported_form", fieldCount: names.length };
    fields.push(field);
  }
  return { ok: true, mode: "form", message, fields };
}

// ============================================================================
// Answers
// ============================================================================

export type McpFieldAnswer =
  | { ok: true; value: string | number | boolean }
  | { ok: true; skip: true }
  | { ok: false; hint: string };

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** The poll labels of a choice field, in order. */
export function mcpFieldOptions(field: McpElicitationField): string[] {
  const labels =
    field.kind === "boolean"
      ? [MCP_ELICITATION_LABEL.yes, MCP_ELICITATION_LABEL.no]
      : field.kind === "enum"
        ? (field.choices ?? []).map((choice) => choice.label)
        : [];
  return labels.length > 0 && !field.required ? [...labels, MCP_ELICITATION_LABEL.skip] : labels;
}

/**
 * The label a person's answer names: the label itself (any case), or else its
 * number in the list. A label is read before a position, so with choices such
 * as "5", "10" and "1" the answer "1" is the label "1", never the first choice.
 */
export function matchElicitationLabel(answer: string, labels: readonly string[]): string | null {
  const folded = fold(answer);
  const exact = labels.find((label) => fold(label) === folded);
  if (exact !== undefined) return exact;
  if (/^\d{1,2}$/.test(folded)) return labels[Number.parseInt(folded, 10) - 1] ?? null;
  return null;
}

function isValidDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function checkString(field: McpElicitationField, text: string): McpFieldAnswer {
  const length = [...text].length;
  if (length > MAX_ELICITATION_TEXT_ANSWER_CHARS) {
    return { ok: false, hint: `no máximo ${MAX_ELICITATION_TEXT_ANSWER_CHARS} caracteres` };
  }
  if (field.minLength !== undefined && length < field.minLength) {
    return { ok: false, hint: `pelo menos ${field.minLength} caracteres` };
  }
  if (field.maxLength !== undefined && length > field.maxLength) {
    return { ok: false, hint: `no máximo ${field.maxLength} caracteres` };
  }
  switch (field.format) {
    case "email":
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { ok: false, hint: "um e-mail" };
      break;
    case "uri": {
      const parsed = parseElicitationUrl(text);
      if (!parsed || !/^[a-z][a-z0-9+.-]*:$/i.test(parsed.protocol)) {
        return { ok: false, hint: "um endereço completo (com https://)" };
      }
      break;
    }
    case "date":
      if (!isValidDate(text)) return { ok: false, hint: "uma data no formato AAAA-MM-DD" };
      break;
    case "date-time":
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text) ||
        !isValidDate(text.slice(0, 10)) ||
        Number.isNaN(Date.parse(text))
      ) {
        return { ok: false, hint: "data e hora no formato AAAA-MM-DDTHH:MM com fuso (ex.: Z)" };
      }
      break;
  }
  return { ok: true, value: text };
}

function checkNumber(field: McpElicitationField, text: string): McpFieldAnswer {
  const normalized = text.replace(/\s+/g, "");
  if (!/^-?\d+([.,]\d+)?$/.test(normalized)) return { ok: false, hint: "um número" };
  const value = Number(normalized.replace(",", "."));
  if (!Number.isFinite(value)) return { ok: false, hint: "um número" };
  if (field.kind === "integer" && !Number.isInteger(value)) return { ok: false, hint: "um número inteiro" };
  if (field.minimum !== undefined && value < field.minimum) return { ok: false, hint: `no mínimo ${field.minimum}` };
  if (field.maximum !== undefined && value > field.maximum) return { ok: false, hint: `no máximo ${field.maximum}` };
  return { ok: true, value };
}

/**
 * One typed field written as text (a chat reply, a Slack input), checked
 * against the schema: the value to send, or a hint for asking again. Choice
 * fields (boolean, enum) are not read here; their surface offers the labels.
 */
export function checkMcpFieldText(field: McpElicitationField, text: string): McpFieldAnswer {
  if (field.kind === "string") return checkString(field, text);
  if (field.kind === "number" || field.kind === "integer") return checkNumber(field, text);
  return { ok: false, hint: "uma das opções" };
}

/**
 * Read one answer of the person for one field: the label they picked, or the
 * text they replied. Returns the value to send, a skip (optional fields only),
 * or a hint for asking again.
 */
export function readMcpFieldAnswer(field: McpElicitationField, answer: string): McpFieldAnswer {
  const text = answer.trim();
  const options = mcpFieldOptions(field);
  if (options.length > 0) {
    const label = matchElicitationLabel(text, options);
    if (!label) return { ok: false, hint: "uma das opções" };
    if (label === MCP_ELICITATION_LABEL.skip && !field.required) return { ok: true, skip: true };
    if (field.kind === "boolean") return { ok: true, value: label === MCP_ELICITATION_LABEL.yes };
    const choice = (field.choices ?? []).find((entry) => entry.label === label);
    return choice ? { ok: true, value: choice.value } : { ok: false, hint: "uma das opções" };
  }
  if (!text) return { ok: false, hint: "uma resposta" };
  if (!field.required && text === "-") return { ok: true, skip: true };
  return checkMcpFieldText(field, text);
}

/** One already-typed value against its field: the same bounds as a text answer. */
export function checkMcpFieldValue(field: McpElicitationField, value: unknown): boolean {
  switch (field.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && (field.choices ?? []).some((choice) => choice.value === value);
    case "string": {
      if (typeof value !== "string") return false;
      const check = checkString(field, value);
      return check.ok && "value" in check && check.value === value;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (field.kind === "integer" && !Number.isInteger(value)) return false;
      if (field.minimum !== undefined && value < field.minimum) return false;
      if (field.maximum !== undefined && value > field.maximum) return false;
      return true;
    }
  }
}

/**
 * The final check before anything is sent: every required field present,
 * no field the form did not ask for, and every value of the right type and
 * within the schema's bounds.
 */
export function validateMcpElicitationContent(
  fields: readonly McpElicitationField[],
  content: Record<string, unknown>,
): boolean {
  const known = new Set(fields.map((field) => field.name));
  if (Object.keys(content).some((name) => !known.has(name))) return false;
  for (const field of fields) {
    const value = content[field.name];
    if (value === undefined) {
      if (field.required) return false;
      continue;
    }
    if (!checkMcpFieldValue(field, value)) return false;
  }
  return true;
}
