import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { attachTagSlugsToAsset, dbFindTagBindings } from "../tags/index.js";
import {
  appendArtifactEvent,
  attachArtifact,
  createArtifact,
  createArtifactVersion,
  getArtifactDetails,
  getArtifactVersion,
  listArtifactEvents,
  listArtifactVersions,
  listArtifacts,
  listArtifactsPage,
  restoreArtifactVersion,
  updateArtifact,
} from "./store.js";

let stateDir: string | null = null;

describe("artifact store", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-artifacts-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("creates a generic artifact, stores file blob metadata and indexes lineage", () => {
    const filePath = join(stateDir!, "diagram.png");
    writeFileSync(filePath, "fake-png");

    const artifact = createArtifact({
      kind: "image",
      title: "Diagrama do Ravi Artifacts",
      filePath,
      provider: "openai",
      model: "gpt-image-2",
      prompt: "desenhe o sistema",
      sessionName: "dev",
      durationMs: 1234,
      totalTokens: 42,
      metadata: { outputFormat: "png" },
      lineage: { source: "ravi image generate" },
      tags: ["image", "generated"],
    });

    expect(artifact.id.startsWith("art_")).toBe(true);
    expect(artifact.sha256).toHaveLength(64);
    expect(artifact.blobPath).toContain("/artifacts/blobs/");
    expect(existsSync(artifact.blobPath!)).toBe(true);
    expect(artifact.metadata).toEqual({ outputFormat: "png" });

    const listed = listArtifacts({ session: "dev", tag: "image" });
    expect(listed.map((item) => item.id)).toEqual([artifact.id]);

    const mirroredBindings = dbFindTagBindings({ assetType: "artifact", assetId: artifact.id });
    expect(mirroredBindings.map((binding) => binding.tagSlug).sort()).toEqual(["generated", "image"]);
    expect(mirroredBindings.map((binding) => binding.source)).toEqual(["artifacts.tags_json", "artifacts.tags_json"]);

    attachTagSlugsToAsset({
      assetType: "artifact",
      assetId: artifact.id,
      tags: ["evidence"],
      source: "test",
      createdBy: "test",
    });
    expect(listArtifacts({ tag: "evidence" }).map((item) => item.id)).toEqual([artifact.id]);
  }, 15_000);

  it("edits metadata and attaches artifacts to arbitrary targets", () => {
    const artifact = createArtifact({
      kind: "report",
      title: "Review",
      metadata: { severity: "p1" },
      tags: ["initial"],
    });

    const updated = updateArtifact(
      artifact.id,
      { summary: "Review completo", metadata: { gate: "request_changes" } },
      { mergeMetadata: true },
    );
    expect(updated.summary).toBe("Review completo");
    expect(updated.metadata).toEqual({ severity: "p1", gate: "request_changes" });
    expect(updated.tags).toEqual(["initial"]);

    const retagged = updateArtifact(artifact.id, { tags: ["review"] });
    expect(retagged.tags).toEqual(["review"]);
    expect(
      dbFindTagBindings({ assetType: "artifact", assetId: artifact.id }).map((binding) => binding.tagSlug),
    ).toEqual(["review"]);

    const link = attachArtifact(artifact.id, "task", "task-123", "evidence", { required: true });
    expect(link).toMatchObject({ targetType: "task", targetId: "task-123", relation: "evidence" });

    const details = getArtifactDetails(artifact.id);
    expect(details?.links).toHaveLength(1);
    expect(details?.events.map((event) => event.eventType)).toContain("attached");
  });

  it("stores ordered lifecycle events with status, message, source and payload", () => {
    const artifact = createArtifact({
      kind: "image",
      title: "Async image",
      status: "pending",
    });

    appendArtifactEvent(artifact.id, {
      eventType: "started",
      status: "running",
      message: "Generation started",
      source: "test",
      payload: { provider: "openai" },
      actor: "dev",
    });
    appendArtifactEvent(artifact.id, {
      eventType: "completed",
      status: "completed",
      message: "Generation completed",
      source: "test",
      payload: { filePath: "/tmp/image.png" },
      actor: "dev",
    });

    const events = listArtifactEvents(artifact.id);
    expect(events.map((event) => event.eventType)).toEqual(["created", "started", "completed"]);
    expect(events[1]).toMatchObject({
      eventType: "started",
      status: "running",
      message: "Generation started",
      source: "test",
      actor: "dev",
      payload: { provider: "openai" },
    });
  });

  it("creates immutable content versions on create and content updates", () => {
    const firstPath = join(stateDir!, "artifact-v1.txt");
    const secondPath = join(stateDir!, "artifact-v2.txt");
    writeFileSync(firstPath, "version one");
    writeFileSync(secondPath, "version two");

    const artifact = createArtifact({
      kind: "report",
      title: "Hosted report",
      filePath: firstPath,
      output: { revision: 1 },
    });

    const initialVersions = listArtifactVersions(artifact.id);
    expect(initialVersions).toHaveLength(1);
    expect(initialVersions[0]?.versionNumber).toBe(1);
    expect(initialVersions[0]?.assets[0]).toMatchObject({
      path: "artifact-v1.txt",
      role: "primary",
      visibility: "inherit",
      sha256: artifact.sha256,
    });
    expect(initialVersions[0]?.manifest).toMatchObject({
      artifact: { id: artifact.id, kind: "report", title: "Hosted report" },
      version: { number: 1 },
      output: { revision: 1 },
    });

    const metadataOnly = updateArtifact(artifact.id, { metadata: { reviewed: true } }, { mergeMetadata: true });
    expect(metadataOnly.metadata).toEqual({ reviewed: true });
    expect(listArtifactVersions(artifact.id)).toHaveLength(1);

    const updated = updateArtifact(artifact.id, { filePath: secondPath, output: { revision: 2 } }, { actor: "dev" });
    const versions = listArtifactVersions(artifact.id);

    expect(updated.sha256).not.toBe(artifact.sha256);
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(versions[0]?.assets[0]?.sha256).toBe(artifact.sha256);
    expect(versions[1]?.assets[0]).toMatchObject({
      path: "artifact-v2.txt",
      role: "primary",
      sha256: updated.sha256,
    });
    expect(versions[1]?.createdBy).toBe("dev");
    expect(versions[1]?.metadata).toEqual({ updates: ["filePath", "output"] });

    const latest = getArtifactVersion(artifact.id);
    expect(latest?.versionNumber).toBe(2);
    expect(latest?.assets[0]?.blobPath).toBe(updated.blobPath);
  });

  it("restores an old version as a new audit-preserving version", () => {
    const firstPath = join(stateDir!, "restore-v1.txt");
    const secondPath = join(stateDir!, "restore-v2.txt");
    writeFileSync(firstPath, "restore version one");
    writeFileSync(secondPath, "restore version two");

    const original = createArtifact({
      kind: "report",
      title: "Restore smoke",
      filePath: firstPath,
      output: { revision: 1 },
    });
    const updated = updateArtifact(original.id, { filePath: secondPath, output: { revision: 2 } }, { actor: "dev" });

    expect(updated.sha256).not.toBe(original.sha256);

    const restored = restoreArtifactVersion(original.id, 1, { actor: "dev" });
    const versions = listArtifactVersions(original.id);

    expect(restored.restoredFrom.versionNumber).toBe(1);
    expect(restored.artifact.sha256).toBe(original.sha256);
    expect(restored.artifact.blobPath).toBe(original.blobPath);
    expect(restored.artifact.output).toEqual({ revision: 1 });
    expect(restored.restoreVersion.versionNumber).toBe(3);
    expect(restored.restoreVersion.assets[0]?.sha256).toBe(original.sha256);
    expect(restored.restoreVersion.metadata).toEqual({
      restoredFromVersionId: restored.restoredFrom.id,
      restoredFromVersionNumber: 1,
    });
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2, 3]);

    const events = listArtifactEvents(original.id);
    expect(events.map((event) => event.eventType)).toContain("version_restored");
  });

  it("supports manual snapshots for artifacts without file content", () => {
    const artifact = createArtifact({
      kind: "note",
      title: "Draft",
      metadata: { audience: "internal" },
    });
    expect(listArtifactVersions(artifact.id)).toEqual([]);

    const version = createArtifactVersion(artifact.id, {
      label: "first draft",
      manifest: { checkpoint: { reason: "draft" } },
      metadata: { reason: "manual checkpoint" },
      createdBy: "dev",
    });

    expect(version.versionNumber).toBe(1);
    expect(version.assets).toEqual([]);
    expect(version.label).toBe("first draft");
    expect(version.createdBy).toBe("dev");
    expect(version.manifest).toMatchObject({
      artifact: { id: artifact.id, kind: "note", title: "Draft" },
      checkpoint: { reason: "draft" },
      version: { number: 1 },
    });

    const details = getArtifactDetails(artifact.id);
    expect(details?.versions.map((item) => item.id)).toEqual([version.id]);
    expect(details?.events.map((event) => event.eventType)).toContain("version_created");
  });

  it("rejects absolute or traversal paths in version assets", () => {
    const artifact = createArtifact({ kind: "report", title: "Path hardening" });

    expect(() =>
      createArtifactVersion(artifact.id, {
        assets: [{ path: "/etc/passwd", role: "primary" }],
      }),
    ).toThrow(/Invalid artifact version asset path/);

    expect(() =>
      createArtifactVersion(artifact.id, {
        assets: [{ path: "assets/../secret.txt", role: "primary" }],
      }),
    ).toThrow(/Invalid artifact version asset path/);
  });

  it("paginates artifact lists while exposing the filtered total", () => {
    const first = createArtifact({ kind: "image", title: "First", status: "completed", agentId: "main" });
    const second = createArtifact({ kind: "image", title: "Second", status: "completed", agentId: "main" });
    createArtifact({ kind: "report", title: "Other", status: "completed", agentId: "other" });

    const page = listArtifactsPage({ kind: "image", agentId: "main", lifecycle: "completed", limit: 1, offset: 1 });

    expect(page.total).toBe(2);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);
    expect(page.items).toHaveLength(1);
    expect([first.id, second.id]).toContain(page.items[0]?.id);
  });
});
