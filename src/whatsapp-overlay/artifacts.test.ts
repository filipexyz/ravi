import { describe, expect, it } from "bun:test";
import type { ArtifactRecord } from "../artifacts/store.js";
import {
  ARTIFACT_BLOB_MAX_BYTES,
  buildOverlayArtifactsPayload,
  deriveLifecycle,
  normalizeArtifactsLimit,
  normalizeLifecycle,
  resolveArtifactBlob,
} from "./artifacts.js";

function makeRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  const base: ArtifactRecord = {
    id: "art_test_001",
    kind: "image",
    title: "Diagrama do overlay",
    summary: undefined,
    status: "completed",
    uri: undefined,
    filePath: "/tmp/diagram.png",
    blobPath: "/Users/luis/.ravi/artifacts/blobs/aa/aa.png",
    mimeType: "image/png",
    sizeBytes: 4096,
    sha256: "deadbeef",
    provider: "openai",
    model: "gpt-image-2",
    prompt: undefined,
    command: undefined,
    sessionKey: "agent:main:dev-main",
    sessionName: "dev-main",
    agentId: "main",
    taskId: "task-123",
    runId: undefined,
    turnId: undefined,
    messageId: undefined,
    channel: undefined,
    accountId: undefined,
    chatId: undefined,
    threadId: undefined,
    durationMs: 1234,
    costUsd: undefined,
    inputTokens: undefined,
    outputTokens: undefined,
    totalTokens: 42,
    metadata: undefined,
    metrics: undefined,
    lineage: undefined,
    input: undefined,
    output: undefined,
    tags: ["generated", "image"],
    createdAt: 1_000,
    updatedAt: 2_000,
  };
  return { ...base, ...overrides };
}

function makeTask(taskId: string, title: string) {
  return {
    id: taskId,
    title,
    instructions: "ship it",
    status: "in_progress" as const,
    priority: "high" as const,
    progress: 50,
    profileId: "default",
    taskProfile: {} as never,
    checkpointIntervalMs: null,
    reportToSessionName: null,
    reportEvents: [],
    parentTaskId: null,
    taskDir: null,
    createdBy: null,
    createdByAgentId: null,
    createdBySessionName: null,
    assigneeAgentId: "main",
    assigneeSessionName: "dev-main",
    workSessionName: "dev-main",
    worktree: null,
    summary: null,
    blockerReason: null,
    archivedAt: null,
    archivedBy: null,
    archiveReason: null,
    createdAt: 1,
    updatedAt: 2,
    dispatchedAt: null,
    startedAt: null,
    completedAt: null,
    artifacts: {
      primary: null,
      supporting: [],
      terminal: [],
    },
  };
}

const sessions = [
  {
    sessionKey: "agent:main:dev-main",
    name: "dev-main",
    agentId: "main",
    agentCwd: "/tmp/dev-main",
    updatedAt: 100,
    createdAt: 50,
    lastTo: "5511999999999@s.whatsapp.net",
  },
] as never[];

