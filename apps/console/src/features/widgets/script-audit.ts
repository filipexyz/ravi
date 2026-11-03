// The accessibility audit of a widget with code (JS-CONTRACT J3), run in the
// browser: the widget preview (cards rendered from example.json, light and
// dark, every variant) in an `<iframe sandbox="allow-scripts" srcdoc>`
// (opaque origin, so the code cannot reach the Console), `widget.js`
// mounted on each card with the same `ctx` the Pages runtime gives, then
// axe-core over the document. The frame posts the result back with
// `postMessage`; the parent only accepts a message from that frame's window
// carrying the token it put in the document.
//
// The frame's policy allows inline scripts (the runner and axe-core) and the
// blob URL the module is imported from; it fetches nothing (`default-src
// 'none'`), so code that tries to load something fails in the audit.

import { auditStatusOf } from "@/shared/widgets/script/audit";
import { WIDGET_SCRIPT_FILE } from "@/shared/widgets/script/check";
import { escapeInlineScript } from "@/shared/widgets/script/inline";
import { sha256Hex } from "@/shared/widgets/hash";
import type { CompiledTheme, LibraryFileText, RenderRecord, WidgetFieldSpec, WidgetScriptAuditStatus, WidgetScriptViolation } from "@/shared/widgets/types";

import { framePreviewDocument, widgetPreview, type PreviewView } from "./preview";

export const AUDIT_MESSAGE_TYPE = "ravi-widget-audit";

/** The audit frame's policy: inline scripts and blob modules, nothing fetched. */
export const AUDIT_FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'unsafe-inline' blob:; form-action 'none'";

/** How long a frame may take to answer before the audit counts as failed. */
export const AUDIT_TIMEOUT_MS = 20_000;

/** Time the code gets to draw (async mounts, animation frames) before axe-core runs. */
const SETTLE_MS = 300;

export type ScriptAuditOutcome = {
  status: WidgetScriptAuditStatus;
  violations: WidgetScriptViolation[];
  /** Errors thrown by the code (or the import, or the frame). Any error blocks a publish like a failed audit. */
  errors: string[];
  /** sha256 of the widget.js text the audit ran. */
  scriptSha256: string;
};

/** Whether `outcome` lets the Console publish: a passing audit and no error. */
export function auditAllowsPublish(outcome: ScriptAuditOutcome | null | undefined) {
  return outcome?.status === "pass" && outcome.errors.length === 0;
}

const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * The runner: imports the module from a blob URL, mounts it on every card
 * (`.ravi-preview-frame > li`, record by position) with a frozen ctx,
 * waits, runs axe-core and posts `{ type, token, violations, errors }`.
 */
function runnerScript(token: string, settleMs: number) {
  return `(async () => {
  const token = ${json(token)};
  const errors = [];
  const text = (error) => String((error && error.message) || error);
  const send = (data) => parent.postMessage(Object.assign({ type: ${json(AUDIT_MESSAGE_TYPE)}, token: token, errors: errors }, data), "*");
  const read = (id) => document.getElementById(id).textContent;
  try {
    const records = JSON.parse(read("ravi-audit-records"));
    const fields = JSON.parse(read("ravi-audit-fields"));
    const live = document.getElementById("ravi-audit-live");
    const url = URL.createObjectURL(new Blob([read("ravi-audit-code")], { type: "text/javascript" }));
    let mod;
    try {
      mod = await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    if (typeof mod.mount !== "function") throw new Error("widget.js exports no mount");
    const el = (tag, props, ...children) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props || {})) {
        if (value == null || value === false || /^on/i.test(key)) continue;
        if (key === "style" && typeof value === "object") Object.assign(node.style, value);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value === true ? "" : String(value));
      }
      node.append(...children.flat(Infinity).filter((child) => child != null && child !== false).map((child) => (typeof child === "object" ? child : String(child))));
      return node;
    };
    for (const list of document.querySelectorAll(".ravi-preview-frame")) {
      const pane = list.closest("[data-ravi-mode]");
      const mode = pane && pane.getAttribute("data-ravi-mode") === "dark" ? "dark" : "light";
      Array.from(list.children).forEach((item, index) => {
        const card = item.querySelector("[data-ravi-row]") || item.firstElementChild;
        if (!card) return;
        const record = records[index] || { id: null, values: {} };
        const ctx = Object.freeze({
          record: Object.freeze({ id: record.id, values: Object.freeze(Object.assign({}, record.values)) }),
          fields: fields,
          canvas: (i = 0) => card.querySelector('[data-ravi-canvas="' + Number(i) + '"]'),
          locale: document.documentElement.lang || "pt-BR",
          timeZone: "UTC",
          mode: mode,
          theme: (name) => getComputedStyle(card).getPropertyValue(name).trim(),
          announce: (message) => { live.textContent = String(message); },
          el: el,
          onModeChange: () => () => {},
        });
        try {
          mod.mount(card, ctx);
        } catch (error) {
          errors.push(text(error));
        }
      });
    }
    await new Promise((done) => setTimeout(done, ${Number(settleMs)}));
    const result = await axe.run(document, { resultTypes: ["violations"] });
    send({ violations: result.violations.map((v) => ({ id: v.id, impact: v.impact || null, help: v.help, nodes: v.nodes.length })) });
  } catch (error) {
    errors.push(text(error));
    send({ violations: [] });
  }
})();`;
}

