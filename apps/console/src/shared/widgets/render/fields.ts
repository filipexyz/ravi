// One value as markup, by type, column config, role and display. Every field
// root carries `data-ravi-field` and `data-ravi-value` (the raw value for
// agents) and a label, visible or `.ravi-sr-only`. Color is never the only
// signal: options always show their name, meters and ratings show text.
// select/status/checkbox become native editors only when the field is
// editable, the render is interactive and the viewer may write the key; with
// `ctx.editAll` (the runtime's table cells) text, number, date, url, email,
// phone and multi_select do too. Approval cells show their state as a badge
// plus, when interactive, the decision and request buttons the viewer may
// use; agent cells show the filled value and a state badge, never an editor.

import type { BaseOptionColor, BaseSelectOption, BaseStatusGroup } from "@/shared/bases/types";

import {
  FIELD_ROLE_DISPLAYS,
  FIELD_ROLE_TYPES,
  FIELD_TYPE_DISPLAYS,
  OPTION_COLORS,
  type FieldDisplayKey,
  type FieldDisplayRules,
  type FieldRole,
  type RenderColumn,
  type RenderContext,
  type VElement,
  type VNode,
  type WidgetFieldType,
} from "../types";
import {
  dateDisplay,
  formatDateParts,
  formatNumber,
  formatNumberByColumn,
  formatPercentFraction,
  formatValue,
  initials,
  isEmptyValue,
  numberKind,
  optionFor,
  optionValues,
  personRefs,
  progressFraction,
  rawValueText,
  refText,
  refValues,
  urlDomain,
  urlText,
  type DateText,
  type PersonRef,
} from "./format";
import { messages, type RuntimeMessages } from "./messages";
import { cx, h, mailtoUrl, safeUrl, spaced, telUrl } from "./vnode";

const STATUS_GROUPS: readonly BaseStatusGroup[] = ["todo", "in_progress", "done"];
const RATING_MAX = 5;

// ---------------------------------------------------------------------------
// Display resolution

/** The `fields.json` key a column's values fall under, or null for types without displays (text, email, phone, ref, body). */
export function displayKey(column: Pick<RenderColumn, "type" | "config">): FieldDisplayKey | null {
  switch (column.type) {
    case "status":
    case "select":
    case "multi_select":
    case "url":
    case "checkbox":
      return column.type;
    case "number":
      return numberKind(column);
    case "date":
    case "created_time":
    case "updated_time":
      return "date";
    case "person":
    case "created_by":
    case "updated_by":
      return "person";
    default:
      return null;
  }
}

function widgetTypeOf(column: Pick<RenderColumn, "type">): WidgetFieldType | null {
  switch (column.type) {
    case "created_by":
    case "updated_by":
      return "person";
    case "created_time":
    case "updated_time":
      return "date";
    case "body":
    case "approval":
    case "agent":
      return "text";
    default:
      return column.type;
  }
}

/** True when `role` applies to the column's type (FIELD_ROLE_TYPES). */
export function roleFits(role: FieldRole | undefined, column: Pick<RenderColumn, "type">): role is FieldRole {
  if (!role) return false;
  const type = widgetTypeOf(column);
  return Boolean(type && FIELD_ROLE_TYPES[role]?.includes(type));
}

/**
 * Display for one value: the `display` attribute when it is valid for the
 * role or the type (any number display for numbers), else the role's display
 * from the rules, else the type's (currency and percent by number format).
 * Types without displays give `text`, `email`, `phone` or `ref`.
 */
export function resolveDisplay(input: { column: RenderColumn; role?: FieldRole; override?: string; rules: FieldDisplayRules }): string {
  const { column, override, rules } = input;
  const role = roleFits(input.role, column) ? input.role : undefined;
  const roleList: readonly string[] = role ? FIELD_ROLE_DISPLAYS[role] : [];
  const key = displayKey(column);
  const typeList: readonly string[] = key ? FIELD_TYPE_DISPLAYS[key] : [];
  // A number may be shown as any number display: the column format is only known at render.
  const overrideList: readonly string[] =
    column.type === "number" ? [...FIELD_TYPE_DISPLAYS.number, ...FIELD_TYPE_DISPLAYS.currency, ...FIELD_TYPE_DISPLAYS.percent] : typeList;
  if (override && (roleList.includes(override) || overrideList.includes(override))) return override;
  if (role) {
    const fromRules: string | undefined = rules?.roles?.[role];
    return fromRules && roleList.includes(fromRules) ? fromRules : (roleList[0] as string);
  }
  if (key) {
    const fromRules: string | undefined = rules?.types?.[key];
    return fromRules && typeList.includes(fromRules) ? fromRules : (typeList[0] as string);
  }
  if (column.type === "email" || column.type === "phone" || column.type === "ref") return column.type;
  return "text";
}

