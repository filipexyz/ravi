/**
 * Unit tests for the SDK codegen.
 *
 * Coverage:
 *   - Determinism: emitting twice against the same registry produces byte-
 *     identical output.
 *   - Mock registry → expected snapshot of public surface (method names,
 *     parameters, return types, schema constants).
 *   - Tricky inputs: variadic args, options bag, no args / no options.
 */

import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { Arg, Command, Group, Option, Returns } from "../../cli/decorators.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import { computeRegistryHash, emitAll } from "./index.js";

@Group({ name: "artifacts", description: "Artifact ops", scope: "open" })
class ArtifactsCommands {
  @Command({ name: "show", description: "Show an artifact" })
  @Returns(z.object({ id: z.string(), kind: z.string() }))
  show(@Arg("id", { description: "Artifact ID" }) _id: string) {
    return { id: "x", kind: "y" };
  }
}

@Group({ name: "context.credentials", description: "Credentials", scope: "open" })
class ContextCredentialsCommands {
  @Command({ name: "list", description: "List credentials" })
  list(@Option({ flags: "--limit <n>", description: "Max rows" }) _limit?: string) {
    return [];
  }

  @Command({ name: "rotate", description: "Rotate keys", aliases: ["roll"] })
  @Returns(z.object({ ok: z.boolean() }))
  rotate(
    @Arg("agentId") _agentId: string,
    @Arg("paths", { variadic: true }) _paths: string[],
    @Option({ flags: "--dry-run" }) _dry?: boolean,
  ) {
    return { ok: true };
  }
}

const FIXED_VERSION = {
  sdkVersion: "9.9.9",
  registryHash: "sha256:fixed",
  gitSha: "fixed",
};

function emitMockSdk() {
  const registry = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
  return { registry, output: emitAll(registry, { version: FIXED_VERSION }) };
}

describe("client-codegen :: emitAll", () => {
  it("is deterministic across re-runs", () => {
    const a = emitMockSdk().output;
    const b = emitMockSdk().output;
    expect(a.client).toBe(b.client);
    expect(a.schemas).toBe(b.schemas);
    expect(a.types).toBe(b.types);
    expect(a.version).toBe(b.version);
  });

  it("emits a method per command, nested by group segments", () => {
    const { output } = emitMockSdk();
    expect(output.client).toContain("readonly artifacts =");
    expect(output.client).toContain("readonly context =");
    expect(output.client).toContain("credentials:");
    expect(output.client).toContain("show:");
    expect(output.client).toContain("list:");
    expect(output.client).toContain("rotate:");
  });

  it("orders methods alphabetically within a namespace", () => {
    const { output } = emitMockSdk();
    const credStart = output.client.indexOf("credentials:");
    expect(credStart).toBeGreaterThan(-1);
    const tail = output.client.slice(credStart, credStart + 1500);
    expect(tail.indexOf("list:")).toBeLessThan(tail.indexOf("rotate:"));
  });

  it("threads arg + option types into method signatures", () => {
    const { output } = emitMockSdk();
    expect(output.client).toContain("show: async (id: string)");
    expect(output.client).toContain(`groupSegments: ["artifacts"]`);
    expect(output.client).toContain(`command: "show"`);
    expect(output.client).toContain(`body: { id }`);
  });

  it("collapses options into a trailing object bag", () => {
    const { output } = emitMockSdk();
    expect(output.client).toMatch(/list: async \(options\?: \{\s+limit\?: string;\s+\}\)/);
    expect(output.client).toContain(`body: { ...(options ?? {}) }`);
  });

  it("represents variadic args as arrays (last positional)", () => {
    const { output } = emitMockSdk();
    expect(output.client).toMatch(/rotate: async \(agentId: string, paths: string\[\]/);
    expect(output.client).toContain(`body: { agentId, paths, ...(options ?? {}) }`);
  });

  it("uses inferred return type when @Returns is declared", () => {
    const { output } = emitMockSdk();
    expect(output.client).toContain("Promise<ArtifactsShowReturn>");
    expect(output.types).toContain("export type ArtifactsShowReturn = {");
    expect(output.types).toMatch(/id: string;/);
    expect(output.types).toMatch(/kind: string;/);
  });

  it("falls back to unknown for return when no @Returns", () => {
    const { output } = emitMockSdk();
    expect(output.types).toContain("export type ContextCredentialsListReturn = unknown;");
  });

  it("emits sorted JSON Schema constants in schemas.ts", () => {
    const { output } = emitMockSdk();
    expect(output.schemas).toContain("export const ArtifactsShowInputSchema = ");
    // alphabetic key ordering (additionalProperties before properties before required)
    const inputBlock = output.schemas.slice(
      output.schemas.indexOf("ArtifactsShowInputSchema"),
      output.schemas.indexOf("ArtifactsShowInputSchema") + 600,
    );
    expect(inputBlock.indexOf('"additionalProperties"')).toBeLessThan(inputBlock.indexOf('"properties"'));
    expect(inputBlock.indexOf('"properties"')).toBeLessThan(inputBlock.indexOf('"required"'));
  });

  it("imports return types from ./types.js", () => {
    const { output } = emitMockSdk();
    expect(output.client).toContain("import type { ArtifactsShowReturn");
    expect(output.client).toContain('from "./types.js"');
  });

  it("emits version.ts with the supplied fields", () => {
    const { output } = emitMockSdk();
    expect(output.version).toContain('export const SDK_VERSION = "9.9.9";');
    expect(output.version).toContain('export const REGISTRY_HASH = "sha256:fixed";');
    expect(output.version).toContain('export const GIT_SHA = "fixed";');
  });
});

describe("client-codegen :: computeRegistryHash", () => {
  it("is stable across calls with the same registry", () => {
    const r = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
    const h1 = computeRegistryHash(r);
    const h2 = computeRegistryHash(r);
    expect(h1).toBe(h2);
    expect(h1.startsWith("sha256:")).toBe(true);
  });

  it("changes when the registry shape changes", () => {
    const r1 = buildRegistry([ArtifactsCommands]);
    const r2 = buildRegistry([ArtifactsCommands, ContextCredentialsCommands]);
    expect(computeRegistryHash(r1)).not.toBe(computeRegistryHash(r2));
  });
});
