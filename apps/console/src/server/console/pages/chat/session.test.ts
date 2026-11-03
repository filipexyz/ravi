import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import type { PagesResolveRoute, PagesResolveSite, PagesRouteResolveRepository } from "@/server/console/pages/resolve";
import type { PageChatViewer } from "@/server/console/pages/connectors/knowledge-search";
import type { ProjectAccessWorkspace } from "@/server/console/project-access";

import { PAGE_CHAT_DEFAULT_LIMITS, type PageChatAllowance } from "./limits";
import {
  authorizePageChatSession,
  PAGE_CHAT_KNOWLEDGE_INSTRUCTION,
  PAGE_CHAT_TOOL_NAMES,
  pageChatToolDefinitions,
  type PageChatSessionDeps,
} from "./session";
import type { PageChatSessionStart } from "./usage";

const site: PagesResolveSite = {
  id: "00000000-0000-4000-8000-000000000003",
  organizationId: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  defaultHostname: "acme-site.ravi.page",
  defaultVisibility: "private",
  activeReleaseId: "rel_1",
  status: "active",
};

function route(path: string, id = `route_${path}`): PagesResolveRoute {
  return {
    id,
    routeId: id,
    path,
    matchType: "exact",
    priority: 0,
    artifactId: "art_1",
    artifactVersionId: "artv_1",
    entrypoint: "index.html",
    assetBase: "",
    visibility: "private",
  };
}

const repository: PagesRouteResolveRepository = {
  findSiteByHost: async (host) => (host === site.defaultHostname ? site : null),
  getActiveRelease: async () => ({ id: "rel_1", releaseNumber: 1, status: "active" }),
  listReleaseRoutes: async () => [route("/"), route("/relatorio")],
  getArtifactVersionFile: async () => null,
};

const workspace = {
  user: { id: "00000000-0000-4000-8000-000000000004" },
  membership: { role: "member" },
} as unknown as ProjectAccessWorkspace;

const member: PageChatViewer = { kind: "member", userId: workspace.user.id, workspace };
const guest: PageChatViewer = { kind: "guest", userId: "00000000-0000-4000-8000-000000000009" };

const allowed: PageChatAllowance = { allowed: true, sessionMaxSeconds: 600, limits: PAGE_CHAT_DEFAULT_LIMITS };

function deps(overrides: Partial<PageChatSessionDeps> = {}) {
  const starts: PageChatSessionStart[] = [];
  const value: PageChatSessionDeps = {
    routeRepository: repository,
    loadSiteMetadata: async () => ({}),
    verifyViewer: async () => member,
    isHumanViewerSession: async () => true,
    resolveAllowance: async () => allowed,
    loadConnectorActions: async () => [
      {
        id: "ravi.bases.views.query",
        title: "Query view",
        description: "Reads rows of a view.",
        class: "read",
        inputSchema: {},
      },
    ],
    listViewerMarkedRoutes: async () => [],
    routeMarkedForViewers: async () => false,
    canGuestViewRoute: async () => false,
    recordStart: async (start) => {
      starts.push(start);
    },
    backendModel: "background-model",
    now: () => new Date("2026-10-10T15:00:00.000Z"),
    newId: () => "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
  return { value, starts };
}

const input = {
  host: "acme-site.ravi.page",
  path: "/relatorio",
  pagesSession: "pgs_token",
  requestId: "req_1",
};

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConsoleApiError);
    return { status: (error as ConsoleApiError).status, error: (error as ConsoleApiError).payload.error };
  }
  throw new Error("expected a rejection");
}

