import { describe, expect, test } from "bun:test";
import * as acorn from "acorn";

import { starterFiles } from "./kind-files";
import { AUDIT_FRAME_CSP, AUDIT_MESSAGE_TYPE, auditAllowsPublish, auditFrameDocument, auditInput, readAuditMessage } from "./script-audit";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";
import { sha256Hex } from "@/shared/widgets/hash";

const CODE = "export function mount(card, ctx) { ctx.canvas().textContent = '</script><!-- x'; }";

function withScript(code = CODE) {
  return starterFiles("widget")
    .map((file) => (file.path === "widget.html" ? { ...file, content: file.content.replace("</ravi-card>", '<ravi-canvas label="Gráfico"></ravi-canvas></ravi-card>') } : file))
    .concat({ path: "widget.js", content: code });
}

function frameDoc(token = "t0k3n") {
  const input = auditInput(withScript(), defaultCompiledTheme());
  if (!input) throw new Error("starter widget with code did not compile");
  return { input, doc: auditFrameDocument({ ...input, axeSource: "window.axe = { run: async () => ({ violations: [] }) };", token }) };
}

describe("audit frame document", () => {
  test("the starter widget with code compiles to an audit input with its records and the script's sha", () => {
    const { input } = frameDoc();
    expect(input.scriptSha256).toBe(sha256Hex(CODE));
    expect(input.records.length).toBeGreaterThan(0);
    expect(input.html).toContain('class="ravi-canvas"');
    expect(auditInput(starterFiles("widget"), defaultCompiledTheme())).toBeNull();
  });

  test("carries the audit CSP, the escaped code, the records as data, axe-core and a runner that parses", () => {
    const { doc, input } = frameDoc();
    expect(doc).toContain(`content="${AUDIT_FRAME_CSP}"`);
    expect(AUDIT_FRAME_CSP).toContain("default-src 'none'");
    expect(AUDIT_FRAME_CSP).not.toContain("connect-src");
    // The code cannot close its element or open an HTML comment.
    const code = doc.slice(doc.indexOf('id="ravi-audit-code">') + 'id="ravi-audit-code">'.length, doc.indexOf("</script>", doc.indexOf('id="ravi-audit-code">')));
    expect(code).toBe(CODE.replace("</script", "<\\/script").replace("<!--", "<\\!--"));
    expect(doc).toContain('id="ravi-audit-records"');
    expect(doc).toContain(JSON.stringify(input.records[0]?.id ?? null));
    expect(doc).toContain("window.axe = {");
    const scripts = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? "");
    const runner = scripts.at(-1) ?? "";
    expect(runner).toContain('"t0k3n"');
    expect(runner).toContain(AUDIT_MESSAGE_TYPE);
    expect(() => acorn.parse(runner, { ecmaVersion: "latest", sourceType: "script" })).not.toThrow();
    expect(doc.indexOf("ravi-audit-code")).toBeLessThan(doc.indexOf("</body>"));
  });

  test("hides panes like the plain preview for one mode", () => {
    const { input } = frameDoc();
    const doc = auditFrameDocument({ ...input, axeSource: "", token: "x", view: { mode: "dark" } });
    expect(doc).toContain('<html data-theme="dark"');
    expect(doc).toContain('.ravi-preview-pane[data-ravi-mode="light"]');
  });
});

describe("audit messages", () => {
  const sha = "a".repeat(64);
  test("only this frame's token is read; impacts outside axe's list become null; status follows serious and critical", () => {
    expect(readAuditMessage({ type: AUDIT_MESSAGE_TYPE, token: "other", violations: [] }, "tok", sha)).toBeNull();
    expect(readAuditMessage({ type: "else", token: "tok" }, "tok", sha)).toBeNull();
    expect(readAuditMessage("nope", "tok", sha)).toBeNull();
    const pass = readAuditMessage({ type: AUDIT_MESSAGE_TYPE, token: "tok", violations: [{ id: "region", impact: "moderate", help: "Landmarks", nodes: 2 }], errors: [] }, "tok", sha);
    expect(pass).toEqual({ status: "pass", violations: [{ id: "region", impact: "moderate", help: "Landmarks", nodes: 2 }], errors: [], scriptSha256: sha });
    expect(auditAllowsPublish(pass)).toBe(true);
    const fail = readAuditMessage(
      { type: AUDIT_MESSAGE_TYPE, token: "tok", violations: [{ id: "color-contrast", impact: "serious", help: "Contrast", nodes: 3.7 }, { id: "x", impact: "<b>", help: 1, nodes: -1 }] },
      "tok",
      sha,
    );
    expect(fail?.status).toBe("fail");
    expect(fail?.violations[1]).toEqual({ id: "x", impact: null, help: "1", nodes: 0 });
    expect(fail?.violations[0]?.nodes).toBe(3);
    expect(auditAllowsPublish(fail)).toBe(false);
  });

  test("an error thrown by the code blocks a publish even with no violation", () => {
    const outcome = readAuditMessage({ type: AUDIT_MESSAGE_TYPE, token: "tok", violations: [], errors: ["boom"] }, "tok", sha);
    expect(outcome?.status).toBe("pass");
    expect(auditAllowsPublish(outcome)).toBe(false);
    expect(auditAllowsPublish(null)).toBe(false);
  });
});
