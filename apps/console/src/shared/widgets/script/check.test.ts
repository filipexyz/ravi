import { describe, expect, test } from "bun:test";

import { checkWidgetScript, MAX_WIDGET_SCRIPT_BYTES } from "./check";
import { escapeInlineScript, widgetScriptElementId } from "./inline";

const codes = (source: string) => checkWidgetScript(source).diagnostics.map((diagnostic) => diagnostic.code);

describe("checkWidgetScript", () => {
  test("a module exporting mount passes, as a function, a const or a specifier", () => {
    expect(codes("export function mount(card, ctx) { return {}; }")).toEqual([]);
    expect(codes("export const mount = (card) => ({ destroy() {} });")).toEqual([]);
    expect(codes("function draw() {}\nexport { draw as mount };")).toEqual([]);
    expect(checkWidgetScript("export function mount() {}").bytes).toBe(26);
  });

  test("WIDGET_JS_NO_MOUNT without a named mount export", () => {
    expect(codes("export default function mount() {}")).toEqual(["WIDGET_JS_NO_MOUNT"]);
    expect(codes("function mount() {}")).toEqual(["WIDGET_JS_NO_MOUNT"]);
  });

  test("WIDGET_JS_SYNTAX with line and column", () => {
    const [diagnostic] = checkWidgetScript("export function mount() {\n  return {;\n}").diagnostics;
    expect(diagnostic).toMatchObject({ severity: "error", code: "WIDGET_JS_SYNTAX", file: "widget.js", line: 2 });
    expect(diagnostic?.column).toBeGreaterThan(1);
  });

  test("WIDGET_JS_TOO_LARGE past 128 KiB, counted in UTF-8 bytes", () => {
    const filler = `// ${"é".repeat(MAX_WIDGET_SCRIPT_BYTES / 2)}\nexport function mount() {}`;
    expect(codes(filler)).toEqual(["WIDGET_JS_TOO_LARGE"]);
  });

  test("WIDGET_JS_IMPORT for import declarations, import() and export from", () => {
    expect(codes('import x from "lib";\nexport function mount() {}')).toEqual(["WIDGET_JS_IMPORT"]);
    expect(codes('export function mount() { import("https://cdn.example/x.js"); }')).toEqual(["WIDGET_JS_IMPORT"]);
    expect(codes('export * from "lib";\nexport function mount() {}')).toEqual(["WIDGET_JS_IMPORT"]);
    expect(codes('export { a } from "lib";\nexport function mount() {}')).toEqual(["WIDGET_JS_IMPORT"]);
  });

  test("WIDGET_JS_REMOTE for script markup with src, importScripts and workers", () => {
    expect(codes('export function mount(c) { c.innerHTML = "<SCRIPT src=x.js></script>"; }')).toEqual(["WIDGET_JS_REMOTE"]);
    expect(codes("export function mount(c) { c.innerHTML = `<script src=${1}>`; }")).toEqual(["WIDGET_JS_REMOTE"]);
    expect(codes("export function mount() { importScripts('a.js'); }")).toEqual(["WIDGET_JS_REMOTE"]);
    expect(codes("export function mount() { new Worker('w.js'); }")).toEqual(["WIDGET_JS_REMOTE"]);
    // A script tag without src is fine (best effort only).
    expect(codes('export function mount() { return "<script>"; }')).toEqual([]);
  });

  test("code whose escaped inline form no longer parses is refused", () => {
    expect(codes("export function mount() { return /<!--/u.test('x'); }")).toEqual(["WIDGET_JS_SYNTAX"]);
    expect(codes("export function mount() { return /<!--/.test('x') + '</script>'; }")).toEqual([]);
  });

  test("repeated findings are capped with a count", () => {
    const source = `${Array.from({ length: 14 }, (_, index) => `import a${index} from "m${index}";`).join("\n")}\nexport function mount() {}`;
    const imports = checkWidgetScript(source).diagnostics.filter((diagnostic) => diagnostic.code === "WIDGET_JS_IMPORT");
    expect(imports).toHaveLength(10);
    expect(imports[9]?.message).toContain("4 more like this");
  });
});

describe("escapeInlineScript", () => {
  test("keeps </script and <!-- from changing how HTML reads the element", () => {
    expect(escapeInlineScript('a = "</script><!--"; b = "</SCRIPT"')).toBe('a = "<\\/script><\\!--"; b = "<\\/SCRIPT"');
    // The escaped text means the same thing to JavaScript.
    const escaped = escapeInlineScript('"</script><!--"');
    expect(new Function(`return ${escaped}`)()).toBe("</script><!--");
  });

  test("element id from the first 16 hex of the sha", () => {
    expect(widgetScriptElementId("0123456789abcdef0123")).toBe("ravi-widget-js-0123456789abcdef");
  });
});