describe("Page Chat session authorization", () => {
  test("authorizes a human viewer and records the start", async () => {
    const { value, starts } = deps();
    const result = await authorizePageChatSession(input, value);

    expect(result).toMatchObject({
      chatSessionId: "11111111-1111-4111-8111-111111111111",
      siteId: site.id,
      releaseId: "rel_1",
      routeId: "route_/relatorio",
      viewerUserId: workspace.user.id,
      sessionMaxSeconds: 600,
      warnAtSeconds: 540,
      backendModel: "background-model",
      frame: { assistantName: "Ravi", voice: "bossa", language: "pt-BR", routes: ["/", "/relatorio"] },
    });
    expect(result.safetyIdentifier).toMatch(/^[0-9a-f]{64}$/);
    expect(result.safetyIdentifier).not.toContain(workspace.user.id);
    expect(result.session).toMatchObject({
      model: "gpt-live-1",
      store: false,
      audio: { output: { voice: "bossa" } },
      delegation: { type: "responses", responses: { model: "background-model", parallel_tool_calls: false } },
    });
    expect(JSON.stringify(result.session)).toContain("ravi.bases.views.query");
    expect(starts).toEqual([
      {
        organizationId: site.organizationId,
        projectId: site.projectId,
        siteId: site.id,
        releaseId: "rel_1",
        routeId: "route_/relatorio",
        chatSessionId: "11111111-1111-4111-8111-111111111111",
        viewerUserId: workspace.user.id,
        requestId: "req_1",
        startedAt: new Date("2026-10-10T15:00:00.000Z"),
        sessionMaxSeconds: 600,
      },
    ]);
  });

  test("uses the site's settings and lets the viewer pick a known voice", async () => {
    const { value } = deps({
      loadSiteMetadata: async () => ({
        pageChat: { assistantName: "Lia", voice: "tempo", instructions: "Fale do relatório." },
      }),
    });
    const site = await authorizePageChatSession(input, value);
    expect(site.frame).toMatchObject({ assistantName: "Lia", voice: "tempo" });
    expect(String(site.session.instructions)).toContain("Fale do relatório.");

    expect((await authorizePageChatSession({ ...input, voice: "marin" }, value)).frame.voice).toBe("marin");
    expect((await authorizePageChatSession({ ...input, voice: "robot" }, value)).frame.voice).toBe("tempo");
  });

  test("refuses without a session, for agents, on disabled sites and unknown routes", async () => {
    expect(await rejection(authorizePageChatSession({ ...input, pagesSession: null }, deps().value))).toEqual({
      status: 401,
      error: "page_chat_session_required",
    });
    expect(await rejection(authorizePageChatSession({ ...input, host: "other.ravi.page" }, deps().value))).toEqual({
      status: 404,
      error: "page_chat_unavailable",
    });
    expect(await rejection(authorizePageChatSession(input, deps({ verifyViewer: async () => null }).value))).toEqual({
      status: 401,
      error: "page_chat_session_required",
    });
    expect(
      await rejection(authorizePageChatSession(input, deps({ isHumanViewerSession: async () => false }).value)),
    ).toEqual({ status: 403, error: "page_chat_viewer_required" });
    expect(
      await rejection(
        authorizePageChatSession(input, deps({ loadSiteMetadata: async () => ({ pageChat: { enabled: false } }) }).value),
      ),
    ).toEqual({ status: 403, error: "page_chat_disabled_for_site" });
    expect(await rejection(authorizePageChatSession({ ...input, path: "/nada" }, deps().value))).toEqual({
      status: 404,
      error: "page_chat_route_not_found",
    });
  });

  test("maps allowance denials and records nothing", async () => {
    for (const [reason, status] of [
      ["feature_unavailable", 403],
      ["org_concurrency_limit", 429],
      ["viewer_daily_limit", 429],
    ] as const) {
      const { value, starts } = deps({
        resolveAllowance: async () =>
          ({ allowed: false, reason, limits: PAGE_CHAT_DEFAULT_LIMITS }) as PageChatAllowance,
      });
      expect(await rejection(authorizePageChatSession(input, value))).toEqual({ status, error: reason });
      expect(starts).toEqual([]);
    }
  });

  test("declares every tool with a name OpenAI accepts and a strict schema", () => {
    const tools = pageChatToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual([...PAGE_CHAT_TOOL_NAMES]);
    for (const tool of tools) {
      expect(String(tool.name)).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  test("lists ravi.knowledge.search and its instruction only when the site has marked pages", async () => {
    const plain = await authorizePageChatSession(input, deps().value);
    expect(plain.frame.connectorActions.map((action) => action.id)).toEqual(["ravi.bases.views.query"]);
    expect(JSON.stringify(plain.session)).not.toContain(PAGE_CHAT_KNOWLEDGE_INSTRUCTION);

    const marked = await authorizePageChatSession(
      input,
      deps({ listViewerMarkedRoutes: async () => [{ routeId: "route_/relatorio", path: "/relatorio" }] }).value,
    );
    expect(marked.frame.connectorActions.map((action) => action.id)).toEqual([
      "ravi.bases.views.query",
      "ravi.knowledge.search",
    ]);
    const backend = JSON.stringify(marked.session);
    expect(backend).toContain("- ravi.knowledge.search (read)");
    expect(backend).toContain(JSON.stringify(PAGE_CHAT_KNOWLEDGE_INSTRUCTION).slice(1, -1));
  });

  test("authorizes a guest on a marked route without a member role", async () => {
    const allowances: unknown[] = [];
    const verified: unknown[] = [];
    const { value, starts } = deps({
      verifyViewer: async (viewerInput) => {
        verified.push(viewerInput.route.routeId);
        return guest;
      },
      routeMarkedForViewers: async (routeId) => routeId === "route_/relatorio",
      listViewerMarkedRoutes: async () => [
        { routeId: "route_/relatorio", path: "/relatorio" },
        { routeId: "route_/secreto", path: "/secreto" },
      ],
      canGuestViewRoute: async ({ routeId, userId }) => routeId === "route_/relatorio" && userId === guest.userId,
      resolveAllowance: async (allowanceInput) => {
        allowances.push(allowanceInput);
        return { ...allowed, sessionMaxSeconds: 300 };
      },
      loadConnectorActions: async () => {
        throw new Error("guests never load the member catalog");
      },
    });
    const result = await authorizePageChatSession(input, value);

    // The route is matched before the viewer is verified.
    expect(verified).toEqual(["route_/relatorio"]);
    expect(allowances).toEqual([
      { organizationId: site.organizationId, viewerUserId: guest.userId, viewer: { kind: "guest", userId: guest.userId } },
    ]);
    expect(result).toMatchObject({ viewerUserId: guest.userId, sessionMaxSeconds: 300, routeId: "route_/relatorio" });
    expect(result.frame.connectorActions.map((action) => action.id)).toEqual(["ravi.knowledge.search"]);
    // Only pages given to the guest are navigable.
    expect(result.frame.routes).toEqual(["/relatorio"]);
    expect(JSON.stringify(result.session)).toContain(JSON.stringify(PAGE_CHAT_KNOWLEDGE_INSTRUCTION).slice(1, -1));
    expect(JSON.stringify(result.session)).not.toContain("ravi.bases.views.query (");
    expect(starts.map((start) => start.viewerUserId)).toEqual([guest.userId]);
  });

  test("refuses a guest on a route without a page_viewers mark", async () => {
    const { value, starts } = deps({ verifyViewer: async () => guest, routeMarkedForViewers: async () => false });
    expect(await rejection(authorizePageChatSession(input, value))).toEqual({
      status: 403,
      error: "page_chat_route_not_marked",
    });
    expect(starts).toEqual([]);
  });

  test("passes the member's role to the allowance", async () => {
    const allowances: unknown[] = [];
    const { value } = deps({
      resolveAllowance: async (allowanceInput) => {
        allowances.push(allowanceInput);
        return allowed;
      },
    });
    await authorizePageChatSession(input, value);
    expect(allowances).toEqual([
      { organizationId: site.organizationId, viewerUserId: workspace.user.id, viewer: { kind: "member", role: "member" } },
    ]);
  });
});
