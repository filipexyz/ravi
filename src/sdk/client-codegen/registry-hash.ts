/**
 * Deterministic registry hash used by `version.ts` so callers can detect
 * server/SDK drift at runtime.
 *
 * The hash is derived from the JSON Schema projection of every command — the
 * same projection the SDK exposes — so any change that would alter the
 * generated client also bumps the hash.
 */

import { createHash } from "node:crypto";
import type { RegistrySnapshot, CommandRegistryEntry } from "../../cli/registry-snapshot.js";
import { buildInputSchema, buildReturnSchema } from "./registry-shape.js";
import { stableStringify } from "./stable-json.js";

export function computeRegistryHash(registry: RegistrySnapshot): string {
  const sorted = [...registry.commands].sort((a, b) =>
    a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0,
  );
  const projection = sorted.map((cmd) => commandFingerprint(cmd));
  const payload = stableStringify(projection, 0);
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

function commandFingerprint(cmd: CommandRegistryEntry): Record<string, unknown> {
  const inputSchema = buildInputSchema(cmd);
  const returnSchema = buildReturnSchema(cmd);
  return {
    fullName: cmd.fullName,
    groupSegments: cmd.groupSegments,
    command: cmd.command,
    scope: cmd.scope,
    description: cmd.description,
    inputSchema,
    returnSchema,
  };
}
