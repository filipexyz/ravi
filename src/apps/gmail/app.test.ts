import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppManifests } from "../service.js";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

type Operation = {
  interface: string;
  command?: string;
  mutating: boolean;
  permission?: string;
};

describe("Gmail Ravi App contract", () => {
  const manifest = JSON.parse(readFileSync(join(appRoot, "ravi.app.json"), "utf8")) as {
    operations: Record<string, Operation>;
    permissions: { required: string[]; optional: string[]; mutating: string[] };
    skills: string[];
  };

  it("is a valid first-party app manifest", () => {
    const result = checkAppManifests("gmail", { cwd: repositoryRoot });
    expect(result).toHaveLength(1);
    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.errors).toEqual([]);
  });

  it("delegates only to the native Ravi Gmail command", () => {
    const commands = Object.values(manifest.operations).flatMap((operation) =>
      operation.command ? [operation.command] : [],
    );
    expect(commands).toHaveLength(3);
    expect(commands.every((command) => command.startsWith("ravi gmail "))).toBe(true);
    expect(commands.every((command) => command.includes("--native --connection default"))).toBe(true);
    expect(commands.some((command) => command.includes("sde"))).toBe(false);
    expect(manifest.skills).toEqual([]);
  });

  it("separates mailbox reads from irreversible message delivery", () => {
    const reads = Object.entries(manifest.operations).filter(([, operation]) => !operation.mutating);
    const mutations = Object.entries(manifest.operations).filter(([, operation]) => operation.mutating);

    expect(reads.map(([id]) => id).sort()).toEqual(["gmail.check", "gmail.list", "gmail.read"]);
    expect(
      reads.filter(([id]) => id !== "gmail.check").every(([, operation]) => operation.permission === "gmail:read"),
    ).toBe(true);
    expect(mutations.map(([id]) => id)).toEqual(["gmail.send"]);
    expect(mutations[0]?.[1].permission).toBe("gmail:send");
    expect(manifest.permissions.required).toEqual(["gmail:read"]);
    expect(manifest.permissions.optional).toEqual(["gmail:write", "gmail:destructive"]);
    expect(manifest.permissions.mutating).toEqual(["gmail:write", "gmail:send", "gmail:destructive"]);
  });
});