/**
 * The audit frame's document: the preview `html` (from `widgetPreview`) with
 * the audit policy, the widget's code, its records and fields as data, the
 * axe-core source and the runner. `view` hides panes or variants as the
 * plain preview does (axe-core skips what is hidden).
 */
export function auditFrameDocument(input: {
  html: string;
  code: string;
  records: readonly RenderRecord[];
  fields: Record<string, WidgetFieldSpec>;
  axeSource: string;
  token: string;
  view?: Partial<PreviewView>;
  settleMs?: number;
}) {
  const framed = framePreviewDocument(input.html, input.view ?? {}, AUDIT_FRAME_CSP);
  const tail = [
    '<div id="ravi-audit-live" aria-live="polite" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"></div>',
    `<script type="text/plain" id="ravi-audit-code">${escapeInlineScript(input.code)}</script>`,
    `<script type="application/json" id="ravi-audit-records">${json(input.records.map((record) => ({ id: record.id, values: record.values })))}</script>`,
    `<script type="application/json" id="ravi-audit-fields">${json(input.fields)}</script>`,
    `<script>${escapeInlineScript(input.axeSource)}</script>`,
    `<script>${runnerScript(input.token, input.settleMs ?? SETTLE_MS)}</script>`,
  ].join("\n");
  return /<\/body>/i.test(framed) ? framed.replace(/<\/body>/i, `${tail}\n</body>`) : `${framed}\n${tail}`;
}

/** A random token for one frame. */
export function auditToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The outcome from a frame's message, or null when it is not this audit's answer. */
export function readAuditMessage(data: unknown, token: string, scriptSha256: string): ScriptAuditOutcome | null {
  if (!data || typeof data !== "object") return null;
  const message = data as Record<string, unknown>;
  if (message.type !== AUDIT_MESSAGE_TYPE || message.token !== token) return null;
  const violations = (Array.isArray(message.violations) ? message.violations : [])
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .slice(0, 200)
    .map((entry) => ({
      id: String(entry.id ?? "").slice(0, 120),
      impact: typeof entry.impact === "string" && /^(minor|moderate|serious|critical)$/.test(entry.impact) ? entry.impact : null,
      help: String(entry.help ?? "").slice(0, 500),
      nodes: Math.max(0, Math.min(1_000_000, Math.floor(Number(entry.nodes) || 0))),
    }));
  const errors = (Array.isArray(message.errors) ? message.errors : []).slice(0, 20).map((entry) => String(entry).slice(0, 500));
  return { status: auditStatusOf(violations), violations, errors, scriptSha256 };
}

let axeSource: Promise<string> | null = null;

/** axe-core's own source, loaded once and only when an audit runs. */
export function loadAxeSource() {
  axeSource ??= import("axe-core").then((module) => ((module as { default?: { source: string } }).default ?? (module as unknown as { source: string })).source);
  return axeSource;
}

/** What an audit needs from a widget's files, or null when they have no widget.js or do not compile. */
export function auditInput(files: readonly LibraryFileText[], theme: CompiledTheme) {
  const code = files.find((file) => file.path === WIDGET_SCRIPT_FILE)?.content;
  if (code === undefined) return null;
  const preview = widgetPreview({ files, theme });
  if (!preview.html || !preview.widget) return null;
  return { html: preview.html, code, records: preview.records, fields: preview.widget.fields, scriptSha256: sha256Hex(code) };
}

/**
 * Runs the audit of `files` in a frame off screen (laid out, so contrast
 * and sizes are real, but outside the viewport and hidden from assistive
 * technology) and resolves with its outcome. A frame that does not answer
 * in time is an error outcome.
 */
export async function runWidgetAudit(files: readonly LibraryFileText[], theme: CompiledTheme, timeoutMs = AUDIT_TIMEOUT_MS): Promise<ScriptAuditOutcome | null> {
  const input = auditInput(files, theme);
  if (!input) return null;
  const token = auditToken();
  const srcDoc = auditFrameDocument({ ...input, axeSource: await loadAxeSource(), token });
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("tabindex", "-1");
    frame.title = "Auditoria de acessibilidade do widget";
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:960px;height:800px;border:0;";
    const finish = (outcome: ScriptAuditOutcome) => {
      window.removeEventListener("message", listen);
      clearTimeout(timer);
      frame.remove();
      resolve(outcome);
    };
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const outcome = readAuditMessage(event.data, token, input.scriptSha256);
      if (outcome) finish(outcome);
    };
    const timer = setTimeout(
      () => finish({ status: "fail", violations: [], errors: ["A auditoria não respondeu a tempo."], scriptSha256: input.scriptSha256 }),
      timeoutMs,
    );
    window.addEventListener("message", listen);
    frame.srcdoc = srcDoc;
    document.body.appendChild(frame);
  });
}
