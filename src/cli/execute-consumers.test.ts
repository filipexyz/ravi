import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../..");

function sourceLines(path: string, marker: string): string[] {
  return readFileSync(join(repoRoot, path), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes(marker));
}

describe("braked command consumers", () => {
  it("keeps every generated tasks dispatch instruction executable", () => {
    const lines = [
      ...sourceLines("src/cli/commands/tasks.ts", "ravi tasks dispatch"),
      ...sourceLines("src/tasks/profiles.ts", "ravi tasks dispatch"),
    ];

    expect(lines).toHaveLength(4);
    for (const line of lines) expect(line).toContain("--execute");
  });

  it("keeps session message mutation hints executable", () => {
    const source = readFileSync(join(repoRoot, "src/cli/commands/sessions.ts"), "utf8");

    expect(source).toContain("ravi sessions delete-message <message-id> --execute");
    expect(source).toContain('ravi sessions edit-message <message-id> "novo texto" --execute');
    expect(source).toContain('ravi sessions edit-message <message-id> "new text" --execute');
  });
});
