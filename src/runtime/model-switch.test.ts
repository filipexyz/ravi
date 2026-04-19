import { describe, expect, it } from "bun:test";
import { applyDirectRuntimeModelSwitch, resolveRuntimeModelSwitchStrategy } from "./model-switch.js";

describe("runtime model switch strategy", () => {
  it("uses direct-set when the runtime handle supports live model switching", async () => {
    const calls: string[] = [];
    const handle = {
      setModel: async (model: string) => {
        calls.push(model);
      },
    };

    expect(resolveRuntimeModelSwitchStrategy(handle)).toBe("direct-set");
    expect(await applyDirectRuntimeModelSwitch(handle, "model-b")).toBe(true);
    expect(calls).toEqual(["model-b"]);
  });

  it("requires restart-next-turn when the runtime handle has no live model switch", async () => {
    const handle = {};

    expect(resolveRuntimeModelSwitchStrategy(handle)).toBe("restart-next-turn");
    expect(await applyDirectRuntimeModelSwitch(handle, "model-b")).toBe(false);
  });
});
