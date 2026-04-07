import { describe, expect, it } from "bun:test";
import { resolveStreamCapabilities, resolveTopicPatterns } from "./server.js";

describe("cli stream server", () => {
  it("exposes the task runtime preset on the v3 substrate", () => {
    expect(resolveTopicPatterns("tasks")).toEqual(["ravi.task.>"]);
    expect(resolveStreamCapabilities("tasks")).toEqual([
      "snapshot.open",
      "ping",
      "task.create",
      "task.dispatch",
      "task.report",
      "task.done",
      "task.block",
      "task.fail",
    ]);
  });
});
