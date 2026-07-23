import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectFromBinaryPath,
  findPackageRoot,
  managedRuntimeMatchesSnapshot,
  packageTagForChannel,
  planManagedRuntimeRestart,
  resolveUpdateChannel,
} from "./update.js";

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
    expect(detectFromBinaryPath("/home/tester/.bun/bin/ravi")).toBe("bun");
    expect(detectFromBinaryPath("/opt/node/lib/node_modules/ravi.bot/bin/ravi")).toBe("npm");
  });

  it("finds the package root from this test file", () => {
    const root = findPackageRoot(import.meta.path);
    expect(root).toBeTruthy();
    const pkg = JSON.parse(readFileSync(join(root!, "package.json"), "utf8")) as { name?: string };
    expect(pkg.name).toBe("ravi.bot");
  });

  it("stops channel intake before restarting a mixed managed runtime", () => {
    expect(
      planManagedRuntimeRestart([
        { name: "ravi", status: "online" },
        { name: "ravi-channels", status: "online" },
      ]),
    ).toEqual([
      { action: "stop", processName: "ravi-channels" },
      { action: "restart", processName: "ravi" },
      { action: "restart", processName: "ravi-channels" },
    ]);
  });

  it("preserves which managed processes were running before the update", () => {
    expect(
      planManagedRuntimeRestart([
        { name: "ravi", status: "online" },
        { name: "ravi-channels", status: "stopped" },
      ]),
    ).toEqual([{ action: "restart", processName: "ravi" }]);
    expect(planManagedRuntimeRestart([{ name: "ravi", status: "stopped" }])).toEqual([]);
  });

  it("verifies every previously running process is online after restart", () => {
    const previous = [
      { name: "ravi", status: "online" },
      { name: "ravi-channels", status: "online" },
      { name: "unrelated", status: "online" },
    ];

    expect(
      managedRuntimeMatchesSnapshot(previous, [
        { name: "ravi", status: "online" },
        { name: "ravi-channels", status: "online" },
      ]),
    ).toBe(true);
    expect(
      managedRuntimeMatchesSnapshot(previous, [
        { name: "ravi", status: "online" },
        { name: "ravi-channels", status: "errored" },
      ]),
    ).toBe(false);
  });
});
