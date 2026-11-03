import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { WorkspaceProvider, type Workspace } from "@/features/shell/workspace";
import { defaultCompiledTheme } from "@/shared/widgets/theme/default";

import type { ScriptAuditOutcome } from "./script-audit";
import { ScriptAuditReport } from "./script-audit-panel";
import { WidgetScriptAuditSection } from "./script-audit-section";
import { click, installTestDom, render, waitFor } from "./test-dom";

installTestDom();

const WORKSPACE = { organization: { id: "org_test", name: "Acme", slug: "acme", plan: "team", role: "owner", mark: "A", color: "blue" } } as unknown as Workspace;
const SHA = "c".repeat(64);
const PASS: ScriptAuditOutcome = { status: "pass", violations: [{ id: "region", impact: "moderate", help: "Content should be in landmarks", nodes: 1 }], errors: [], scriptSha256: SHA };
const FAIL: ScriptAuditOutcome = { status: "fail", violations: [{ id: "color-contrast", impact: "serious", help: "Elements must meet contrast", nodes: 3 }], errors: [], scriptSha256: SHA };

const realFetch = globalThis.fetch;
const posts: { url: string; body: unknown }[] = [];
beforeEach(() => {
  posts.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ audit: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderSection(outcome: ScriptAuditOutcome | null, version: Record<string, unknown> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runs: number[] = [];
  const view = await render(
    <QueryClientProvider client={client}>
      <WorkspaceProvider value={WORKSPACE}>
        <WidgetScriptAuditSection
          files={[]}
          item={{ ref: "org/pedido" }}
          run={async () => (runs.push(1), outcome)}
          theme={defaultCompiledTheme()}
          version={{ number: 2, script: { sha256: SHA, bytes: 90 }, scriptAudit: null, scriptAudited: false, canAudit: true, ...version }}
        />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  const text = () => view.container.textContent ?? "";
  const button = () => [...view.container.querySelectorAll("button")].find((entry) => /Rodar a auditoria/.test(entry.textContent ?? ""));
  return { ...view, runs, text, button };
}

describe("WidgetScriptAuditSection", () => {
  test("without an audit: pages refuse the version; an admin runs it and the result is stored on the version", async () => {
    const view = await renderSection(PASS);
    expect(view.text()).toContain("Ainda sem auditoria");
    await click(view.button());
    await waitFor(() => posts.length === 1);
    expect(posts[0]).toEqual({
      url: "/api/console/library/widgets/org/pedido/versions/2/audit",
      body: { status: "pass", violations: PASS.violations, scriptSha256: SHA },
    });
    await waitFor(() => view.text().includes("Auditoria gravada. Páginas já podem usar esta versão."));
    expect(view.text()).toContain("Acessibilidade: passou");
    expect(view.text()).toContain("1 aviso (não impede publicar)");
    await view.unmount();
  });

  test("a failing audit is stored as failing and lists each violation with its impact and help", async () => {
    const view = await renderSection(FAIL);
    await click(view.button());
    await waitFor(() => posts.length === 1);
    expect((posts[0]?.body as { status: string }).status).toBe("fail");
    await waitFor(() => view.text().includes("Auditoria gravada como reprovada."));
    expect(view.text()).toContain("Acessibilidade: não passou");
    expect(view.text()).toContain("Impacto sério: Elements must meet contrast");
    expect(view.text()).toContain("color-contrast");
    expect(view.text()).toContain("3 elementos");
    await view.unmount();
  });

  test("a run where the code throws is shown and not stored", async () => {
    const view = await renderSection({ ...PASS, violations: [], errors: ["TypeError: x is undefined"] });
    await click(view.button());
    await waitFor(() => view.text().includes("O código falhou na prévia"));
    expect(view.text()).toContain("TypeError: x is undefined");
    expect(posts.length).toBe(0);
    await view.unmount();
  });

  test("someone who is not an org owner or admin sees the stored state and who can run it", async () => {
    const view = await renderSection(PASS, { canAudit: false });
    expect(view.button()).toBeUndefined();
    expect(view.text()).toContain("Peça a um owner ou admin da organização");
    await view.unmount();
    const audited = await renderSection(PASS, {
      canAudit: false,
      scriptAudited: true,
      scriptAudit: { ...PASS, auditedBy: "user_1", auditedAt: "2026-10-17T10:00:00Z" },
    });
    expect(audited.text()).toContain("Acessibilidade: passou");
    expect(audited.text()).toContain("Auditoria gravada em");
    expect(audited.text()).not.toContain("Peça a um owner");
    await audited.unmount();
  });

  test("an audit stored for another widget.js does not count", async () => {
    const view = await renderSection(PASS, { scriptAudit: { ...PASS, scriptSha256: "d".repeat(64), auditedBy: null, auditedAt: "2026-10-17T10:00:00Z" } });
    expect(view.text()).toContain("A auditoria gravada é de outro widget.js.");
    await view.unmount();
  });
});

describe("ScriptAuditReport", () => {
  test("says when the audit has not run or is running, in a status region", async () => {
    const view = await render(<ScriptAuditReport outcome={null} running />);
    expect(view.container.querySelector("[role=status]")?.textContent).toBe("Auditando a acessibilidade com o código rodando…");
    await view.unmount();
  });
});
