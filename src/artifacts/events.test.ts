import { describe, expect, it } from "bun:test";
import { buildArtifactLifecyclePayload, resolveArtifactLifecycleTopic } from "./events.js";
import type { ArtifactEvent, ArtifactRecord } from "./store.js";

describe("artifact lifecycle events", () => {
  it("maps lifecycle event topics without promoting technical events", () => {
    expect(resolveArtifactLifecycleTopic({ eventType: "created" })).toBe("ravi.artifacts.created");
    expect(resolveArtifactLifecycleTopic({ eventType: "started", status: "running" })).toBe("ravi.artifacts.running");
    expect(resolveArtifactLifecycleTopic({ eventType: "completed" })).toBe("ravi.artifacts.completed");
    expect(resolveArtifactLifecycleTopic({ eventType: "failed" })).toBe("ravi.artifacts.failed");
    expect(resolveArtifactLifecycleTopic({ eventType: "updated", status: "completed" })).toBe(
      "ravi.artifacts.completed",
    );
    expect(resolveArtifactLifecycleTopic({ eventType: "version_created", status: "completed" })).toBeNull();
  });

  it("builds a compact payload with artifact and event correlation", () => {
    const artifact: ArtifactRecord = {
      id: "art_test_123",
      kind: "image",
      title: "Diagram",
      status: "completed",
      sessionName: "dev",
      agentId: "dev",
      createdAt: 1_000,
      updatedAt: 2_000,
      tags: [],
    };
    const event: ArtifactEvent = {
      id: 42,
      artifactId: artifact.id,
      eventType: "completed",
      status: "completed",
      message: "done",
      source: "test",
      createdAt: 2_000,
    };

    expect(buildArtifactLifecyclePayload({ artifact, event })).toMatchObject({
      version: 1,
      eventType: "artifact.lifecycle",
      lifecycle: "completed",
      artifact: {
        id: "art_test_123",
        kind: "image",
        title: "Diagram",
        status: "completed",
        sessionName: "dev",
        agentId: "dev",
      },
      event: {
        id: 42,
        artifactId: "art_test_123",
        eventType: "completed",
        status: "completed",
        message: "done",
        source: "test",
      },
      occurredAt: "1970-01-01T00:00:02.000Z",
    });
  });
});
