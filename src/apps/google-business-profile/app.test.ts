import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

describe("Google Business Profile App contract", () => {
  const manifest = JSON.parse(readFileSync(join(root, "ravi.app.json"), "utf8")) as {
    id: string;
    interfaces: { cli: { command: string; health: string } };
    operations: Record<string, { interface: string; command?: string; mutating?: boolean; permission?: string }>;
    permissions: { required: string[]; mutating: string[] };
    skills: string[];
  };

  it("uses a non-recursive native CLI and credential-free health check", () => {
    expect(manifest.id).toBe("google-business-profile");
    expect(manifest.interfaces.cli.command).toBe("ravi gbp");
    expect(manifest.interfaces.cli.health).toBe("ravi apps check google-business-profile --json");
    expect(manifest.interfaces.cli.health).not.toContain("accounts");
  });

  it("declares the implemented native operations without wrapping SDE", () => {
    const commands = Object.values(manifest.operations).flatMap((operation) =>
      operation.command ? [operation.command] : [],
    );
    expect(commands).toHaveLength(32);
    expect(commands.every((command) => command.startsWith("ravi gbp "))).toBe(true);
    expect(commands.some((command) => command.includes("sde"))).toBe(false);
  });

  it("separates reads, writes and destructive permissions with no financial surface", () => {
    const operations = Object.values(manifest.operations);
    const readPermissions = operations
      .filter((operation) => !operation.mutating && operation.permission)
      .map((operation) => operation.permission as string);
    const mutatingPermissions = operations
      .filter((operation) => operation.mutating)
      .map((operation) => operation.permission as string);

    expect(readPermissions.every((permission) => permission.endsWith(":read"))).toBe(true);
    expect(mutatingPermissions.some((permission) => permission.endsWith(":write"))).toBe(true);
    expect(mutatingPermissions.some((permission) => permission.endsWith(":delete"))).toBe(true);
    expect([...readPermissions, ...mutatingPermissions].some((permission) => permission.includes("financial"))).toBe(
      false,
    );
    expect(new Set(manifest.permissions.required)).toEqual(new Set(readPermissions));
    expect(new Set(manifest.permissions.mutating)).toEqual(new Set(mutatingPermissions));
  });

  it("keeps agent teaching changes outside this implementation task", () => {
    expect(manifest.skills).toEqual([]);
  });
});
