import { describe, expect, test } from "bun:test";

import { GET, PUT, DELETE, handleViewerAssertionAudiencesCli } from "./route";
import type { ViewerAssertionRegistryRepository } from "@/server/console/pages/viewer-assertions/registry";

const PROJECT_REF = "demo-project";
const SITE_REF = "demo.ravi.page";

function routeContext() {
  return { params: Promise.resolve({ projectRef: PROJECT_REF, siteRef: SITE_REF }) };
}

describe("CLI viewer assertion audiences", () => {
  test("returns AUTH_REQUIRED without CLI auth", async () => {
    const request = new Request(
      `https://example.test/api/cli/projects/${PROJECT_REF}/pages/${SITE_REF}/viewer-assertion-audiences`,
    );

    const response = await GET(request as never, routeContext());
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toMatch(/json/);
    expect(await response.json()).toMatchObject({
      error: { code: "AUTH_REQUIRED" },
    });
  });

  test("lists and upserts an audience for the resolved site", async () => {
    const repository = memoryRepository();
    const deps = authenticatedDeps(repository);
    const setResponse = await PUT(jsonRequest("PUT", {
      aud: "https://api.customer.example",
      origins: ["https://demo.ravi.page"],
    }) as never, routeContext());

    expect(setResponse.status).toBe(401);

    const authedSet = await handleViewerAssertionAudiencesCli(
      jsonRequest("PUT", {
        aud: "https://api.customer.example",
        origins: ["https://demo.ravi.page"],
      }) as never,
      routeContext(),
      deps,
    );
    expect(authedSet.status).toBe(200);
    expect(authedSet.headers.get("cache-control")).toBe("no-store");
    expect(await authedSet.json()).toMatchObject({
      audience: "https://api.customer.example",
      origins: ["https://demo.ravi.page"],
      projectRef: PROJECT_REF,
      siteId: "site_1",
      siteRef: SITE_REF,
      status: "active",
    });

    const listed = await handleViewerAssertionAudiencesCli(
      jsonRequest("GET") as never,
      routeContext(),
      deps,
    );
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.items).toEqual([
      expect.objectContaining({
        audience: "https://api.customer.example",
        origins: ["https://demo.ravi.page"],
        siteId: "site_1",
      }),
    ]);
    expect(repository.actions.map((action) => action.action)).toEqual(["write", "read"]);
  });

  test("rejects an origin that is not the site hostname", async () => {
    const repository = memoryRepository();
    const response = await handleViewerAssertionAudiencesCli(
      jsonRequest("PUT", {
        audience: "https://api.customer.example",
        origins: ["https://evil.example"],
      }) as never,
      routeContext(),
      authenticatedDeps(repository),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "PAYLOAD_INVALID",
        message: "Each origin must be this site's default hostname or an active custom hostname.",
      },
    });
    expect(repository.audiences).toEqual([]);
  });

  test("remove of an unknown audience does not delete another row", async () => {
    const repository = memoryRepository();
    repository.audiences.push(storedAudience("https://api.customer.example"));
    const response = await DELETE(new Request(
      `https://example.test/api/cli/projects/${PROJECT_REF}/pages/${SITE_REF}/viewer-assertion-audiences?aud=https://missing.example`,
      { method: "DELETE" },
    ) as never, routeContext());
    expect(response.status).toBe(401);

    const authed = await handleViewerAssertionAudiencesCli(
      new Request(
        `https://example.test/api/cli/projects/${PROJECT_REF}/pages/${SITE_REF}/viewer-assertion-audiences?aud=https://missing.example`,
        { method: "DELETE" },
      ) as never,
      routeContext(),
      authenticatedDeps(repository),
    );

    expect(authed.status).toBe(404);
    expect(authed.headers.get("cache-control")).toBe("no-store");
    expect(await authed.json()).toMatchObject({
      error: {
        code: "PAYLOAD_INVALID",
        message: "The requested viewer assertion audience is not registered on this site.",
      },
    });
    expect(repository.audiences.map((item) => item.audience)).toEqual(["https://api.customer.example"]);
    expect(repository.deletedIds).toEqual([]);
  });
});

function jsonRequest(method: string, body?: unknown) {
  return new Request(
    `https://example.test/api/cli/projects/${PROJECT_REF}/pages/${SITE_REF}/viewer-assertion-audiences`,
    {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

function authenticatedDeps(repository: MemoryRepository) {
  return {
    authenticate: async () => ({
      accessTokenJti: "jti_1",
      // Same shape as authenticateCliRequest: the verified installation and CLI session.
      localInstallation: { id: "inst_1" },
      cliSession: { id: "session_1" },
      membership: { role: "developer" },
      organization: { id: "org_site" },
      scopes: ["console.projects.read", "console.projects.link"],
      user: { id: "user_1" },
    }) as never,
    repository,
    resolveSite: async (input: { action: "read" | "write"; projectRef: string; siteRef: string }) => {
      repository.actions.push({ action: input.action, projectRef: input.projectRef, siteRef: input.siteRef });
      expect(input.projectRef).toBe(PROJECT_REF);
      expect(input.siteRef).toBe(SITE_REF);
      return {
        defaultHostname: "demo.ravi.page",
        id: "site_1",
        organizationId: "org_site",
        projectId: "proj_1",
        status: "active",
      };
    },
  };
}

type StoredAudience = {
  audience: string;
  id: string;
  organizationId: string;
  origins: string[];
  projectId: string;
  siteId: string;
  status: string;
  updatedAt: Date;
};

type MemoryRepository = ViewerAssertionRegistryRepository & {
  actions: Array<{ action: "read" | "write"; projectRef: string; siteRef: string }>;
  audiences: StoredAudience[];
  deletedIds: string[];
};

function memoryRepository(): MemoryRepository {
  const repository: MemoryRepository = {
    actions: [],
    audiences: [],
    deletedIds: [],
    async deleteAudience(input) {
      const index = repository.audiences.findIndex((item) => item.id === input.id && item.siteId === input.siteId);
      if (index < 0) return null;
      const deleted = repository.audiences.splice(index, 1)[0];
      if (!deleted) return null;
      repository.deletedIds.push(deleted.id);
      return deleted;
    },
    async findActiveAudience(input) {
      return repository.audiences.find((item) => item.siteId === input.siteId && item.audience === input.audience && item.status === "active") ?? null;
    },
    async insertAudit() {},
    async listAudiences(siteId) {
      return repository.audiences.filter((item) => item.siteId === siteId);
    },
    async listSiteHostnames(site) {
      return [site.defaultHostname];
    },
    async upsertAudience(input) {
      const existing = repository.audiences.find((item) => item.siteId === input.siteId && item.audience === input.audience);
      const record = existing ?? storedAudience(input.audience);
      record.origins = input.origins;
      record.organizationId = input.organizationId;
      record.projectId = input.projectId;
      record.siteId = input.siteId;
      record.status = "active";
      record.updatedAt = new Date("2026-09-29T00:00:00.000Z");
      if (!existing) repository.audiences.push(record);
      return record;
    },
  };
  return repository;
}

function storedAudience(audience: string): StoredAudience {
  return {
    audience,
    id: "aud_1",
    organizationId: "org_site",
    origins: ["https://demo.ravi.page"],
    projectId: "proj_1",
    siteId: "site_1",
    status: "active",
    updatedAt: new Date("2026-09-29T00:00:00.000Z"),
  };
}
