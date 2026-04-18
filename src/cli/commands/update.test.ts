import { describe, expect, it } from "bun:test";
import { detectFromBinaryPath, findPackageRoot, packageTagForChannel, resolveUpdateChannel } from "./update.js";

describe("update command helpers", () => {
  it("resolves explicit channel flags before persisted config", () => {
    expect(resolveUpdateChannel({ next: true }, { updateChannel: "latest" })).toBe("next");
    expect(resolveUpdateChannel({ stable: true }, { updateChannel: "next" })).toBe("latest");
  });

  it("uses persisted channel and falls back to latest", () => {
    expect(resolveUpdateChannel({}, { updateChannel: "next" })).toBe("next");
    expect(resolveUpdateChannel({}, {})).toBe("latest");
  });

  it("formats package tags for npm channels", () => {
    expect(packageTagForChannel("next")).toBe("ravi.bot@next");
    expect(packageTagForChannel("latest")).toBe("ravi.bot@latest");
  });

  it("detects common global install paths", () => {
    expect(detectFromBinaryPath("/Users/luis/.bun/bin/ravi")).toBe("bun");
    expect(detectFromBinaryPath("/opt/node/lib/node_modules/ravi.bot/bin/ravi")).toBe("npm");
  });

  it("finds the package root from this test file", () => {
    const root = findPackageRoot(import.meta.path);
    expect(root?.endsWith("ravi.bot")).toBe(true);
  });
});
