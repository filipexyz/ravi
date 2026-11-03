import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { WorkspaceProvider, type Workspace } from "@/features/shell/workspace";

import { starterFiles, type EditorFile } from "./kind-files";
import { act, click, installTestDom, render, waitFor } from "./test-dom";
import { PREVIEW_DELAY_MS, WidgetFilesEditor, widgetFileInputId, type KindEditorHandle } from "./widget-editor";

installTestDom();

const WORKSPACE = { organization: { id: "org_test", name: "Acme", slug: "acme", plan: "team", role: "owner", mark: "A", color: "blue" } } as unknown as Workspace;
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ org: null, project: null, effective: null, warnings: [] }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const CODE = "export function mount(card, ctx) {\n  ctx.canvas().textContent = 'ok';\n}\n";
const withCanvas = (files: EditorFile[]) =>
  files.map((file) => (file.path === "widget.html" ? { ...file, content: file.content.replace("</ravi-card>", '<ravi-canvas label="Gráfico"></ravi-canvas></ravi-card>') } : file));

async function renderEditor(initial: EditorFile[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handle: { current: KindEditorHandle | null } = { current: null };
  const changes: EditorFile[][] = [];
  function Host() {
    const [files, setFiles] = useState(initial);
    return (
      <WidgetFilesEditor
        files={files}
        onChange={(next) => {
          changes.push(next);
          setFiles(next);
        }}
        project={null}
        ref={(value) => {
          handle.current = value;
        }}
      />
    );
  }
  const view = await render(
    <QueryClientProvider client={client}>
      <WorkspaceProvider value={WORKSPACE}>
        <Host />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  const tabs = () => [...view.container.querySelectorAll("[role=tab]")];
  const panel = (path: string) => view.container.querySelector(`[id="widget-files-panel-${path}"]`) as HTMLElement | null;
  return { ...view, handle, changes, tabs, panel };
}

describe("WidgetFilesEditor", () => {
  test("one tab per file, widget.js among them; a diagnostic in widget.js switches to its tab", async () => {
    const view = await renderEditor(starterFiles("widget"));
    expect(view.tabs().map((tab) => tab.textContent)).toEqual(["widget.html", "widget.json", "example.json", "widget.js", "README.md"]);
    expect(view.panel("widget.html")?.hidden).toBe(false);
    expect(view.panel("widget.js")?.hidden).toBe(true);
    expect(view.panel("widget.js")?.querySelector(`[id="${widgetFileInputId("widget.js")}"]`)).not.toBeNull();
    await act(() => view.handle.current?.focusDiagnostic({ severity: "error", code: "WIDGET_JS_SYNTAX", message: "x", file: "widget.js", line: 1 }));
    expect(view.panel("widget.js")?.hidden).toBe(false);
    expect(view.tabs()[3]?.getAttribute("aria-selected")).toBe("true");
    // Without widget.js the preview frame runs no script, and there is nothing to audit.
    await waitFor(() => view.container.querySelector("iframe") !== null, PREVIEW_DELAY_MS + 2000);
    expect(view.container.querySelector("iframe")?.getAttribute("sandbox")).toBe("");
    expect(await view.handle.current?.audit?.()).toBeNull();
    await view.unmount();
  });

  test("with widget.js the preview frame may run scripts (opaque origin) and the audit status shows", async () => {
    const view = await renderEditor([...withCanvas(starterFiles("widget")), { path: "widget.js", content: CODE }]);
    await waitFor(() => view.container.querySelector("iframe[sandbox='allow-scripts']") !== null, 10_000);
    const frame = view.container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("script-src 'unsafe-inline' blob:");
    expect(view.container.textContent).toContain("Acessibilidade com o código");
    expect(view.container.textContent).toContain("Auditando a acessibilidade com o código rodando…");
    await view.unmount();
  });

  test("an empty widget.js is removed from the files", async () => {
    const view = await renderEditor([...starterFiles("widget"), { path: "widget.js", content: CODE }]);
    await click(view.tabs()[3]);
    const area = view.panel("widget.js")?.querySelector("textarea") as HTMLTextAreaElement;
    const prototype = Object.getPrototypeOf(area) as object;
    await act(() => {
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(area, "  ");
      area.dispatchEvent(new (area.ownerDocument.defaultView as unknown as typeof globalThis).Event("input", { bubbles: true }));
    });
    expect(view.changes.at(-1)?.some((file) => file.path === "widget.js")).toBe(false);
    await view.unmount();
  });
});
