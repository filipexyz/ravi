// Static check of a widget's `widget.js` (JS-CONTRACT section 2): one ES module
// of at most 128 KiB, libraries bundled in, that exports `mount`. It imports
// nothing (the page has no module graph for it) and loads no other code. The
// check is best effort: the real guarantees are that only an organization
// owner or admin publishes a widget with code, and the accessibility audit.

import { parse, type Node } from "acorn";

import type { Diagnostic } from "../types";
import { escapeInlineScript } from "./inline";

export const WIDGET_SCRIPT_FILE = "widget.js";
export const MAX_WIDGET_SCRIPT_BYTES = 131072;
/** Diagnostics of one kind past this are summarized in the last one. */
const MAX_PER_CODE = 10;

type AnyNode = Node & Record<string, unknown>;
type Located = { line: number; column: number };

export type WidgetScriptCheck = { diagnostics: Diagnostic[]; bytes: number };

export function checkWidgetScript(source: string): WidgetScriptCheck {
  const diagnostics: Diagnostic[] = [];
  const bytes = new TextEncoder().encode(source).length;
  const counts = new Map<string, number>();
  const report = (code: string, message: string, at: Located | null) => {
    const count = (counts.get(code) ?? 0) + 1;
    counts.set(code, count);
    if (count > MAX_PER_CODE) return;
    diagnostics.push({ severity: "error", code, message, file: WIDGET_SCRIPT_FILE, line: at?.line ?? 1, column: at?.column ?? 1 });
  };

  if (bytes > MAX_WIDGET_SCRIPT_BYTES) {
    report(
      "WIDGET_JS_TOO_LARGE",
      `widget.js is ${bytes} bytes; it holds at most ${MAX_WIDGET_SCRIPT_BYTES} (128 KiB) with its libraries bundled in. Minify it or drop a library.`,
      null,
    );
    return { diagnostics, bytes };
  }

  const program = parseModule(source);
  if (!program.ok) {
    report("WIDGET_JS_SYNTAX", `widget.js is not a valid ES module: ${program.message}.`, program.at);
    return { diagnostics, bytes };
  }
  const escaped = escapeInlineScript(source);
  if (escaped !== source) {
    const again = parseModule(escaped);
    if (!again.ok) {
      report(
        "WIDGET_JS_SYNTAX",
        "widget.js holds </script or <!-- where a backslash changes its meaning (a regular expression with the u or v flag); write \\x3C instead of < there.",
        again.at,
      );
    }
  }

  let mount = false;
  walk(program.node, (node) => {
    const at = startOf(node);
    switch (node.type) {
      case "ImportDeclaration":
        report("WIDGET_JS_IMPORT", "widget.js imports nothing: bundle its libraries into the file (esbuild or bun build).", at);
        break;
      case "ImportExpression":
        report("WIDGET_JS_IMPORT", "widget.js loads no other module: remove import(), bundle what it needs into the file.", at);
        break;
      case "ExportAllDeclaration":
        report("WIDGET_JS_IMPORT", "widget.js re-exports nothing from another module: remove export … from.", at);
        break;
      case "ExportNamedDeclaration": {
        if (node.source) {
          report("WIDGET_JS_IMPORT", "widget.js re-exports nothing from another module: remove export … from.", at);
          break;
        }
        if (exportsMount(node)) mount = true;
        break;
      }
      case "Identifier":
        if (node.name === "importScripts") report("WIDGET_JS_REMOTE", "widget.js loads no other code: remove importScripts.", at);
        break;
      case "NewExpression": {
        const callee = node.callee as AnyNode;
        if (callee.type === "Identifier" && (callee.name === "Worker" || callee.name === "SharedWorker")) {
          report("WIDGET_JS_REMOTE", `widget.js starts no workers: remove new ${String(callee.name)}().`, at);
        }
        break;
      }
      case "Literal":
        if (typeof node.value === "string" && loadsScript(node.value)) report("WIDGET_JS_REMOTE", REMOTE_SCRIPT_MESSAGE, at);
        break;
      case "TemplateElement": {
        const value = node.value as { cooked?: string | null; raw: string };
        if (loadsScript(value.cooked ?? value.raw)) report("WIDGET_JS_REMOTE", REMOTE_SCRIPT_MESSAGE, at);
        break;
      }
    }
  });
  if (!mount) {
    report(
      "WIDGET_JS_NO_MOUNT",
      "widget.js must export mount: export function mount(card, ctx) { … return { update(ctx) {}, destroy() {} }; }",
      null,
    );
  }
  for (const [code, count] of counts) {
    if (count <= MAX_PER_CODE) continue;
    const last = [...diagnostics].reverse().find((diagnostic) => diagnostic.code === code);
    if (last) last.message += ` (${count - MAX_PER_CODE} more like this)`;
  }
  return { diagnostics, bytes };
}

const REMOTE_SCRIPT_MESSAGE = "widget.js loads no other code: remove the <script src=…> markup.";

function loadsScript(text: string) {
  return /<script/i.test(text) && /\bsrc\s*=/i.test(text);
}

function exportsMount(node: AnyNode) {
  const declaration = node.declaration as AnyNode | null;
  if (declaration) {
    if (declaration.type === "FunctionDeclaration") return (declaration.id as AnyNode | null)?.name === "mount";
    if (declaration.type === "VariableDeclaration") {
      return (declaration.declarations as AnyNode[]).some((entry) => (entry.id as AnyNode).type === "Identifier" && (entry.id as AnyNode).name === "mount");
    }
    return false;
  }
  return ((node.specifiers as AnyNode[] | undefined) ?? []).some((specifier) => {
    const exported = specifier.exported as AnyNode;
    return exported.type === "Identifier" ? exported.name === "mount" : exported.value === "mount";
  });
}

function parseModule(source: string): { ok: true; node: AnyNode } | { ok: false; message: string; at: Located | null } {
  try {
    return { ok: true, node: parse(source, { ecmaVersion: "latest", sourceType: "module", locations: true }) as unknown as AnyNode };
  } catch (error) {
    const loc = (error as { loc?: { line: number; column: number } }).loc;
    const message = error instanceof Error ? error.message.replace(/\s*\(\d+:\d+\)$/, "") : "unreadable";
    return { ok: false, message, at: loc ? { line: loc.line, column: loc.column + 1 } : null };
  }
}

function startOf(node: AnyNode): Located | null {
  const loc = node.loc as { start: { line: number; column: number } } | undefined;
  return loc ? { line: loc.start.line, column: loc.start.column + 1 } : null;
}

/** Visits every node of an ESTree, parents first. */
function walk(root: AnyNode, visit: (node: AnyNode) => void) {
  const stack: AnyNode[] = [root];
  while (stack.length) {
    const node = stack.pop() as AnyNode;
    visit(node);
    const children: AnyNode[] = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) {
        for (const entry of value) if (isNode(entry)) children.push(entry);
      } else if (isNode(value)) children.push(value);
    }
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index] as AnyNode);
  }
}

function isNode(value: unknown): value is AnyNode {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
