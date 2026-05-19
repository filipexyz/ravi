import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTuiEntrypoint } from "./tui-launcher.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ravi-tui-launcher-"));
  roots.push(root);
  return root;
}

function touch(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "", "utf8");
}

describe("TUI launcher", () => {
  it("uses the source TUI entrypoint in a checkout", () => {
    const root = makeRoot();
    const sourceEntrypoint = join(root, "src", "tui", "index.tsx");
    touch(sourceEntrypoint);

    expect(resolveTuiEntrypoint(root)).toBe(sourceEntrypoint);
  });

  it("uses the built TUI entrypoint in the published package layout", () => {
    const root = makeRoot();
    const builtEntrypoint = join(root, "dist", "tui", "index.js");
    touch(builtEntrypoint);

    expect(resolveTuiEntrypoint(root)).toBe(builtEntrypoint);
  });

  it("explains the packaging/build problem when no TUI entrypoint exists", () => {
    const root = makeRoot();

    expect(() => resolveTuiEntrypoint(root)).toThrow("dist/tui/");
  });
});
