import { describe, expect, test } from "bun:test";
import { authorizeFixtureProject } from "./authorization/fixture-policy";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  createKnowledgeSource,
  deleteKnowledgeSource,
  listKnowledgeSources,
  parseCreateKnowledgeSourceBody,
  type KnowledgeSourcesRepository,
} from "./knowledge";
import type { ConsoleWorkspace } from "./workspace";

describe("Knowledge source enrollment", () => {
  test("parses source create input with secure defaults", () => {
    const parsed = parseCreateKnowledgeSourceBody({
      title: "  Product notes  ",
      description: "  Launch context  ",
    });

    expect(parsed).toMatchObject({
      sourceType: "manual_note",
      title: "Product notes",
      description: "Launch context",
      sensitivity: "standard",
      sourceRef: {},
      retentionPolicy: { schemaVersion: 1, mode: "default" },
      metadata: {},
      allowedConsumers: ["console", "agent", "retrieval", "ingestion"],
    });
  });

  test("rejects invalid source create input with field errors", () => {
    expect(() => parseCreateKnowledgeSourceBody({ sourceType: "unknown", title: "" })).toThrow(ConsoleApiError);
  });

  test("creates project-private sources and records audit without exposing raw refs", async () => {
    const repository = createInMemoryKnowledgeSourcesRepository([
      { id: "proj_1", organizationId: "org_1", slug: "core" },
    ]);

    const source = await createKnowledgeSource({
      body: {
        sourceType: "meeting",
        title: "Weekly sync",
        sourceRef: { meetingId: "meeting_1" },
        metadata: { origin: "test" },
      },
      projectRef: "core",
      repository,
      requestId: "req_1",
      workspace: workspace("org_1", { role: "developer", userId: "00000000-0000-4000-8000-000000000001" }),
    });

    expect(source).toMatchObject({
      projectId: "proj_1",
      sourceType: "meeting",
      title: "Weekly sync",
      sensitivity: "standard",
      sourceRef: { meetingId: "meeting_1" },
      metadata: { origin: "test" },
      raw: {
        status: "pending",
        storageBackend: "none",
        sha256: null,
        sizeBytes: null,
        contentType: null,
        storedAt: null,
      },
      access: {
        scope: "project",
        allowedConsumers: ["console", "agent", "retrieval", "ingestion"],
      },
    });
    expect(source).not.toHaveProperty("rawRef");
    expect(JSON.stringify(source)).not.toContain("meetings/weekly-sync.txt");
    expect(repository.sources[0]?.rawRefJson).toMatchObject({
      schemaVersion: 1,
      status: "pending",
      storageBackend: "none",
      visibility: "private",
    });
    expect(repository.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "knowledge_source.created",
        targetType: "knowledge_source",
        targetId: source.id,
      }),
    );
  });

  test("allows project viewers to list sources but not create them", async () => {
    const repository = createInMemoryKnowledgeSourcesRepository([
      { id: "proj_1", organizationId: "org_1", slug: "core" },
    ]);
    await createKnowledgeSource({
      body: { title: "Seed" },
      projectRef: "core",
      repository,
      requestId: "req_seed",
      workspace: workspace("org_1"),
    });

    const viewerWorkspace = workspace("org_1", { role: "viewer", userId: "viewer_1" });
    await expect(listKnowledgeSources({ projectRef: "core", repository, workspace: viewerWorkspace })).resolves
      .toHaveLength(1);
    await expect(
      createKnowledgeSource({
        body: { title: "Blocked" },
        projectRef: "core",
        repository,
        requestId: "req_blocked",
        workspace: viewerWorkspace,
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);
  });

  test("soft deletes project sources and records audit", async () => {
    const repository = createInMemoryKnowledgeSourcesRepository([
      { id: "proj_1", organizationId: "org_1", slug: "core" },
    ]);
    const source = await createKnowledgeSource({
      body: { title: "Temporary source" },
      projectRef: "core",
      repository,
      requestId: "req_seed",
      workspace: workspace("org_1"),
    });

    const deleted = await deleteKnowledgeSource({
      projectRef: "core",
      repository,
      requestId: "req_delete",
      sourceId: source.id,
      workspace: workspace("org_1"),
    });

    expect(deleted).toMatchObject({
      id: source.id,
      status: "deleted",
    });
    await expect(listKnowledgeSources({ projectRef: "core", repository, workspace: workspace("org_1") }))
      .resolves.toHaveLength(0);
    expect(repository.auditEvents).toContainEqual(
      expect.objectContaining({
        action: "knowledge_source.deleted",
        targetType: "knowledge_source",
        targetId: source.id,
      }),
    );
  });
});

