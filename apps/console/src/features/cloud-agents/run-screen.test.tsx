import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { WorkspaceProvider, type Workspace } from "@/features/shell/workspace";
import { act, click, installTestDom, render, waitFor } from "@/features/widgets/test-dom";
import type { CloudRun } from "@/server/console/cloud-agents/types";

import { CloudRunScreen } from "./run-screen";

installTestDom();

const PROJECT = { id: "p1", orgId: "org_test", slug: "acme-site", name: "Site", description: "", artifactCount: 0, members: 1, lastActive: 0 };
const WORKSPACE = {
  organization: { id: "org_test", name: "Acme", slug: "acme", plan: "team", role: "developer", mark: "A", color: "blue" },
  projects: [PROJECT],
  features: { byKey: { "console.cloud_agents": { enabled: true, visible: true } } },
} as unknown as Workspace;

const RUN: CloudRun = {
  id: "11111111-1111-4111-8111-111111111111",
  agentId: "a1",
  agentName: "reporter",
  projectId: "p1",
  status: "waiting_approval",
  trigger: "manual",
  actor: { id: "u1", name: "Luis" },
  prompt: "Write the weekly report.",
  result: null,
  budgetUsd: 5,
  costUsd: 0.42,
  runningSeconds: 75,
  tokens: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0 },
  approvals: [
    {
      id: "ap1",
      tool: "ravi_bases_views_rows_create",
      server: "ravi",
      inputPreview: '{"title":"Weekly report"}',
      status: "pending",
      requestedAt: "2026-10-19T10:00:00Z",
      decidedAt: null,
      decidedBy: null,
    },
  ],
  outputs: [{ id: "out1", name: "report.md", size: 2048 }],
  startedAt: "2026-10-19T09:59:00Z",
  endedAt: null,
  error: null,
  origin: null,
  url: "https://console.ravi.bot/acme/p/p1/cloud/runs/11111111-1111-4111-8111-111111111111",
};

type Answer = { status: number; body: unknown };
const requests: Array<{ method: string; url: string; body: unknown }> = [];
let run: CloudRun = RUN;
let viewerId = "u1";
let canManageKey = false;
const realFetch = globalThis.fetch;

function answer(method: string, url: string): Answer | undefined {
  if (url.endsWith("/availability")) {
    return { status: 200, body: { availability: { state: "available", canWrite: true, canManageKey }, viewerId } };
  }
  if (url.endsWith("/credential")) return { status: 200, body: { credential: { status: "active" } } };
  if (url.includes("/events")) {
    return {
      status: 200,
      body: { events: [{ seq: 1, at: "2026-10-19T09:59:30Z", type: "message", role: "agent", text: "Drafting the report." }], cursor: "1" },
    };
  }
  if (method === "POST" && url.includes("/approvals/ap1")) {
    run = { ...run, status: "running", approvals: [{ ...run.approvals[0]!, status: "approved", decidedAt: "2026-10-19T10:01:00Z", decidedBy: { id: "u1", name: "Luis" } }] };
    return { status: 200, body: { run } };
  }
  if (url.endsWith(`/runs/${RUN.id}`)) return { status: 200, body: { run } };
  return undefined;
}

beforeEach(() => {
  requests.length = 0;
  run = RUN;
  viewerId = "u1";
  canManageKey = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const reply = answer(method, url);
    if (!reply) throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function renderRun() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <WorkspaceProvider value={WORKSPACE}>
        <CloudRunScreen projectId="p1" runId={RUN.id} />
      </WorkspaceProvider>
    </QueryClientProvider>,
  );
  const text = () => view.container.textContent ?? "";
  const button = (label: string) =>
    Array.from(view.container.querySelectorAll("button")).find((element) => element.textContent?.trim() === label) ?? null;
  return { ...view, client, text, button };
}

describe("cloud run detail", () => {
  test("shows the pending approval, the activity, cost and files, and approves", async () => {
    const view = await renderRun();
    await waitFor(() => view.text().includes("Drafting the report."));
    expect(view.text()).toContain("Needs approval");
    expect(view.text()).toContain("ravi_bases_views_rows_create");
    expect(view.text()).toContain('{"title":"Weekly report"}');
    expect(view.text()).toContain("Follow up");
    expect(view.text()).not.toContain("Sending makes you");
    expect(view.text()).toContain("US$ 0.42");
    const download = view.container.querySelector('a[aria-label="Download report.md"]');
    expect(download?.getAttribute("href")).toContain(`/api/console/cloud-agents/runs/${RUN.id}/outputs/out1`);

    await click(view.button("Approve"));
    await waitFor(() => requests.some((request) => request.method === "POST"));
    const post = requests.find((request) => request.method === "POST")!;
    expect(post.url).toContain(`/api/console/cloud-agents/runs/${RUN.id}/approvals/ap1`);
    expect(post.body).toEqual({ decision: "approve" });
    await waitFor(() => view.text().includes("Approved"));
    expect(view.button("Approve")).toBeNull();
    await act(() => view.client.cancelQueries());
    await view.unmount();
  });

  test("someone else's run shows who decides instead of the buttons", async () => {
    viewerId = "u2";
    const view = await renderRun();
    await waitFor(() => view.text().includes("ravi_bases_views_rows_create"));
    expect(view.button("Approve")).toBeNull();
    expect(view.text()).toContain("waits for Luis, or an owner or admin, to decide");
    expect(view.text()).not.toContain("Follow up");
    expect(view.container.querySelector("textarea")).toBeNull();
    await act(() => view.client.cancelQueries());
    await view.unmount();
  });

  test("an owner or admin who is not the actor may follow up and is told it makes them the actor", async () => {
    viewerId = "u2";
    canManageKey = true;
    const view = await renderRun();
    await waitFor(() => view.text().includes("Follow up"));
    expect(view.container.querySelector("textarea")).not.toBeNull();
    expect(view.text()).toContain("Sending makes you the person this run acts for, instead of Luis");
    expect(view.button("Approve")).not.toBeNull();
    await act(() => view.client.cancelQueries());
    await view.unmount();
  });
});