/**
 * The display `formatValue` should use for the text of a value: a progress
 * role's `percent` reads as a share of the max (40 → 40%), not as a fraction.
 */
export function textDisplay(display: string, role: FieldRole | undefined): string {
  return role === "progress" && display === "percent" ? "bar" : display;
}

/** "data_entrega" → "Data entrega". */
export function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").trim();
  return words ? `${words.charAt(0).toLocaleUpperCase()}${words.slice(1)}` : key;
}

// ---------------------------------------------------------------------------
// Pieces of a value

export function optionColor(color: unknown): BaseOptionColor {
  return OPTION_COLORS.includes(color as BaseOptionColor) ? (color as BaseOptionColor) : "gray";
}

/** An option chip: color plus its name, always. */
export function renderPill(option: Pick<BaseSelectOption, "name" | "color">): VElement {
  return h(
    "span",
    { class: cx("ravi-pill", `ravi-option-${optionColor(option.color)}`) },
    h("span", { class: "ravi-dot", "aria-hidden": "true" }),
    option.name,
  );
}

/** "—" for sighted readers, "Sem valor" for assistive technology and text readers. */
export function renderEmpty(msgs: RuntimeMessages): VElement {
  return h("span", { class: "ravi-empty" }, h("span", { "aria-hidden": "true" }, "—"), h("span", { class: "ravi-sr-only" }, msgs.noValue));
}

/**
 * A `role="meter"` with min/max/now, a text alternative and the same text
 * visible (`40%`). `ring` draws a circle, `bar` a track.
 */
export function renderMeter(input: { value: number; max: number; text: string; shape: "bar" | "ring"; label?: string | null }): VElement {
  const max = input.max > 0 && Number.isFinite(input.max) ? input.max : 100;
  const now = Math.min(max, Math.max(0, Number.isFinite(input.value) ? input.value : 0));
  const percent = Math.round((now / max) * 1000) / 10;
  return h(
    "div",
    {
      class: cx("ravi-meter", input.shape === "ring" ? "ravi-ring" : "ravi-bar"),
      role: "meter",
      "aria-label": input.label || null,
      "aria-valuemin": "0",
      "aria-valuemax": String(max),
      "aria-valuenow": String(now),
      "aria-valuetext": input.text,
      style: `--ravi-progress: ${percent}%`,
    },
    h("span", { class: "ravi-meter-track", "aria-hidden": "true" }, h("span", { class: "ravi-meter-fill" })),
    h("span", { class: "ravi-meter-text" }, input.text),
  );
}

/** Stars (hidden from assistive technology) and the text "4 de 5". */
export function renderRating(value: number, text: string, msgs: RuntimeMessages): VElement {
  const filled = Math.round(Math.min(RATING_MAX, Math.max(0, value)));
  return h(
    "span",
    { class: "ravi-rating" },
    h("span", { class: "ravi-stars", "aria-hidden": "true" }, "★".repeat(filled) + "☆".repeat(RATING_MAX - filled)),
    " ",
    h("span", { class: "ravi-rating-text" }, msgs.outOf(text, String(RATING_MAX))),
  );
}

/**
 * An avatar: the image when the URL is safe, else initials. With a name the
 * avatar is named (alt or visually hidden text); `decorative` hides it when
 * the name is shown next to it.
 */
export function renderAvatar(
  person: { name: string; avatarUrl: string | null },
  options: { shape?: "circle" | "square"; decorative?: boolean; size?: "sm" | "md" | "lg" } = {},
): VElement {
  const className = cx("ravi-avatar", options.shape === "square" && "ravi-avatar-square", options.size && options.size !== "md" && `ravi-avatar-${options.size}`);
  const src = safeUrl(person.avatarUrl, ["https", "http"]);
  if (src) return h("img", { class: className, src, alt: options.decorative ? "" : person.name });
  if (options.decorative) return h("span", { class: className, "aria-hidden": "true" }, initials(person.name));
  return h("span", { class: className }, h("span", { "aria-hidden": "true" }, initials(person.name)), h("span", { class: "ravi-sr-only" }, person.name));
}

