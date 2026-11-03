import { describe, expect, test } from "bun:test";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";

import { resolveConsoleFeatureAccess } from "@/server/console/feature-access";

import {
  handleKnowledgeCliGet,
  handleKnowledgeCliPost,
  knowledgeCliError,
  respondKnowledgeProjectCli,
} from "./cli-api";

const enabled = async ({ organizationId, role }: { organizationId: string; role: string }) =>
  resolveConsoleFeatureAccess({
    organizationId,
    plan: "free",
    role,
    entitlements: [{ key: "console.knowledge", source: "manual", startsAt: null, endsAt: null, valueJson: {} }],
  });
const disabled = async ({ organizationId, role }: { organizationId: string; role: string }) =>
  resolveConsoleFeatureAccess({ organizationId, plan: "free", role, entitlements: [] });

describe("Knowledge CLI API contract", () => {
  test("lists project knowledge sources through read scope", async () => {
    const calls: unknown[] = [];
    const result = await handleKnowledgeCliGet({
      auth: auth(["console.knowledge.read"]),
      projectRef: "core",
      segments: ["sources"],
      services: {
        featureAccess: enabled,
        listSources: async (input) => {
          calls.push(input);
          return [{ id: "src_1", title: "Source" }];
        },
      },
    });

    expect(result).toEqual({
      payload: [{ id: "src_1", title: "Source" }],
      status: 200,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      projectRef: "core",
      workspace: {
        mode: "workos",
        user: { id: "user_1" },
        organization: { id: "org_1" },
        membership: { role: "owner" },
      },
    });
  });

  test("creates a source and ingests content through write scope", async () => {
    const sourceResult = await handleKnowledgeCliPost({
      auth: auth(["console.knowledge.write"]),
      body: { title: "CLI Source" },
      projectRef: "core",
      requestId: "req_source",
      segments: ["sources"],
      services: {
        featureAccess: enabled,
        createSource: async (input) => ({
          body: input.body,
          projectRef: input.projectRef,
          requestId: input.requestId,
        }),
      },
    });
    expect(sourceResult).toEqual({
      payload: { body: { title: "CLI Source" }, projectRef: "core", requestId: "req_source" },
      status: 201,
    });

    const ingestionResult = await handleKnowledgeCliPost({
      auth: auth(["console.knowledge.write"]),
      body: { content: "searchable file text" },
      projectRef: "core",
      requestId: "req_ingest",
      segments: ["sources", "src_1", "ingestions"],
      services: {
        featureAccess: enabled,
        ingestSource: async (input) => ({
          body: input.body,
          projectRef: input.projectRef,
          requestId: input.requestId,
          sourceId: input.sourceId,
        }),
      },
    });
    expect(ingestionResult).toEqual({
      payload: {
        body: { content: "searchable file text" },
        projectRef: "core",
        requestId: "req_ingest",
        sourceId: "src_1",
      },
      status: 201,
    });
  });

  test("runs retrieval through read scope without write scope", async () => {
    const result = await handleKnowledgeCliPost({
      auth: auth(["console.knowledge.read"]),
      body: { query: "searchable file text" },
      projectRef: "core",
      requestId: "req_retrieve",
      segments: ["retrieval-runs"],
      services: {
        featureAccess: enabled,
        retrieve: async (input) => ({
          surface: input.surface,
          body: input.body,
          projectRef: input.projectRef,
          requestId: input.requestId,
        }),
      },
    });

    expect(result).toEqual({
      payload: {
        surface: "cli",
        body: { query: "searchable file text" },
        projectRef: "core",
        requestId: "req_retrieve",
      },
      status: 201,
    });
  });

  test("rejects missing Knowledge scope", async () => {
    await expect(
      handleKnowledgeCliGet({
        auth: auth(["console.projects.read"]),
        projectRef: "core",
        segments: ["sources"],
      }),
    ).rejects.toMatchObject({
      code: "PROJECT_ACCESS_DENIED",
      status: 403,
    });
  });

  test("gates project routes on console.knowledge by role, as PROJECT_ACCESS_DENIED", async () => {
    await expect(
      handleKnowledgeCliGet({
        auth: auth(["console.knowledge.read"]),
        projectRef: "core",
        segments: ["sources"],
        services: { featureAccess: disabled, listSources: async () => [] },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED", status: 403, details: { reason: "feature_unavailable" } });

    await expect(
      handleKnowledgeCliPost({
        auth: { ...auth(["console.knowledge.read"]), membership: { id: "m", role: "billing", status: "active" } },
        body: { query: "x" },
        projectRef: "core",
        requestId: "req",
        segments: ["retrieval-runs"],
        services: { featureAccess: enabled, retrieve: async () => ({}) },
      }),
    ).rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED", status: 403, details: { reason: "feature_forbidden" } });
  });

  test("maps knowledge 409 codes to CONFLICT with the knowledge message, never 503", () => {
    const error = knowledgeCliError(new ConsoleApiError(409, { error: "knowledge_ingestion_in_progress" }));
    expect(error).toBeInstanceOf(CliApiError);
    expect(error).toMatchObject({ status: 409, code: "CONFLICT" });
    expect(error.message).toBe("A knowledge ingestion with this idempotency key is still running.");
    for (const code of ["knowledge_route_not_captured", "faq_site_unavailable", "faq_site_not_public", "faq_route_taken", "faq_busy"]) {
      const mapped = knowledgeCliError(new ConsoleApiError(409, { error: code }));
      expect(mapped).toMatchObject({ status: 409, code: "CONFLICT" });
      expect(mapped.message).not.toContain("contact");
    }
    expect(knowledgeCliError(new ConsoleApiError(403, { error: "project_forbidden" }))).toMatchObject({
      status: 403,
      code: "PROJECT_ACCESS_DENIED",
    });
  });

  test("every project route response carries cache-control: no-store, errors included", async () => {
    const request = (method: string, body?: unknown) =>
      new Request("https://console.test/api/cli/projects/core/knowledge/sources", {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const authenticate = async () => auth(["console.knowledge.read", "console.knowledge.write"]);

    const ok = await respondKnowledgeProjectCli(request("GET"), { projectRef: "core", segments: ["sources"] }, "GET", {
      authenticate,
      services: { featureAccess: enabled, listSources: async () => [] },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");

    const denied = await respondKnowledgeProjectCli(request("GET"), { projectRef: "core", segments: ["sources"] }, "GET", {
      authenticate,
      services: { featureAccess: disabled },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("cache-control")).toBe("no-store");

    const conflict = await respondKnowledgeProjectCli(
      request("POST", { content: "x" }),
      { projectRef: "core", segments: ["sources", "src_1", "ingestions"] },
      "POST",
      {
        authenticate,
        services: {
          featureAccess: enabled,
          ingestSource: async () => {
            throw new ConsoleApiError(409, { error: "knowledge_ingestion_in_progress" });
          },
        },
      },
    );
    expect(conflict.status).toBe(409);
    expect(conflict.headers.get("cache-control")).toBe("no-store");
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("CONFLICT");

    const crashed = await respondKnowledgeProjectCli(request("GET"), { projectRef: "core", segments: ["sources"] }, "GET", {
      authenticate,
      services: {
        featureAccess: enabled,
        listSources: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(crashed.status).toBe(500);
    expect(crashed.headers.get("cache-control")).toBe("no-store");

    const unauthenticated = await respondKnowledgeProjectCli(request("GET"), { projectRef: "core", segments: ["sources"] }, "GET", {
      authenticate: async () => {
        throw new CliApiError(401, "AUTH_REQUIRED", "CLI authentication is required.");
      },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("cache-control")).toBe("no-store");
  });

  test("maps Console Knowledge validation and access errors to stable CLI errors", () => {
    expect(
      knowledgeCliError(new ConsoleApiError(400, { error: "validation_failed" })),
    ).toMatchObject({
      code: "PAYLOAD_INVALID",
      status: 400,
    });
    expect(
      knowledgeCliError(new ConsoleApiError(404, { error: "knowledge_source_not_found" })),
    ).toMatchObject({
      code: "PROJECT_ACCESS_DENIED",
      status: 403,
    });
  });
});

function auth(scopes: string[]): CliAuthContext {
  return {
    accessTokenJti: "jti_1",
    user: {
      id: "user_1",
      primaryEmail: "dev@ravi.bot",
      displayName: "Ravi Dev",
      avatarUrl: null,
      status: "active",
    },
    organization: {
      id: "org_1",
      slug: "ravi",
      name: "Ravi",
      status: "active",
    },
    membership: {
      id: "membership_1",
      role: "owner",
      status: "active",
    },
    localInstallation: {
      id: "installation_1",
      name: "CLI",
      hostname: null,
      platform: null,
      raviVersion: null,
      status: "active",
      lastSeenAt: new Date("2026-06-26T12:00:00.000Z"),
    },
    cliSession: {
      id: "session_1",
      status: "active",
      expiresAt: new Date("2026-06-26T12:15:00.000Z"),
      lastUsedAt: new Date("2026-06-26T12:00:00.000Z"),
    },
    scopes,
  };
}
