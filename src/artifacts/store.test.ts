import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { attachArtifact, createArtifact, getArtifactDetails, listArtifacts, updateArtifact } from "./store.js";

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
  });

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

    const link = attachArtifact(artifact.id, "task", "task-123", "evidence", { required: true });
    expect(link).toMatchObject({ targetType: "task", targetId: "task-123", relation: "evidence" });

    const details = getArtifactDetails(artifact.id);
    expect(details?.links).toHaveLength(1);
    expect(details?.events.map((event) => event.eventType)).toContain("artifact.attached");
  });
});