/**
 * A date or range as `<time datetime>`: the formatted text for people, the
 * ISO value for agents and machines (a relative "em 2 dias" frozen in a
 * prerender still carries the date it meant).
 */
export function renderDateText(date: DateText): VNode[] {
  const one = (part: DateText["start"]) => h("time", { datetime: part.iso }, part.text);
  return date.end ? [one(date.start), " – ", one(date.end)] : [one(date.start)];
}

/**
 * Initials on screen with the full text kept for screen readers and text
 * extraction (`ravi pages read` skips `aria-hidden`), like an avatar's.
 */
export function renderInitialsText(short: string, full: string): VNode[] {
  if (!short) return [];
  if (!full || full === short) return [short];
  return [h("span", null, h("span", { "aria-hidden": "true" }, short), h("span", { class: "ravi-sr-only" }, full))];
}

function renderPeople(people: PersonRef[], display: string): VNode {
  const one = (person: PersonRef): VElement => {
    if (display === "initials") return renderAvatar(person, { size: "sm" });
    if (display === "circle" || display === "square") return renderAvatar(person, { shape: display });
    if (display === "name") return h("span", { class: "ravi-person-name" }, person.name);
    return h("span", { class: "ravi-person" }, renderAvatar(person, { decorative: true, size: "sm" }), h("span", { class: "ravi-person-name" }, person.name));
  };
  if (people.length === 1) return one(people[0] as PersonRef);
  return h("ul", { class: "ravi-people", role: "list" }, spaced(people.map((person) => h("li", null, one(person)))));
}

function renderLink(href: string | null, text: string): VNode {
  return href ? h("a", { class: "ravi-link", href }, text) : h("span", { class: "ravi-text-value" }, text);
}

function renderSteps(option: BaseSelectOption, msgs: RuntimeMessages): VElement {
  const currentIndex = STATUS_GROUPS.indexOf(option.group as BaseStatusGroup);
  const steps = STATUS_GROUPS.map((group, index) => {
    const current = index === currentIndex;
    return h(
      "li",
      {
        class: cx("ravi-step", current && "ravi-step-current", current && `ravi-option-${optionColor(option.color)}`, index < currentIndex && "ravi-step-done"),
        "aria-current": current ? "step" : null,
      },
      current ? option.name : msgs.statusGroups[group],
    );
  });
  return h("ol", { class: "ravi-steps" }, spaced(steps));
}

// ---------------------------------------------------------------------------
// The value node by display

