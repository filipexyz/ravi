// `<ravi-form>`, the form layout and create dialog of `<ravi-view>`, and the
// record dialog: a native form from the describe columns the viewer may
// write. Types: text, number, date, checkbox, select, status, multi_select,
// url, email, phone and the body (a textarea); person and ref are left out.
// Required fields are checked here; `fieldErrors` from the server land under
// their field through `aria-describedby` and `aria-invalid`; other errors go
// to the top. With `initial` values (the record dialog) the controls start
// from them, a cleared field sends null, and only changed fields are sent.

import type { BaseViewColumn } from "@/shared/bases/types";

import { el } from "./dom";
import { asRaviError } from "./errors";
import type { Mounted, Rt } from "./runtime";
import { openDialog, type DialogHandle } from "./ui";
import type { View, ViewRow } from "./view";

const FORM_TYPES = /^(text|number|date|checkbox|select|status|multi_select|url|email|phone|body)$/;
const INPUT_TYPES: Record<string, string> = { number: "number", url: "url", email: "email", phone: "tel", checkbox: "checkbox" };

/** `[column, controls, error node, read, raw state at build]`. */
type FormField = [column: BaseViewColumn, controls: HTMLElement[], error: HTMLElement, read: () => unknown, raw: string];

/** What the controls show, to tell an edited field from an untouched one. */
const rawOf = (controls: HTMLElement[]) => controls.map((control) => ((control as HTMLInputElement).type == "checkbox" ? String((control as HTMLInputElement).checked) : (control as HTMLInputElement).value)).join("\n");

/** Columns a create form shows: writable, of a v1 type, in `keys` order when given. */
export function formColumns(columns: readonly BaseViewColumn[], writable: readonly string[], keys?: string[] | null): BaseViewColumn[] {
  const allowed = columns.filter((column) => writable.includes(column.key) && FORM_TYPES.test(column.type));
  return keys?.length ? keys.flatMap((key) => allowed.filter((column) => column.key == key)) : allowed;
}

/**
 * A create form. `submit` writes the values (quietly) and resolves with the
 * row, or null when a `ravi:beforewrite` listener canceled it; `done` runs on
 * success. Failures stay in the form (focus on the first field in error);
 * session, paused and denied also reach the status line. While saving, the
 * submit button keeps its focus and further submits are ignored.
 */
