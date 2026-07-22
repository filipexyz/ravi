import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAppManifests, getAppManifest } from "../service.js";
import { confirmedOfficialContract, mlOperationMatrix } from "./contract.js";

const manifestPath = join(import.meta.dir, "ravi.app.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  operations: Record<string, { command?: string; mutating?: boolean; permission?: string }>;
  permissions: { required: string[]; optional: string[]; mutating: string[] };
  storage: { sqlite: unknown[]; files: unknown[] };
  skills: string[];
  officialContract: { confirmed: boolean; phase: string };
};

describe("Mercado Livre Ravi App", () => {
  it("is a valid discoverable first-party Ravi App", () => {
    const record = getAppManifest("mercado-livre", { cwd: process.cwd() });
    const checks = checkAppManifests("mercado-livre", { cwd: process.cwd() });

    expect(record.valid).toBe(true);
    expect(record.errors).toEqual([]);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.ok).toBe(true);
  }, 30_000);

  it("routes every provider operation to native ravi ml commands, never SDE", () => {
    const commands = Object.values(manifest.operations).flatMap((operation) =>
      operation.command ? [operation.command] : [],
    );

    expect(commands.length).toBeGreaterThan(30);
    expect(commands.every((command) => command.startsWith("ravi ml "))).toBe(true);
    expect(commands.some((command) => /\bsde\b/.test(command))).toBe(false);
  });

  it("separates read, write, destructive and financial permissions", () => {
    expect(manifest.permissions.required).toContain("ml:financial:read");
    expect(manifest.permissions.optional).toContain("ml:catalog:write");
    expect(manifest.permissions.optional).toContain("ml:catalog:destructive");
    expect(manifest.permissions.mutating).toContain("ml:communication:write");
    expect(manifest.permissions.mutating).not.toContain("ml:financial:read");

    expect(manifest.operations["mercado-livre.item-close"]?.permission).toBe("ml:catalog:destructive");
    expect(manifest.operations["mercado-livre.item-prices"]?.mutating).toBe(false);
    expect(Object.keys(manifest.operations).some((id) => id.includes("price-update"))).toBe(false);
  });

  it("keeps unsupported and composite legacy behavior out of the native surface", () => {
    expect(confirmedOfficialContract).toBe(true);
    expect(manifest.officialContract).toMatchObject({
      confirmed: true,
      phase: "structure-without-real-authentication",
    });
    expect(mlOperationMatrix.find((entry) => entry.operacao_sde === "anuncio-preco")).toMatchObject({
      status_decisao: "aguardar",
      operacao_ravi: null,
    });
    expect(mlOperationMatrix.find((entry) => entry.operacao_sde === "postagem *")).toMatchObject({
      status_decisao: "aguardar",
      operacao_ravi: null,
    });
    expect(
      mlOperationMatrix.find((entry) => entry.operacao_sde === "pedido-fiscal")?.endpoint_ou_recurso_oficial,
    ).toContain("/orders/billing-info/");
  });

  it("persists no provider payloads and embeds no credential skill or storage", () => {
    expect(manifest.storage).toEqual({ sqlite: [], files: [] });
    expect(manifest.skills).toEqual([]);
    expect(readFileSync(manifestPath, "utf8")).not.toMatch(/access_token|refresh_token|client_secret|Bearer\s/i);
  });
});
