import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppManifests } from "../service.js";

const root = fileURLToPath(new URL(".", import.meta.url));

describe("Frete App contract", () => {
  const manifest = JSON.parse(readFileSync(join(root, "ravi.app.json"), "utf8")) as {
    operations: Record<
      string,
      {
        interface: string;
        command?: string;
        namespace?: string;
        method?: string;
        mutating: boolean;
        permission?: string;
      }
    >;
    permissions: { required: string[]; optional: string[]; mutating: string[] };
    externalContracts: Array<{ provider: string; documentation: string; verifiedAt: string; operations: string[] }>;
  };

  it("is a valid native App manifest", () => {
    expect(checkAppManifests("frete")).toEqual([
      expect.objectContaining({
        id: "frete",
        ok: true,
        errors: [],
        warnings: [],
      }),
    ]);
  });

  it("maps the quote operation to the native generated SDK and one verified external contract", () => {
    const commands = Object.values(manifest.operations).flatMap((operation) =>
      operation.command ? [operation.command] : [],
    );
    expect(commands).toEqual([]);
    expect(commands.some((command) => command.includes("sde"))).toBe(false);
    expect(manifest.operations["frete.quote"]).toMatchObject({
      interface: "sdk",
      namespace: "frete",
      method: "quote",
    });
    expect(manifest.externalContracts).toHaveLength(1);
    expect(manifest.externalContracts[0]).toMatchObject({
      provider: "olist-tiny",
      documentation: "https://tiny.com.br/api-docs/api2-cotacao-fretes",
      verifiedAt: "2026-07-13",
      operations: ["frete.quote"],
    });
  });

  it("separates read, write, destructive and financial permissions", () => {
    expect(manifest.operations["frete.quote"]).toMatchObject({
      mutating: false,
      permission: "frete:quotes:read",
    });
    expect(manifest.permissions.required).toEqual(["frete:quotes:read"]);
    expect(manifest.permissions.mutating).toEqual([
      "frete:shipments:write",
      "frete:shipments:destructive",
      "frete:charges:financial",
    ]);
    expect(new Set(manifest.permissions.optional).size).toBe(3);
    expect(Object.values(manifest.operations).filter((operation) => operation.mutating)).toEqual([]);
  });
});