export function buildForm(
  rt: Rt,
  columns: BaseViewColumn[],
  prefix: string,
  submitLabel: string,
  submit: (values: Record<string, unknown>) => Promise<ViewRow | null>,
  done: (form: HTMLFormElement) => void,
  initial?: Record<string, unknown> | null,
): HTMLFormElement {
  const { doc, msgs } = rt;
  const wraps: HTMLElement[] = [];
  const start = (key: string) => initial?.[key] ?? null;
  const fields = columns.map((column, index): FormField => {
    const id = `${prefix}-f${index}`;
    const { type, required, key } = column;
    const error = el(doc, "span", { className: "ravi-error", id: `${id}-error`, hidden: true });
    const name = [column.name, required && el(doc, "span", { "aria-hidden": "true" }, " *")];
    const value = start(key);
    const chosen = Array.isArray(value) ? value : value == null ? [] : [value];
    const options = (column.config?.options ?? []).filter((option) => !option.archived || chosen.includes(option.id));
    if (type == "multi_select") {
      const boxes = options.map((option) => el(doc, "input", { type: "checkbox", name: key, value: option.id, className: "ravi-checkbox", checked: chosen.includes(option.id) }) as HTMLInputElement);
      wraps.push(
        el(doc, "fieldset", { className: "ravi-form-field" }, el(doc, "legend", null, name), boxes.map((box, at) => el(doc, "label", null, box, " ", options[at]?.name)), error),
      );
      return [column, boxes, error, () => boxes.filter((box) => box.checked).map((box) => box.value), rawOf(boxes)];
    }
    const local = type == "date" && column.config?.includeTime;
    const control = (
      /^(select|status)$/.test(type)
        ? el(
            doc,
            "select",
            { id, name: key, className: "ravi-input", required },
            (type == "select" || !required || (initial && value == null)) && el(doc, "option", { value: "" }, msgs.noValue),
            options.map((option) => el(doc, "option", { value: option.id, selected: option.id == value }, option.name)),
          )
        : type == "body"
          ? el(doc, "textarea", { id, name: key, className: "ravi-input", rows: 6, required, value: value ?? "" })
          : el(doc, "input", {
              id,
              name: key,
              type: INPUT_TYPES[type] ?? (type == "date" ? (local ? "datetime-local" : "date") : "text"),
              className: type == "checkbox" ? "ravi-checkbox" : "ravi-input",
              required,
              step: type == "number" ? "any" : null,
              checked: value === true,
              // A date range shows its start; the record dialog then writes one date.
              value: type == "checkbox" || value == null ? null : local ? localInput(value) : String((value as { start?: unknown }).start ?? value),
            })
    ) as HTMLInputElement;
    wraps.push(
      el(
        doc,
        "div",
        { className: "ravi-form-field" },
        type == "checkbox" ? el(doc, "label", { htmlFor: id }, control, " ", name) : el(doc, "label", { htmlFor: id }, el(doc, "span", null, name), control),
        error,
      ),
    );
    return [
      column,
      [control],
      error,
      () => {
        if (type == "checkbox") return control.checked;
        const value = control.value.trim();
        return !value ? undefined : type == "number" && isFinite(+value) ? +value : local ? new Date(value).toISOString() : value;
      },
      rawOf([control]),
    ];
  });
  const top = el(doc, "p", { className: "ravi-error", tabIndex: -1, hidden: true });
  const button = el(doc, "button", { type: "submit", className: "ravi-button ravi-button-primary" }, submitLabel) as HTMLButtonElement;
  const setError = ([, controls, error]: FormField, message?: string | null) => {
    error.textContent = message ?? "";
    error.hidden = !message;
    for (const control of controls) {
      if (message) {
        control.setAttribute("aria-invalid", "true");
        control.setAttribute("aria-describedby", error.id);
      } else {
        control.removeAttribute("aria-invalid");
        control.removeAttribute("aria-describedby");
      }
    }
  };
  const form = el(doc, "form", { className: "ravi-form", noValidate: true }, top, wraps, button) as HTMLFormElement;
  const focus = (field?: FormField) => ((field?.[1][0] ?? top) as HTMLElement).focus();
  let busy = false;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    top.hidden = true;
    const values: Record<string, unknown> = {};
    let invalid: FormField | undefined;
    for (const field of fields) {
      const value = field[3]();
      const missing = field[0].required && (value === undefined || value === false || (Array.isArray(value) && !value.length));
      setError(field, missing ? msgs.required : null);
      if (missing) invalid ??= field;
      else if (initial) {
        if (rawOf(field[1]) != field[4]) values[field[0].key] = value ?? null;
      } else if (value !== undefined && !(Array.isArray(value) && !value.length)) values[field[0].key] = value;
    }
    if (invalid) {
      focus(invalid);
      return rt.announce(msgs.invalid);
    }
    // Nothing edited in the record dialog: nothing to send.
    if (initial && !Object.keys(values).length) return done(form);
    // `aria-disabled`, not `disabled`: disabling the focused button would drop
    // the focus of the person who pressed it to the page.
    const pressed = doc.activeElement == button;
    busy = true;
    button.setAttribute("aria-disabled", "true");
    form.setAttribute("aria-busy", "true");
    submit(values)
      .then((row) => row && done(form))
      .catch((thrown: unknown) => {
        const error = asRaviError(thrown);
        const unplaced: string[] = [];
        let first: FormField | undefined;
        for (const [key, message] of Object.entries(error.fieldErrors ?? {})) {
          const field = fields.find((candidate) => candidate[0].key == key);
          if (field) {
            setError(field, message);
            first ??= field;
          } else unplaced.push(message);
        }
        const text = unplaced.join(" ") || (error.kind != "invalid" ? msgs.submitFailed : first ? "" : msgs.invalid);
        top.textContent = text;
        top.hidden = !text;
        if (/^(session|paused|denied|consent)$/.test(error.kind)) rt.show(error, { op: "create" });
        else rt.announce(text || msgs.invalid);
        focus(first);
      })
      .finally(() => {
        busy = false;
        button.removeAttribute("aria-disabled");
        form.removeAttribute("aria-busy");
        // Focus lost on the way (it is on the page, not on a field or the opener): back on the button.
        if (pressed && button.isConnected && (!doc.activeElement || doc.activeElement == doc.body)) button.focus();
      });
  });
  return form;
}

