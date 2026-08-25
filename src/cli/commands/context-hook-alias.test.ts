import { describe, expect, it } from "bun:test";
import { getRegistry } from "../registry-snapshot.js";

describe("context Codex hook alias", () => {
  it("registers codex-tool-hook as a deprecated alias of codex-bash-hook", () => {
    const command = getRegistry().commands.find((entry) => entry.fullName === "context.codex-bash-hook");
    expect(command?.aliases).toEqual(["codex-tool-hook"]);
    expect(command?.access).toMatchObject({
      kind: "read",
      resource: "context",
      action: "codex-bash-hook",
    });
    expect(getRegistry().commands.some((entry) => entry.fullName === "context.codex-tool-hook")).toBe(false);
  });
});