function workspace(
  organizationId: string,
  options: { role?: string; userId?: string } = {},
): ConsoleWorkspace {
  return {
    mode: "workos",
    organization: {
      id: organizationId,
    },
    membership: {
      role: options.role ?? "owner",
    },
    user: {
      id: options.userId ?? "user_1",
    },
  } as ConsoleWorkspace;
}

function createInMemoryKnowledgeSourcesRepository(
  projects: Array<{ id: string; organizationId: string; slug: string }>,
): KnowledgeSourcesRepository & {
  auditEvents: Array<{ action: string; metadataJson: Record<string, unknown>; targetId: string | null; targetType: string }>;
  sources: Array<Record<string, unknown>>;
} {
  const sources: Array<Record<string, unknown>> = [];
  const auditEvents: Array<{ action: string; metadataJson: Record<string, unknown>; targetId: string | null; targetType: string }> = [];

  return {
    auditEvents,
    sources,
    async authorizeProject(workspace, projectId, action) {
      return authorizeFixtureProject(workspace, projectId, action, { projects, projectRole: (await this.findProjectMembership(projectId, workspace.user.id))?.role });
    },

    async deleteSource(input) {
      const source = sources.find(
        (item) =>
          item.organizationId === input.organizationId &&
          item.projectId === input.projectId &&
          item.id === input.sourceId &&
          item.status !== "deleted",
      );
      if (!source) return null;
      source.status = "deleted";
      source.revokedAt = new Date();
      source.updatedAt = new Date();
      return source as never;
    },

    async findProjectByRef(organizationId, projectRef) {
      return (
        projects.find(
          (project) =>
            project.organizationId === organizationId && (project.id === projectRef || project.slug === projectRef),
        ) ?? null
      );
    },

    async findProjectMembership(projectId, userId) {
      if (projectId === "proj_1" && userId === "viewer_1") {
        return { role: "viewer", status: "active" };
      }
      return null;
    },

    async getSourceById(input) {
      return (
        sources.find(
          (source) =>
            source.organizationId === input.organizationId &&
            source.projectId === input.projectId &&
            source.id === input.sourceId &&
            source.status !== "deleted",
        ) as never
      ) ?? null;
    },

    async insertAudit(input) {
      auditEvents.push({
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        metadataJson: input.metadataJson,
      });
    },

    async insertSource(input) {
      const now = new Date();
      const source = {
        id: `source_${sources.length + 1}`,
        organizationId: input.organizationId,
        projectId: input.projectId,
        ownerUserId: input.ownerUserId,
        sourceType: input.sourceType,
        title: input.title,
        description: input.description,
        status: "active",
        sensitivity: input.sensitivity,
        sourceRefJson: input.sourceRefJson,
        rawRefJson: input.rawRefJson,
        accessPolicyJson: input.accessPolicyJson,
        retentionPolicyJson: input.retentionPolicyJson,
        safeMetadataJson: input.safeMetadataJson,
        createdByActorType: input.createdByActorType,
        createdByActorId: input.createdByActorId,
        revokedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      sources.push(source);
      return source as never;
    },

    async listSources(projectId) {
      return sources.filter((source) => source.projectId === projectId && source.status !== "deleted") as never;
    },
  };
}
