import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

describe("Google Search Console App contract", () => {
  const manifest = JSON.parse(readFileSync(join(root, "ravi.app.json"), "utf8")) as {
    operations: Record<string, { interface: string; command?: string; mutating?: boolean }>;
    skills: string[];
  };

  it("uses only native Ravi commands", () => {
    const commands = Object.values(manifest.operations).flatMap((operation) =>
      operation.command ? [operation.command] : [],
    );
    expect(commands.length).toBeGreaterThanOrEqual(20);
    expect(commands.every((command) => command.startsWith("ravi gsc "))).toBe(true);
    expect(commands.some((command) => command.includes("sde"))).toBe(false);
  });

  it("keeps deployment separate from agent and skill changes", () => {
    expect(manifest.skills).toEqual([]);
  });

  it("classifies every mutation explicitly", () => {
    const mutations = Object.values(manifest.operations).filter((operation) => operation.mutating);
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((operation) => operation.interface === "cli")).toBe(true);
  });
});