/** An instant as a `datetime-local` value in the browser's zone. */
function localInput(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `<ravi-view create>`: the create form in a dialog; resolves when the dialog closes. */
export function openCreateDialog(rt: Rt, view: View, target: EventTarget, prefix: string): Promise<string | null> {
  const { msgs } = rt;
  const info = view.info;
  if (!info) return Promise.resolve(null);
  let handle: DialogHandle | undefined;
  const form = buildForm(
    rt,
    formColumns(info.columns, info.capabilities.writeColumns),
    prefix,
    msgs.confirmAction("create"),
    (values) => view.create(values, { target, quiet: true }),
    () => {
      rt.announce(msgs.saved);
      handle?.close("saved");
    },
  );
  handle = openDialog(rt.doc, { title: msgs.newItem, content: [form], actions: [[msgs.cancel, "cancel"]] });
  return handle.done;
}

/**
 * A create form for `view` with its success line, or null when the viewer
 * may not create (or may write none of the fields): `<ravi-form>` and the
 * form layout of `<ravi-view>`.
 */
export function createForm(rt: Rt, view: View, target: EventTarget, prefix: string, opts: { fields?: string[]; submitLabel?: string | null; success?: string | null }): HTMLElement[] | null {
  const { doc, msgs } = rt;
  const info = view.info;
  const columns = info ? formColumns(info.columns, info.capabilities.writeColumns, opts.fields) : [];
  if (!view.can("create") || !columns.length) return null;
  const success = el(doc, "p", { className: "ravi-status", hidden: true });
  return [
    buildForm(
      rt,
      columns,
      prefix,
      opts.submitLabel || msgs.submit,
      (values) => {
        success.hidden = true;
        return view.create(values, { target, quiet: true });
      },
      (form) => {
        form.reset();
        success.textContent = opts.success || msgs.submitted;
        success.hidden = false;
        rt.announce(success.textContent);
      },
    ),
    success,
  ];
}

/** The `<ravi-form>` element. */
export function mountForm(rt: Rt, host: HTMLElement): Mounted {
  const { doc, msgs } = rt;
  const attr = (name: string) => host.getAttribute(name)?.trim();
  const say = (text: string) => host.replaceChildren(el(doc, "p", { className: "ravi-status", role: "status" }, text));
  const id = attr("data-ravi-id") ?? "";
  const first = (async () => {
    try {
      const view = rt.view(attr("view") ?? rt.kit.instances[id]?.view ?? "");
      await view.describe();
      const form = createForm(rt, view, host, id ? `ravi-${id}` : rt.uid("form"), {
        fields: attr("fields")
          ?.split(",")
          .map((key) => key.trim())
          .filter(Boolean),
        submitLabel: attr("submit-label"),
        success: attr("success"),
      });
      if (!form) return say(msgs.noPermission);
      host.replaceChildren(...form);
    } catch (thrown) {
      const error = asRaviError(thrown);
      rt.report(error, { target: host, op: "read" });
      say(rt.capture ? msgs.capture : rt.stateText(error));
    }
  })().finally(() => rt.fire(host, "ravi:render", {}));
  return { first };
}
