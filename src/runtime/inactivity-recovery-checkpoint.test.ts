import { describe, expect, it } from "bun:test";
import {
  buildInactivityRecoveryCheckpoint,
  inactivityRecoveryCompletionHasProgress,
} from "./inactivity-recovery-checkpoint.js";

describe("inactivity recovery checkpoint", () => {
  it("keeps a silent or empty recovery from counting as task progress", () => {
    expect(inactivityRecoveryCompletionHasProgress("")).toBe(false);
    expect(inactivityRecoveryCompletionHasProgress("   ")).toBe(false);
    expect(inactivityRecoveryCompletionHasProgress("@@SILENT@@")).toBe(false);
    expect(inactivityRecoveryCompletionHasProgress("@@SILENT@@\n")).toBe(false);
    expect(inactivityRecoveryCompletionHasProgress("HEARTBEAT_OK")).toBe(false);
    expect(inactivityRecoveryCompletionHasProgress("done @@SILENT@@")).toBe(true);
    expect(inactivityRecoveryCompletionHasProgress("updated artifacts/design.md")).toBe(true);
  });

  it("builds a bounded checkpoint with objective, progress, remaining work, and artifact hints", () => {
    const checkpoint = buildInactivityRecoveryCheckpoint({
      objective: "Restore the bolao frontend and update artifacts/design.md",
      taskId: "task-bolao",
      events: [
        {
          eventType: "assistant.message",
          preview: "Checking the design file.",
        },
        {
          eventType: "tool.start",
          preview: "bash",
          payloadJson: {
            toolId: "call-1",
            toolName: "bash",
            input: { command: "cat artifacts/design.md" },
          },
        },
        {
          eventType: "tool.end",
          status: "complete",
          preview: "bash",
          payloadJson: {
            toolId: "call-1",
            toolName: "bash",
            output: "wrote artifacts/design.md",
            isError: false,
          },
        },
        {
          eventType: "tool.start",
          preview: "read",
          payloadJson: { toolId: "call-2", toolName: "read", input: { path: "src/app.ts" } },
        },
      ],
    });

    expect(checkpoint).toContain("[Checkpoint]");
    expect(checkpoint).toContain("Objective:");
    expect(checkpoint).toContain("Restore the bolao frontend and update artifacts/design.md");
    expect(checkpoint).toContain("Task: task-bolao");
    expect(checkpoint).toContain("Verified progress:");
    expect(checkpoint).toContain("assistant: Checking the design file.");
    expect(checkpoint).toContain("bash completed: wrote artifacts/design.md");
    expect(checkpoint).toContain("Remaining work:");
    expect(checkpoint).toContain("incomplete tool `read`");
    expect(checkpoint).toContain("Artifact hints:");
    expect(checkpoint).toContain("artifacts/design.md");
    expect(checkpoint).toContain("src/app.ts");
    expect(checkpoint!.length).toBeLessThanOrEqual(1_600);
  });

  it("never tells the model to redo an approval that went unanswered", () => {
    const checkpoint = buildInactivityRecoveryCheckpoint({
      objective: "Plan the migration.",
      events: [
        {
          eventType: "tool.start",
          preview: "ExitPlanMode",
          payloadJson: { toolId: "tool-plan", toolName: "ExitPlanMode" },
        },
      ],
    });

    expect(checkpoint).not.toContain("redo incomplete tool `ExitPlanMode`");
    expect(checkpoint).toContain("`ExitPlanMode` was waiting for a human answer that never came");
    expect(checkpoint).toContain("Do not call it again on your own");
  });

  it("returns nothing when the turn trace has no task context", () => {
    expect(buildInactivityRecoveryCheckpoint({ objective: "  ", events: [] })).toBeNull();
  });
});
