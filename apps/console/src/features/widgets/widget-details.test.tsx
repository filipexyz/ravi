import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { WorkspaceProvider, type Workspace } from "@/features/shell/workspace";
import { DEFAULT_THEME_FILES } from "@/shared/widgets/theme/default";

import { starterFiles } from "./kind-files";
import { act, click, installTestDom, render, waitFor } from "./test-dom";
import { writeThemeToken } from "./theme-form";
import { effectiveThemeNote, WidgetProposalSections } from "./widget-details";

installTestDom();

const WORKSPACE = { organization: { id: "org_test", name: "Acme", slug: "acme", plan: "team", role: "owner", mark: "A", color: "blue" } } as unknown as Workspace;
const POINTER = { ref: "org/acme", itemId: "item-1", scope: "org", slug: "acme", name: "Acme", setAt: "2026-10-01T00:00:00Z", setBy: { name: "Luis" } };
const ACTIVE = { org: POINTER, project: null, effective: { ...POINTER, version: 3, hash: "h", source: "org" }, warnings: [] };
const ACME_THEME = DEFAULT_THEME_FILES.map((file) =>
  file.path === "theme.json" ? { path: file.path, content: writeThemeToken(file.content, "color.light.accent.base", "#0b5d50")! } : { ...file },
);

const WIDGET_FILES = starterFiles("widget").map((file) => ({ ...file, bytes: file.content.length, sha256: "" }));

type Route = (url: string) => { status: number; body: unknown } | undefined;
let route: Route = () => undefined;
const realFetch = globalThis.fetch;
const requests: string[] = [];

beforeEach(() => {
  requests.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    const answer = route(url);
    if (!answer) throw new TypeError("network down");
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const activeOk: Route = (url) => (url.includes("/themes/active") ? { status: 200, body: ACTIVE } : undefined);
const itemOk: Route = (url) =>
  url.includes("/themes/org/acme?version=3") ? { status: 200, body: { item: { ref: "org/acme" }, version: { files: ACME_THEME } } } : undefined;

async function renderProposal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <WorkspaceProvider value={WORKSPACE}>
        <WidgetProposalSections files={WIDGET_FILES} project={null} title="Prévia da proposta 1" />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  const status = () => view.container.querySelector("[role=status][aria-live=polite]");
  const text = () => view.container.textContent ?? "";
  return { ...view, client, status, text };
}

describe("effectiveThemeNote", () => {
  test("says when the default theme stands in for an active theme that did not load", () => {
    expect(effectiveThemeNote({ name: "Acme", ref: "org/acme", version: 3 })).toBe("o tema Acme (org/acme, v3)");
    expect(effectiveThemeNote(null)).toBe("o tema padrão do Ravi");
    expect(effectiveThemeNote(null, true)).toBe("o tema padrão do Ravi, porque o tema ativo não carregou");
  });
});

describe("a widget preview when the active theme does not load", () => {
  test("themes/active fails: the preview uses the default theme and says so, with a retry", async () => {
    route = () => undefined;
    const view = await renderProposal();
    await waitFor(() => view.text().includes("O tema ativo não carregou"));
    // Announced: the note is inside a polite status region that was there before it appeared.
    expect(view.status()?.textContent).toContain("A prévia usa o tema padrão do Ravi até ele carregar.");
    expect(view.text()).toContain("o tema padrão do Ravi, porque o tema ativo não carregou");
    expect(view.container.querySelector("iframe")).not.toBeNull();

    route = (url) => activeOk(url) ?? itemOk(url);
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Tentar de novo"));
    await waitFor(() => view.text().includes("o tema Acme (org/acme, v3)"));
    expect(view.status()?.textContent).toBe("");
    expect(view.container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("#0b5d50");
    await view.unmount();
  });

  test("the pinned version fails: same note, and the retry asks for that version again", async () => {
    route = (url) => activeOk(url) ?? (url.includes("/themes/org/acme") ? { status: 404, body: { error: "not_found" } } : undefined);
    const view = await renderProposal();
    await waitFor(() => view.text().includes("O tema ativo não carregou"));
    expect(view.text()).toContain("porque o tema ativo não carregou");
    const before = requests.filter((url) => url.includes("version=3")).length;
    await click([...view.container.querySelectorAll("button")].find((button) => button.textContent === "Tentar de novo"));
    await waitFor(() => requests.filter((url) => url.includes("version=3")).length > before);
    await view.unmount();
  });

  test("a failed background refetch of themes/active keeps the cached theme and shows no note", async () => {
    route = (url) => activeOk(url) ?? itemOk(url);
    const view = await renderProposal();
    await waitFor(() => view.text().includes("o tema Acme (org/acme, v3)"));
    route = () => undefined;
    await act(() => view.client.refetchQueries({ predicate: (query) => query.queryKey.includes("active") }));
    await waitFor(() => view.client.getQueryCache().findAll().some((query) => query.queryKey.includes("active") && query.state.status === "error"));
    // Let the screen render the failed state, as it would within a frame.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(view.text()).toContain("o tema Acme (org/acme, v3)");
    expect(view.text()).not.toContain("O tema ativo não carregou");
    expect(view.status()?.textContent).toBe("");
    await view.unmount();
  });

  test("a theme that loads shows no note", async () => {
    route = (url) => activeOk(url) ?? itemOk(url);
    const view = await renderProposal();
    await waitFor(() => view.text().includes("o tema Acme (org/acme, v3)"));
    expect(view.status()?.textContent).toBe("");
    await view.unmount();
  });
});
