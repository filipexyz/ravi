/**
 * Route table for the SDK gateway.
 *
 * Translates a `RegistrySnapshot` into an O(1) lookup keyed by the canonical
 * URL path `/api/v1/<segments>/<command>`. Mirrors `commandPath()` from
 * `sdk/openapi/emit.ts` but kept independent so the gateway can run without
 * the OpenAPI emitter.
 */

import { createHash } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import type { CommandRegistryEntry, RegistrySnapshot } from "../../cli/registry-snapshot.js";

export const API_PREFIX = "/api/v1";

export function commandUrlPath(cmd: CommandRegistryEntry): string {
  return `${API_PREFIX}/${[...cmd.groupSegments, cmd.command].join("/")}`;
}

export interface RouteTable {
  byPath: Map<string, CommandRegistryEntry>;
  registry: RegistrySnapshot;
  registryHash: string;
}

export function buildRouteTable(registry: RegistrySnapshot): RouteTable {
  const byPath = new Map<string, CommandRegistryEntry>();
  for (const cmd of registry.commands) {
    const path = commandUrlPath(cmd);
    if (byPath.has(path)) {
      const prev = byPath.get(path)!;
      throw new Error(`Gateway route collision: ${path} is claimed by both ${prev.fullName} and ${cmd.fullName}.`);
    }
    byPath.set(path, cmd);
  }
  return {
    byPath,
    registry,
    registryHash: hashRegistry(registry),
  };
}

function zodToJson(schema: ZodTypeAny, description?: string): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as Record<string, unknown>;
  delete (json as { $schema?: unknown }).$schema;
  if (description !== undefined && typeof json.description !== "string") {
    json.description = description;
  }
  return json;
}

interface MetaCommand {
  fullName: string;
  groupPath: string;
  command: string;
  description: string;
  scope: string;
  path: string;
  args: { name: string; required: boolean; variadic: boolean; description?: string; schema: Record<string, unknown> }[];
  options: { name: string; flags: string; description?: string; schema: Record<string, unknown> }[];
  returns?: Record<string, unknown>;
}

export interface RegistryMetaPayload {
  version: string;
  commandCount: number;
  registryHash: string;
  commands: MetaCommand[];
}

export function buildMetaPayload(table: RouteTable): RegistryMetaPayload {
  const commands: MetaCommand[] = [];
  for (const cmd of [...table.registry.commands].sort((a, b) =>
    a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0,
  )) {
    commands.push({
      fullName: cmd.fullName,
      groupPath: cmd.groupPath,
      command: cmd.command,
      description: cmd.description,
      scope: cmd.scope,
      path: commandUrlPath(cmd),
      args: cmd.args.map((arg) => ({
        name: arg.name,
        required: arg.required,
        variadic: arg.variadic,
        ...(arg.description !== undefined ? { description: arg.description } : {}),
        schema: zodToJson(arg.schema, arg.description),
      })),
      options: cmd.options.map((opt) => ({
        name: opt.name,
        flags: opt.flags,
        ...(opt.description !== undefined ? { description: opt.description } : {}),
        schema: zodToJson(opt.schema, opt.description),
      })),
      ...(cmd.returns ? { returns: zodToJson(cmd.returns) } : {}),
    });
  }
  return {
    version: "1",
    commandCount: commands.length,
    registryHash: table.registryHash,
    commands,
  };
}

function hashRegistry(registry: RegistrySnapshot): string {
  const parts: string[] = [];
  for (const cmd of [...registry.commands].sort((a, b) =>
    a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0,
  )) {
    parts.push(`${cmd.fullName}|${cmd.scope}|${cmd.args.length}|${cmd.options.length}`);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