function valueNode(
  input: { column: RenderColumn; value: unknown; role?: FieldRole; labelText: string },
  display: string,
  ctx: RenderContext,
  msgs: RuntimeMessages,
): VNode {
  const { column, value } = input;
  const role = roleFits(input.role, column) ? input.role : undefined;
  const type = column.type;

  if (type === "checkbox") {
    const checked = value === true;
    if (display === "yes-no") return h("span", { class: "ravi-text-value" }, checked ? msgs.yes : msgs.no);
    return h(
      "span",
      { class: cx("ravi-check", checked && "ravi-check-on") },
      h("span", { class: "ravi-check-box", "aria-hidden": "true" }, checked ? "✓" : ""),
      h("span", { class: "ravi-sr-only" }, checked ? msgs.yes : msgs.no),
    );
  }
  if (isEmptyValue(value)) return renderEmpty(msgs);

  switch (type) {
    case "status":
    case "select": {
      const option = optionFor(column, value);
      const name = formatValue(column, value, ctx);
      if (display === "text" || !option) return h("span", { class: "ravi-text-value" }, name);
      if (display === "steps" && type === "status" && option.group) return renderSteps(option, msgs);
      return renderPill(option);
    }
    case "multi_select": {
      const items = optionValues(value);
      if (display === "text") return h("span", { class: "ravi-text-value" }, formatValue(column, value, ctx));
      return h(
        "ul",
        { class: "ravi-pills", role: "list" },
        spaced(
          items.map((item) => {
            const option = optionFor(column, item) ?? { name: formatValue({ ...column, type: "select" }, item, ctx), color: "gray" as const };
            return h("li", null, renderPill(option));
          }),
        ),
      );
    }
    case "number": {
      if (typeof value !== "number") return h("span", { class: "ravi-text-value" }, String(value));
      if (role === "rating") {
        const text = formatNumber(value, column, ctx.locale, "number");
        if (display === "stars") return renderRating(value, text, msgs);
        return h("span", { class: "ravi-text-value ravi-number" }, msgs.outOf(text, String(RATING_MAX)));
      }
      if (display === "bar" || display === "ring") {
        const max = numberKind(column) === "percent" ? 1 : 100;
        const text = formatValue(column, value, ctx, display);
        return renderMeter({ value, max, text, shape: display, label: input.labelText });
      }
      if (display === "big") return h("span", { class: "ravi-big" }, formatNumberByColumn(value, column, ctx.locale));
      if (role === "progress") return h("span", { class: "ravi-text-value ravi-number" }, formatValue(column, value, ctx, textDisplay(display, role)));
      return h("span", { class: "ravi-text-value ravi-number" }, formatValue(column, value, ctx, display));
    }
    case "person":
    case "created_by":
    case "updated_by":
      return renderPeople(personRefs(value, ctx.users, ctx.locale), display);
    case "url": {
      const href = safeUrl(value, ["https", "http"]);
      if (role === "image") {
        return href ? h("img", { class: cx("ravi-image", display === "thumb" ? "ravi-thumb" : "ravi-cover"), src: href, alt: "" }) : renderEmpty(msgs);
      }
      if (role === "avatar") {
        return renderAvatar({ name: input.labelText, avatarUrl: href }, { shape: display === "square" ? "square" : "circle", decorative: true });
      }
      const text = typeof value === "string" ? (display === "domain" ? urlDomain(value) : urlText(value)) : "";
      return renderLink(href, text);
    }
    case "date":
    case "created_time":
    case "updated_time": {
      const date = formatDateParts(column, value, ctx, dateDisplay(display));
      return h("span", { class: "ravi-text-value" }, date ? renderDateText(date) : formatValue(column, value, ctx, display));
    }
    case "email":
      return renderLink(mailtoUrl(value), String(value));
    case "phone":
      return renderLink(telUrl(value), String(value));
    case "ref": {
      const refs = refValues(value);
      if (refs.length === 1) return h("span", { class: "ravi-ref" }, refText(refs[0] as (typeof refs)[number]));
      return h("ul", { class: "ravi-refs", role: "list" }, spaced(refs.map((ref) => h("li", null, h("span", { class: "ravi-ref" }, refText(ref))))));
    }
    case "approval": {
      const state = approvalState(value);
      return state
        ? h("span", { class: cx("ravi-badge", `ravi-tone-${APPROVAL_TONES[state]}`), "data-ravi-state": state }, msgs.approvalStates[state])
        : renderEmpty(msgs);
    }
    case "agent": {
      const cell = (value && typeof value === "object" ? value : {}) as { state?: string; value?: unknown; error?: string | null };
      const inner = agentColumn(column);
      const badge =
        cell.state === "pending"
          ? h("span", { class: "ravi-badge ravi-tone-info", "data-ravi-state": "pending" }, msgs.agentPending)
          : cell.state === "error"
            ? h("span", { class: "ravi-badge ravi-tone-danger", "data-ravi-state": "error", title: cell.error || null }, msgs.agentError, cell.error ? h("span", { class: "ravi-sr-only" }, `: ${cell.error}`) : null)
            : null;
      const shown = isEmptyValue(cell.value) ? renderEmpty(msgs) : valueNode({ column: inner, value: cell.value, labelText: input.labelText }, resolveDisplay({ column: inner, rules: ctx.fields }), ctx, msgs);
      return h("span", { class: "ravi-agent" }, shown, badge && " ", badge);
    }
    default:
      return h("span", { class: cx("ravi-text-value", type === "body" && "ravi-body") }, formatValue(column, value, ctx, display));
  }
}

const APPROVAL_TONES = { pending: "warning", approved: "success", rejected: "danger" } as const;

