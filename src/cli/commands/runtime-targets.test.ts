import { describe, expect, it } from "bun:test";
import { getRegistry } from "../registry-snapshot.js";
import { RuntimeTargetsCommands } from "./runtime-targets.js";

describe("runtime targets CLI", () => {
  it("publishes an agent-first typed explain command", () => {
    const command = getRegistry([RuntimeTargetsCommands]).commands.find(
      (entry) => entry.fullName === "runtime.targets.explain",
    );
    expect(command?.description).toContain("without executing");
    expect(command?.options.some((option) => option.name === "agentId" || option.name === "agent")).toBe(true);
    expect(command?.returns).toBeDefined();
    expect(command?.access).toMatchObject({ kind: "read", risk: "low" });
  });
});
