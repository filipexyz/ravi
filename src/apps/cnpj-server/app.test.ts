import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkAppManifests, getAppManifest } from "../service.js";
import { CNPJ_TAILSCALE_BASE_URL } from "./client.js";

const repoRoot = join(import.meta.dir, "../../..");

describe("CNPJ Server Ravi App manifest", () => {
  it("is discoverable and valid from the repository root", () => {
    const [check] = checkAppManifests("cnpj-server", {
      cwd: repoRoot,
      env: { ...process.env, RAVI_STATE_DIR: join(repoRoot, ".test-state") },
    });
    expect(check?.ok).toBe(true);
    expect(check?.errors).toEqual([]);

    const app = getAppManifest("cnpj-server", {
      cwd: repoRoot,
      env: { ...process.env, RAVI_STATE_DIR: join(repoRoot, ".test-state") },
    });
    expect(app.source).toBe("repo");
    expect(app.interfaceNames).toEqual(["cli"]);
    expect(app.permissions.required).toEqual(["cnpj:read"]);
    expect(app.permissions.mutating).toEqual(["write_contacts"]);
  });

  it("declares bounded reads plus the explicitly gated CRM export and no app-owned state or events", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "ravi.app.json"), "utf8")) as {
      interfaces: { cli: { command: string; json: boolean; health: string } };
      operations: Record<string, { interface: string; command?: string; mutating: boolean; permission?: string }>;
      operationClasses: Record<string, string[]>;
      permissions: { required: string[]; optional: string[]; mutating: string[] };
      storage: { sqlite: unknown[]; files: unknown[] };
      artifacts: unknown[];
      events: { emits: unknown[]; consumes: unknown[] };
      health: { checks: Array<{ type: string; command?: string }> };
    };

    expect(manifest.interfaces.cli).toEqual({
      command: "ravi cnpj",
      json: true,
      health: `ravi cnpj health --base-url ${CNPJ_TAILSCALE_BASE_URL} --json`,
    });
    expect(manifest.operationClasses.read).toEqual(["cnpj-server.health", "cnpj-server.get", "cnpj-server.search"]);
    expect(manifest.operationClasses.write).toEqual(["cnpj-server.export-crm"]);
    expect(manifest.operationClasses.destructive).toEqual([]);
    expect(manifest.operationClasses.financial).toEqual([]);

    for (const operationId of manifest.operationClasses.read) {
      const operation = manifest.operations[operationId];
      expect(operation).toMatchObject({
        interface: "cli",
        mutating: false,
        permission: "cnpj:read",
      });
      expect(operation?.command).toContain("--json");
      expect(operation?.command).not.toContain("cnpj.sdebot.top");
      expect(operation?.command).not.toContain("--insecure");
    }
    expect(manifest.operations["cnpj-server.export-crm"]).toEqual({
      interface: "cli",
      command: "ravi cnpj export-crm {args} --json",
      mutating: true,
      permission: "write_contacts",
    });
    expect(manifest.permissions).toEqual({
      required: ["cnpj:read"],
      optional: [],
      mutating: ["write_contacts"],
    });
    expect(manifest.storage).toEqual({ sqlite: [], files: [] });
    expect(manifest.artifacts).toEqual([]);
    expect(manifest.events).toEqual({ emits: [], consumes: [] });
    expect(manifest.health.checks.some((check) => check.command?.includes(CNPJ_TAILSCALE_BASE_URL))).toBe(true);
  });
});