/** The state of an approval value (the API object, or the bare state an optimistic write shows). */
export function approvalState(value: unknown): keyof typeof APPROVAL_TONES | null {
  const state = typeof value === "string" ? value : value && typeof value === "object" ? (value as { state?: unknown }).state : null;
  return state === "pending" || state === "approved" || state === "rejected" ? state : null;
}

/** The column an agent cell's value is shaped like (its `output` type and options). */
function agentColumn(column: RenderColumn): RenderColumn {
  return { ...column, type: column.config?.output ?? "text", config: { options: column.config?.options } };
}

// ---------------------------------------------------------------------------
// Editors

type EditorKind = "select" | "checkbox" | "multi" | "input";

const INPUT_TYPES: Record<string, string> = { text: "text", url: "url", email: "email", phone: "tel", number: "number", date: "date" };

function editorKind(column: RenderColumn, value: unknown, all: boolean | undefined): EditorKind | null {
  if (column.type === "select" || column.type === "status") return "select";
  if (column.type === "checkbox") return "checkbox";
  if (!all) return null;
  if (column.type === "multi_select") return "multi";
  // A date range keeps its display: one input cannot edit both ends.
  if (column.type === "date" && value && typeof value === "object") return null;
  return INPUT_TYPES[column.type] ? "input" : null;
}

