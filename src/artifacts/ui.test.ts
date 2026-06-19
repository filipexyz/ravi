import { describe, expect, it } from "bun:test";
import { buildArtifactNotificationUiSpec } from "./ui.js";

describe("artifact UI specs", () => {
  it("builds a reusable notification spec from an artifact", () => {
    const spec = buildArtifactNotificationUiSpec({
      lifecycle: "completed",
      artifact: {
        id: "art_ui_123",
        kind: "image",
        title: "Artifact map",
        summary: "Generated artifact architecture map",
        status: "completed",
        provider: "openai",
        model: "gpt-image-2",
        sessionName: "wa-overlay-dev",
        sessionKey: "agent:dev:wa-overlay-dev",
        agentId: "dev",
        taskId: "task-123",
        updatedAt: 42,
      },
    });

    expect(spec).toMatchObject({
      schema: "ravi.ui/v1",
      kind: "ui.spec",
      component: "artifact.notification",
      key: "artifact.notification:art_ui_123:completed:42",
      props: {
        artifactId: "art_ui_123",
        title: "Artifact map",
        subtitle: "image · completed · openai · gpt-image-2",
        tone: "completed",
        sessionName: "wa-overlay-dev",
        taskId: "task-123",
      },
    });
    expect(spec.actions.map((action) => action.command)).toEqual([
      "overlay.artifacts.open",
      "overlay.tasks.open",
      "overlay.sessions.open",
    ]);
  });
});