describe("buildOverlayArtifactsPayload", () => {
  it("builds stats and lineage links from the artifact ledger", () => {
    const records: ArtifactRecord[] = [
      makeRecord({
        id: "art_image_1",
        kind: "image",
        status: "completed",
        updatedAt: 5_000,
      }),
      makeRecord({
        id: "art_session_1",
        kind: "devin.session",
        status: "active",
        filePath: undefined,
        blobPath: undefined,
        sessionKey: undefined,
        sessionName: "task-foo-devin",
        agentId: undefined,
        taskId: "task-foo",
        updatedAt: 4_500,
      }),
      makeRecord({
        id: "art_archived",
        kind: "image",
        status: "archived",
        deletedAt: 6_000,
        updatedAt: 6_000,
        taskId: undefined,
      }),
    ];

    const payload = buildOverlayArtifactsPayload({
      limit: 50,
      sessions: sessions as never,
      liveBySessionName: new Map([
        [
          "dev-main",
          {
            activity: "thinking",
            updatedAt: 100,
          } as never,
        ],
      ]),
      listArtifacts: () => records,
      resolveTask(taskId) {
        return taskId === "task-123" ? (makeTask(taskId, "Overlay artifacts surface") as never) : null;
      },
      resolveSession(nameOrKey) {
        return sessions.find(
          (session: { name: string; sessionKey: string }) =>
            session.name === nameOrKey || session.sessionKey === nameOrKey,
        ) as never;
      },
      resolveAgentName(agentId) {
        return agentId === "main" ? "Main Agent" : null;
      },
      now: () => 6_500,
    });

    expect(payload.ok).toBe(true);
    expect(payload.stats.total).toBe(3);
    expect(payload.stats.byKind.image).toBe(2);
    expect(payload.stats.byKind["devin.session"]).toBe(1);
    expect(payload.stats.byLifecycle.completed).toBe(1);
    expect(payload.stats.byLifecycle.running).toBe(1);
    expect(payload.stats.byLifecycle.archived).toBe(1);
    expect(payload.stats.recentCount).toBe(3);

    const first = payload.items.find((item) => item.id === "art_image_1");
    expect(first?.lifecycle).toBe("completed");
    expect(first?.taskId).toBe("task-123");
    expect(first?.sessionName).toBe("dev-main");
    expect(first?.task?.title).toBe("Overlay artifacts surface");
    expect(first?.session?.activity).toBe("thinking");
    expect(first?.agent?.name).toBe("Main Agent");
    expect(first?.path).toBe("/tmp/diagram.png");

    const taskLink = first?.links.find((link) => link.targetType === "task");
    expect(taskLink?.action).toBe("focus-task");
    expect(taskLink?.task?.id).toBe("task-123");

    const sessionLink = first?.links.find((link) => link.targetType === "session");
    expect(sessionLink?.action).toBe("open-session");
    expect(sessionLink?.session?.sessionKey).toBe("agent:main:dev-main");

    const agentLink = first?.links.find((link) => link.targetType === "agent");
    expect(agentLink?.action).toBe("open-agent-session");
    expect(agentLink?.agent?.name).toBe("Main Agent");

    const pathLink = first?.links.find((link) => link.targetType === "path");
    expect(pathLink?.action).toBe("copy");
    expect(pathLink?.value).toBe("diagram.png");

    const blobLink = first?.links.find((link) => link.targetType === "blob");
    expect(blobLink?.action).toBe("copy");
    expect(blobLink?.copyText).toContain("/artifacts/blobs/");
  });

  it("filters by lifecycle and respects the requested limit", () => {
    const records: ArtifactRecord[] = [
      makeRecord({ id: "art_a", status: "completed", updatedAt: 10 }),
      makeRecord({ id: "art_b", status: "active", updatedAt: 20 }),
      makeRecord({ id: "art_c", status: "failed", updatedAt: 30 }),
    ];

    const payload = buildOverlayArtifactsPayload({
      limit: 2,
      lifecycle: "running",
      sessions: [],
      listArtifacts: () => records,
      resolveTask: () => null,
      resolveSession: () => null,
      resolveAgentName: () => null,
      now: () => 100,
    });

    expect(payload.query.limit).toBe(2);
    expect(payload.query.lifecycle).toBe("running");
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]?.id).toBe("art_b");
    expect(payload.stats.byLifecycle.running).toBe(1);
  });

  it("includes archived artifacts only when lifecycle filter allows it", () => {
    const records: ArtifactRecord[] = [
      makeRecord({ id: "art_alive", status: "completed", updatedAt: 10 }),
      makeRecord({ id: "art_dead", status: "completed", deletedAt: 50, updatedAt: 50 }),
    ];

    const archived = buildOverlayArtifactsPayload({
      lifecycle: "archived",
      sessions: [],
      listArtifacts: () => records,
      resolveTask: () => null,
      resolveSession: () => null,
      resolveAgentName: () => null,
      now: () => 100,
    });
    expect(archived.items.map((item) => item.id)).toEqual(["art_dead"]);

    const completed = buildOverlayArtifactsPayload({
      lifecycle: "completed",
      sessions: [],
      listArtifacts: () => records,
      resolveTask: () => null,
      resolveSession: () => null,
      resolveAgentName: () => null,
      now: () => 100,
    });
    expect(completed.items.map((item) => item.id)).toEqual(["art_alive"]);
  });

  it("filters by agentId in addition to the store-level filters", () => {
    const records: ArtifactRecord[] = [
      makeRecord({ id: "art_main", agentId: "main", updatedAt: 1 }),
      makeRecord({ id: "art_other", agentId: "other", updatedAt: 2 }),
      makeRecord({ id: "art_nobody", agentId: undefined, updatedAt: 3 }),
    ];

    const payload = buildOverlayArtifactsPayload({
      agentId: "other",
      sessions: [],
      listArtifacts: () => records,
      resolveTask: () => null,
      resolveSession: () => null,
      resolveAgentName: () => null,
      now: () => 100,
    });

    expect(payload.items.map((item) => item.id)).toEqual(["art_other"]);
    expect(payload.query.agentId).toBe("other");
  });

  it("flags artifacts inside the recent window in stats.recentCount", () => {
    const now = 100_000;
    const dayMs = 24 * 60 * 60 * 1000;
    const records: ArtifactRecord[] = [
      makeRecord({ id: "art_recent", updatedAt: now - 1_000 }),
      makeRecord({ id: "art_old", updatedAt: now - dayMs - 1 }),
    ];

    const payload = buildOverlayArtifactsPayload({
      sessions: [],
      listArtifacts: () => records,
      resolveTask: () => null,
      resolveSession: () => null,
      resolveAgentName: () => null,
      now: () => now,
    });

    expect(payload.stats.total).toBe(2);
    expect(payload.stats.recentCount).toBe(1);
  });
});