/** An instant as `YYYY-MM-DDTHH:mm` in the browser's zone (a `datetime-local` value). */
function localDateTime(value: unknown): string {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The input type and value of an `input` editor. */
function inputFor(column: RenderColumn, value: unknown): { type: string; value: string } {
  if (column.type === "date" && column.config?.includeTime) return { type: "datetime-local", value: localDateTime(value) };
  return { type: INPUT_TYPES[column.type] ?? "text", value: isEmptyValue(value) ? "" : String(value) };
}

function editorOptions(column: RenderColumn, value: unknown, msgs: RuntimeMessages): VElement[] {
  const current = optionFor(column, value);
  const options = (column.config?.options ?? []).filter((option) => !option.archived || option.id === current?.id);
  if (current && !options.some((option) => option.id === current.id)) options.push(current);
  const out: VElement[] = [];
  if (!current || column.type === "select") out.push(h("option", { value: "", selected: !current }, msgs.noValue));
  for (const option of options) out.push(h("option", { value: option.id, selected: option.id === current?.id }, option.name));
  return out;
}

// ---------------------------------------------------------------------------
// The field

export type RenderFieldInput = {
  key: string;
  column: RenderColumn;
  value: unknown;
  role?: FieldRole;
  display?: string;
  label: "hidden" | "visible";
  labelText?: string;
  editable: boolean;
  /** Distinguishes two renders of the same key in one record (for editor ids). */
  uid?: string;
};

/** True when `renderField` would render an editor for this input. */
export function fieldIsEditable(input: Pick<RenderFieldInput, "key" | "column" | "editable"> & { value?: unknown }, ctx: RenderContext): boolean {
  return Boolean(input.editable && ctx.interactive && editorKind(input.column, input.value, ctx.editAll) && ctx.can.write.has(input.key));
}

export function renderField(input: RenderFieldInput, ctx: RenderContext): VElement {
  const msgs = messages(ctx.locale);
  const { key, column } = input;
  const labelText = input.labelText?.trim() || column.name || humanizeKey(key);
  const display = resolveDisplay({ column, role: input.role, override: input.display, rules: ctx.fields });
  const visible = input.label === "visible";
  const root = {
    class: cx("ravi-field", `ravi-display-${display}`, visible && "ravi-field-labeled"),
    "data-ravi-field": key,
    "data-ravi-value": rawValueText(column, input.value),
  };

  const editor = fieldIsEditable(input, ctx) ? editorKind(column, input.value, ctx.editAll) : null;
  if (editor) {
    const id = `${ctx.idPrefix}-${input.uid ?? key}-edit`;
    const label = h("label", { for: id, class: visible ? "ravi-field-label" : "ravi-sr-only" }, labelText);
    const edit = { ...root, class: cx(root.class, "ravi-field-edit") };
    if (editor === "multi") {
      const chosen = optionValues(input.value);
      const options = (column.config?.options ?? []).filter((option) => !option.archived || chosen.includes(option.id));
      return h(
        "fieldset",
        { ...edit, class: cx(edit.class, "ravi-choices") },
        h("legend", { class: visible ? "ravi-field-label" : "ravi-sr-only" }, labelText),
        spaced(
          options.map((option) =>
            h(
              "label",
              null,
              h("input", { type: "checkbox", class: "ravi-checkbox", "data-ravi-edit": key, "data-ravi-opt": option.id, value: option.id, checked: chosen.includes(option.id) }),
              " ",
              option.name,
            ),
          ),
        ),
      );
    }
    if (editor === "input") {
      const shown = inputFor(column, input.value);
      return h(
        "div",
        edit,
        label,
        " ",
        h("input", { type: shown.type, id, class: "ravi-input", "data-ravi-edit": key, value: shown.value, step: column.type === "number" ? "any" : null }),
      );
    }
    if (editor === "checkbox") {
      return h(
        "div",
        { ...root, class: cx(root.class, "ravi-field-edit") },
        h("input", { type: "checkbox", id, class: "ravi-checkbox", "data-ravi-edit": key, checked: input.value === true }),
        " ",
        label,
      );
    }
    const current = optionFor(column, input.value);
    return h(
      "div",
      { ...root, class: cx(root.class, "ravi-field-edit") },
      label,
      " ",
      h(
        "span",
        { class: "ravi-select-wrap" },
        current ? h("span", { class: cx("ravi-dot", `ravi-option-${optionColor(current.color)}`), "aria-hidden": "true" }) : null,
        h("select", { id, class: "ravi-input ravi-select", "data-ravi-edit": key }, editorOptions(column, input.value, msgs)),
      ),
    );
  }

  const value = valueNode({ column, value: input.value, role: input.role, labelText }, display, ctx, msgs);
  if (column.type === "approval" && ctx.interactive && input.editable) {
    const state = approvalState(input.value);
    const button = (to: string, text: string) => h("button", { class: "ravi-button ravi-button-secondary", "data-ravi-decide": key, value: to }, text);
    const buttons = [
      ...(ctx.can.approve?.has(key) && state !== "approved" && state !== "rejected" ? [button("approved", msgs.approve), button("rejected", msgs.reject)] : []),
      ...(ctx.can.write.has(key) && (!state || state === "rejected") ? [button("pending", msgs.requestApproval)] : []),
    ];
    if (buttons.length) {
      return h(
        "div",
        { ...root, class: cx(root.class, "ravi-approval") },
        visible ? h("span", { class: "ravi-field-label" }, labelText) : h("span", { class: "ravi-sr-only" }, `${labelText}: `),
        h("span", { class: "ravi-field-value" }, value),
        " ",
        h("span", { class: "ravi-row ravi-gap-xs" }, spaced(buttons)),
      );
    }
  }
  const role = roleFits(input.role, column) ? input.role : undefined;
  // Lists, steps and meters need flow content; everything else stays phrasing,
  // so a field can sit inside a paragraph.
  const tag = isPhrasing(value) ? "span" : "div";
  // Images in fields are decorative: the card's title names the record.
  const isImage = column.type === "url" && (role === "image" || role === "avatar");
  if (isImage && !visible) return h(tag, root, value);
  return h(
    tag,
    root,
    visible ? h("span", { class: "ravi-field-label" }, labelText) : h("span", { class: "ravi-sr-only" }, `${labelText}: `),
    visible ? " " : null,
    h(tag, { class: "ravi-field-value" }, value),
  );
}

const PHRASING_TAGS = new Set(["span", "a", "img", "abbr", "b", "br", "code", "em", "i", "label", "mark", "s", "small", "strong", "sub", "sup", "time", "button", "input", "select", "meter", "progress", "output"]);

/** True when the node and its descendants are phrasing content (fit inside a `<p>` or `<span>`). */
export function isPhrasing(node: VNode | readonly VNode[]): boolean {
  if (Array.isArray(node)) return (node as readonly VNode[]).every((child) => isPhrasing(child));
  if (typeof node === "string") return true;
  const element = node as VElement;
  return PHRASING_TAGS.has(element.tag) && element.children.every((child) => isPhrasing(child));
}

/** Percent text for a meter of `value` out of `max` (`ravi-progress`). */
export function meterText(value: number, column: RenderColumn, max: number | null, locale: string): string {
  return formatPercentFraction(progressFraction(value, column, max), locale);
}
