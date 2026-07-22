import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAppManifests } from "../service.js";
import { merchantOfficialContract, merchantOperationMatrix } from "./contract.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "ravi.app.json"), "utf8")) as {
  operations: Record<
    string,
    {
      interface: string;
      namespace?: string;
      method?: string;
      command?: string;
      mutating: boolean;
      permission?: string;
    }
  >;
  permissions: { required: string[]; optional: string[]; mutating: string[] };
  officialContract: { stableSubApis: string[]; limitedSubApis: string[]; phase: string };
};

describe("Google Merchant Ravi App contract", () => {
  it("passes native Ravi App manifest validation without recursive CLI operations", () => {
    expect(checkAppManifests("merchant", { cwd: process.cwd() })).toEqual([
      expect.objectContaining({ id: "merchant", ok: true, errors: [] }),
    ]);
    expect(Object.values(manifest.operations).some((operation) => operation.command?.includes("sde"))).toBe(false);
    expect(Object.values(manifest.operations).some((operation) => operation.command?.startsWith("ravi merchant"))).toBe(
      false,
    );
  }, 15_000);

  it("maps domain operations to the generated SDK namespace", () => {
    const sdkOperations = Object.entries(manifest.operations).filter(([, operation]) => operation.interface === "sdk");
    expect(sdkOperations.length).toBeGreaterThanOrEqual(19);
    expect(sdkOperations.every(([, operation]) => operation.namespace === "merchant" && operation.method)).toBe(true);
    expect(manifest.operations["merchant.contract"]?.method).toBe("contract");
    expect(manifest.operations["merchant.product-patch"]?.method).toBe("productPatch");
  });

  it("separates read, write, destructive and financial permissions", () => {
    const byPermission = Object.values(manifest.operations).reduce<Record<string, number>>((counts, operation) => {
      if (operation.permission) counts[operation.permission] = (counts[operation.permission] ?? 0) + 1;
      return counts;
    }, {});
    expect(byPermission["merchant:read"]).toBeGreaterThan(0);
    expect(byPermission["merchant:write"]).toBeGreaterThan(0);
    expect(byPermission["merchant:destructive"]).toBeGreaterThan(0);
    expect(byPermission["merchant:financial"]).toBeGreaterThan(0);
    expect(manifest.permissions.required).toEqual(["merchant:read"]);
    expect(manifest.permissions.mutating).toEqual(
      expect.arrayContaining(["merchant:write", "merchant:destructive", "merchant:financial"]),
    );
  });

  it("records the current stable and limited official sub-APIs without v1beta targets", () => {
    expect(merchantOfficialContract.confirmed).toBe(true);
    expect(manifest.officialContract.stableSubApis).toContain("products_v1");
    expect(manifest.officialContract.stableSubApis).toContain("issueresolution_v1");
    expect(manifest.officialContract.stableSubApis.some((version) => version.includes("v1beta"))).toBe(false);
    expect(manifest.officialContract.limitedSubApis).toEqual(
      expect.arrayContaining(["productstudio_v1alpha", "reviews_v1alpha"]),
    );
    expect(manifest.officialContract.phase).toBe("structure-without-real-authentication");
  });

  it("covers every current legacy domain operation once with the required decision fields", () => {
    const operations = merchantOperationMatrix.map((entry) => entry.operacao_sde);
    expect(operations).toHaveLength(160);
    expect(new Set(operations).size).toBe(160);
    expect(
      merchantOperationMatrix.every(
        (entry) =>
          entry.categoria &&
          entry.risco_read_write &&
          entry.endpoint_ou_recurso_oficial &&
          entry.status_decisao &&
          entry.justificativa &&
          entry.fonte_oficial &&
          entry.observacoes_para_ravi_dev,
      ),
    ).toBe(true);
    expect(
      merchantOperationMatrix.some(
        (entry) => entry.operacao_sde === "product-patch" && entry.operacao_ravi?.includes("merchant.product-patch"),
      ),
    ).toBe(true);
  });

  it("does not invent unstable Reviews, Product Studio or unverified CSS endpoints", () => {
    for (const operation of ["product-reviews", "merchant-reviews", "ps-text-suggestions", "css-products"]) {
      const entry = merchantOperationMatrix.find((candidate) => candidate.operacao_sde === operation);
      if (!entry) throw new Error(`Missing migration matrix entry for ${operation}`);
      expect(["estudar", "aguardar"]).toContain(entry.status_decisao);
      expect(entry.operacao_ravi).toBeNull();
    }
  });
});
