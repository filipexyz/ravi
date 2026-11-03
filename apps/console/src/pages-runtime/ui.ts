// The runtime's own UI: one polite live region, the status line (closed
// shadow root, bottom center, labeled "esta página"; session expiry, paused
// data and errors only, never an approve button), native `<dialog>`s with a
// focus trap, and menu buttons ("Mover para…") with arrow keys and Esc.

import type { RuntimeMessages } from "@/shared/widgets/render/messages";

import { el, FOCUSABLE, sel, type ElChild } from "./dom";

const mount = (doc: Document, node: Element) => (doc.body ?? doc.documentElement).append(node);

let seq = 0;

/** One visually hidden `aria-live="polite"` region; each message is a new node, so repeats are read again. */
export type Announcer = { ensure(): HTMLElement; say(text: string): void };

export function createAnnouncer(doc: Document): Announcer {
  let region: HTMLElement | null = null;
  const ensure = () => {
    if (!region?.isConnected) {
      region = el(doc, "div", { className: "ravi-live ravi-sr-only", "aria-live": "polite", "data-ravi-live": "" });
      // Visually hidden even on a page without the pieces stylesheet.
      region.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap";
      mount(doc, region);
    }
    return region;
  };
  return { ensure, say: (text) => text && ensure().replaceChildren(el(doc, "p", null, text)) };
}

export type StatusState = "error" | "paused" | "session";

/** The status line. `root` is the closed shadow root once shown (kept for the runtime's own tests). */
export type StatusLine = {
  root: ShadowRoot | null;
  /** Shows `text`; a lower-ranked state (error < paused < session) never replaces a higher one. */
  show(state: StatusState, text: string, action?: { label: string; run: () => void }): void;
  hide(): void;
};

const STATUS_CSS =
  ":host{all:initial}section{position:fixed;z-index:2147483000;bottom:16px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 32px);box-sizing:border-box;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 14px;border-radius:12px;background:var(--color-background-inverse,#1f2328);color:var(--color-text-inverse,#fff);font:14px/1.4 var(--font-sans,system-ui,sans-serif);border:1px solid transparent}section[hidden]{display:none}p{margin:0}button{font:inherit;min-height:24px;padding:4px 10px;border:1px solid;border-radius:8px;background:none;color:inherit;cursor:pointer}";

export function createStatus(doc: Document, msgs: RuntimeMessages, reload: () => void): StatusLine {
  let region: HTMLElement | null = null;
  let rank = 0;
  const line: StatusLine = {
    root: null,
    show(state, text, action) {
      const next = ["error", "paused", "session"].indexOf(state) + 1;
      if (rank > next) return;
      if (!region) {
        const host = el(doc, "div", { "data-ravi-status": "" });
        line.root = host.attachShadow({ mode: "closed" });
        line.root.append(el(doc, "style", null, STATUS_CSS), (region = el(doc, "section", { "aria-label": msgs.statusRegion })));
        mount(doc, host);
      }
      const button = (label: string, run: () => void) => el(doc, "button", { type: "button", onClick: run }, label);
      region.replaceChildren(
        el(doc, "p", { role: state == "paused" ? "status" : "alert" }, text),
        ...[
          state == "session" && button(msgs.continue, reload),
          action &&
            button(action.label, () => {
              line.hide();
              action.run();
            }),
          state == "error" && button(msgs.close, line.hide),
        ].filter((node): node is HTMLElement => !!node),
      );
      region.hidden = false;
      rank = next;
    },
    hide() {
      region?.replaceChildren();
      if (region) region.hidden = true;
      rank = 0;
    },
  };
  return line;
}

// ---------------------------------------------------------------------------
// Dialogs

/** `[label, value, variant]`; the value `cancel` resolves `null`. */
export type DialogAction = [label: string, value: string, variant?: "primary" | "danger"];

export type DialogHandle = { element: HTMLElement; done: Promise<string | null>; close: (value: string | null) => void };

/**
 * A modal native `<dialog>` named by its heading and described by `text`
 * (the confirmation, built from the action). Tab stays inside, Esc cancels
 * (`null`), and focus returns to the element that had it. Actions resolve
 * `done` with their value; `focus` names the action focused first.
 */