describe("artifacts helpers", () => {
  it("normalizes lifecycle to one of the canonical values", () => {
    expect(normalizeLifecycle("Completed")).toBe("completed");
    expect(normalizeLifecycle(" archived ")).toBe("archived");
    expect(normalizeLifecycle("nope")).toBeNull();
    expect(normalizeLifecycle(null)).toBeNull();
  });

  it("clamps the artifacts limit to the supported range", () => {
    expect(normalizeArtifactsLimit(undefined)).toBe(80);
    expect(normalizeArtifactsLimit(0)).toBe(80);
    expect(normalizeArtifactsLimit(5)).toBe(5);
    expect(normalizeArtifactsLimit(99999)).toBe(200);
    expect(normalizeArtifactsLimit("12")).toBe(12);
  });

  it("derives lifecycle from raw status and deletion flag", () => {
    expect(deriveLifecycle({ status: "completed", deletedAt: undefined })).toBe("completed");
    expect(deriveLifecycle({ status: "succeeded", deletedAt: undefined })).toBe("completed");
    expect(deriveLifecycle({ status: "failed", deletedAt: undefined })).toBe("failed");
    expect(deriveLifecycle({ status: "queued", deletedAt: undefined })).toBe("pending");
    expect(deriveLifecycle({ status: "active", deletedAt: undefined })).toBe("running");
    expect(deriveLifecycle({ status: "archived", deletedAt: undefined })).toBe("archived");
    expect(deriveLifecycle({ status: "completed", deletedAt: 1 })).toBe("archived");
  });
});