export function openDialog(doc: Document, spec: { title: string; text?: string; content?: ElChild[]; actions: DialogAction[]; focus?: string }): DialogHandle {
  const id = `ravi-dialog-${(seq += 1)}`;
  const opener = doc.activeElement as HTMLElement | null;
  let resolve!: (value: string | null) => void;
  const done = new Promise<string | null>((ok) => (resolve = ok));
  const close = (value: string | null) => {
    if (!dialog.isConnected) return;
    if ((dialog as HTMLDialogElement).open) (dialog as HTMLDialogElement).close?.();
    dialog.remove();
    opener?.focus?.();
    resolve(value);
  };
  const dialog = el(
    doc,
    "dialog",
    {
      className: "ravi-dialog",
      "aria-labelledby": id,
      "aria-describedby": spec.text ? `${id}-text` : null,
      onCancel: (event: Event) => {
        event.preventDefault();
        close(null);
      },
      onKeydown: (event: KeyboardEvent) => {
        if (event.key == "Escape") {
          event.preventDefault();
          close(null);
        } else if (event.key == "Tab") {
          const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
          const first = items[0];
          const last = items[items.length - 1];
          const edge = event.shiftKey ? first : last;
          if (edge && (doc.activeElement == edge || !dialog.contains(doc.activeElement))) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus();
          }
        }
      },
      onClick: (event: Event) => {
        const value = (event.target as Element).closest?.("[data-ravi-dialog]")?.getAttribute("data-ravi-dialog");
        if (value) close(value == "cancel" ? null : value);
      },
    },
    el(doc, "h2", { id, className: "ravi-title" }, spec.title),
    spec.text && el(doc, "p", { id: `${id}-text` }, spec.text),
    spec.content,
    el(
      doc,
      "div",
      { className: "ravi-dialog-actions" },
      spec.actions.map(([label, value, variant]) =>
        el(doc, "button", { type: "button", className: `ravi-button ravi-button-${variant ?? "secondary"}`, "data-ravi-dialog": value }, label),
      ),
    ),
  );
  mount(doc, dialog);
  if ((dialog as HTMLDialogElement).showModal) (dialog as HTMLDialogElement).showModal();
  else dialog.setAttribute("open", "");
  ((spec.focus && dialog.querySelector<HTMLElement>(sel("data-ravi-dialog", spec.focus))) || dialog.querySelector<HTMLElement>(FOCUSABLE))?.focus();
  return { element: dialog, done, close };
}

// ---------------------------------------------------------------------------
// Menu button

/** `[label, run]`. */
export type MenuItem = [label: string, run: () => void];

/**
 * Opens a menu next to `button` (which gets `aria-expanded`): arrow keys,
 * Home/End move, Enter/Space/click choose, Esc closes and focuses the button,
 * Tab or a pointer outside closes. Resolves once closed.
 */
export function openMenu(doc: Document, button: HTMLElement, label: string, items: MenuItem[], focusLast = false): Promise<void> {
  const parent = button.parentElement;
  if (!parent || !items.length) return Promise.resolve();
  const id = `ravi-menu-${(seq += 1)}`;
  let resolve!: () => void;
  const closed = new Promise<void>((ok) => (resolve = ok));
  const close = (refocus?: boolean) => {
    if (!menu.isConnected) return;
    menu.remove();
    button.setAttribute("aria-expanded", "false");
    button.removeAttribute("aria-controls");
    doc.removeEventListener("pointerdown", outside, true);
    if (refocus) button.focus();
    resolve();
  };
  const outside = (event: Event) => {
    if (!menu.contains(event.target as Node) && event.target != button) close();
  };
  const entries = items.map(([text]) => el(doc, "button", { type: "button", tabIndex: -1, role: "menuitem" }, text));
  const move = (index: number) => entries[(index + entries.length) % entries.length]?.focus();
  const menu = el(
    doc,
    "ul",
    {
      className: "ravi-menu",
      id,
      role: "menu",
      "aria-label": label,
      onKeydown: (event: KeyboardEvent) => {
        const index = entries.indexOf(doc.activeElement as HTMLElement);
        const to = ({ ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: -1 } as Record<string, number>)[event.key];
        if (to !== undefined) move(to);
        else if (event.key == "Escape") close(true);
        else return event.key == "Tab" && close();
        event.preventDefault();
        event.stopPropagation();
      },
      onClick: (event: Event) => {
        const index = entries.indexOf((event.target as Element).closest("[role=menuitem]") as HTMLElement);
        if (index < 0) return;
        close(true);
        items[index]?.[1]();
      },
    },
    entries.map((entry) => el(doc, "li", { role: "none" }, entry)),
  );
  parent.style.position ||= "relative";
  parent.append(menu);
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-controls", id);
  doc.addEventListener("pointerdown", outside, true);
  move(focusLast ? -1 : 0);
  return closed;
}