describe("resolveArtifactBlob", () => {
  const allowlistRoots = ["/Users/luis/.ravi", "/Users/luis/dev/filipelabs"];

  function makeBlobRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
    return makeRecord({
      id: "art_blob_1",
      kind: "image",
      filePath: "/Users/luis/.ravi/artifacts/blobs/aa/diagram.png",
      mimeType: "image/png",
      ...overrides,
    });
  }

  it("returns 400 when the artifact id is empty", async () => {
    const result = await resolveArtifactBlob({
      artifactId: "  ",
      getArtifact: () => null,
      realpath: async (path) => path,
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.code).toBe("missing_id");
    }
  });

  it("returns 404 when the ledger has no record for the id", async () => {
    const result = await resolveArtifactBlob({
      artifactId: "art_unknown",
      getArtifact: () => null,
      realpath: async (path) => path,
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("not_found");
    }
  });

  it("returns 404 when the artifact has no local path", async () => {
    const record = makeBlobRecord({ filePath: undefined, blobPath: undefined, uri: "https://example.com/x.png" });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("no_path");
    }
  });

  it("returns 404 when the deleted artifact is gone", async () => {
    const record = makeBlobRecord({ deletedAt: 999 });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("not_found");
    }
  });

  it("returns 403 when the canonical path falls outside the allowlist", async () => {
    const record = makeBlobRecord({ filePath: "/etc/passwd.png", blobPath: undefined });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (_path) => "/etc/passwd.png",
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("outside_allowlist");
    }
  });

  it("blocks path traversal even when the record path looks safe", async () => {
    const record = makeBlobRecord({
      filePath: "/Users/luis/.ravi/artifacts/blobs/../../../../etc/passwd.png",
      blobPath: undefined,
    });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (_path) => "/etc/passwd.png",
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("outside_allowlist");
    }
  });

  it("returns 415 when the file extension maps to a non-image MIME", async () => {
    const record = makeBlobRecord({ filePath: "/Users/luis/.ravi/notes.json", blobPath: undefined });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(415);
      expect(result.code).toBe("unsupported_media_type");
    }
  });

  it("returns 413 when the file size exceeds the configured limit", async () => {
    const record = makeBlobRecord({ blobPath: undefined });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: ARTIFACT_BLOB_MAX_BYTES + 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.code).toBe("too_large");
    }
  });

  it("returns 200 metadata for a valid image inside the allowlist", async () => {
    const record = makeBlobRecord();
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 4096 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("/Users/luis/.ravi/artifacts/blobs/aa/diagram.png");
      expect(result.mimeType).toBe("image/png");
      expect(result.sizeBytes).toBe(4096);
      expect(result.artifactId).toBe(record.id);
    }
  });

  it("falls back to blobPath when filePath is missing", async () => {
    const record = makeBlobRecord({
      filePath: undefined,
      blobPath: "/Users/luis/dev/filipelabs/ravi.bot/.cache/cover.webp",
    });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 256 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("/Users/luis/dev/filipelabs/ravi.bot/.cache/cover.webp");
      expect(result.mimeType).toBe("image/webp");
    }
  });

  it("returns 404 when the canonical path is unreadable", async () => {
    const record = makeBlobRecord({ blobPath: undefined });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.code).toBe("not_found");
    }
  });

  it("falls back to blobPath when filePath is outside the allowlist", async () => {
    const record = makeBlobRecord({
      filePath: "/var/folders/xx/ravi-image-tmp.png",
      blobPath: "/Users/luis/.ravi/artifacts/blobs/aa/aa.png",
    });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 2048 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("/Users/luis/.ravi/artifacts/blobs/aa/aa.png");
      expect(result.mimeType).toBe("image/png");
    }
  });

  it("falls back to blobPath when filePath realpath fails", async () => {
    const record = makeBlobRecord({
      filePath: "/Users/luis/.ravi/artifacts/blobs/missing.png",
      blobPath: "/Users/luis/.ravi/artifacts/blobs/aa/aa.png",
    });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => {
        if (path.includes("missing.png")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return path;
      },
      stat: async () => ({ size: 32 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("/Users/luis/.ravi/artifacts/blobs/aa/aa.png");
    }
  });

  it("propagates the latest failure when every candidate path is rejected", async () => {
    const record = makeBlobRecord({
      filePath: "/var/folders/tmp/a.png",
      blobPath: "/etc/secret.png",
    });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 1 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.code).toBe("outside_allowlist");
    }
  });

  it("accepts a file:// URI when filePath/blobPath are missing", async () => {
    const record = makeBlobRecord({
      filePath: undefined,
      blobPath: undefined,
      uri: "file:///Users/luis/.ravi/artifacts/blobs/aa/aa.png",
    });
    const result = await resolveArtifactBlob({
      artifactId: record.id,
      getArtifact: () => record,
      realpath: async (path) => path,
      stat: async () => ({ size: 100 }),
      allowlistRoots,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe("/Users/luis/.ravi/artifacts/blobs/aa/aa.png");
    }
  });
});
