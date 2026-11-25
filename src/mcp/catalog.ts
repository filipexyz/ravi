/**
 * The cached catalog of a registered MCP server (spec mcp, Names, Gateway).
 *
 * The daemon lists a server's tools and stores them in `mcp_servers`: each
 * tool under its exposed name `mcp__<server>__<tool>`, sorted by that name,
 * with its description and input schema. A tool whose name cannot be exposed
 * as it is, that appears twice, or whose schema is not a JSON object or is
 * too large, is dropped and kept with the reason; it is never renamed.
 * Annotations, titles, icons and `_meta` are not stored: nothing upstream
 * steers a decision. The fingerprint is the sha256 of the stored catalog in
 * a stable encoding, so any change to what agents can see changes it.
 *
 * File arguments (spec mcp, File Uploads): an argument the server marked
 * `x-mcp-file` is stored rewritten to a path handle, with `fileArguments`
 * saying which; the marker never reaches a runtime. A server that offers
 * uploads is listed twice (addendum A1): the plain catalog every attachment
 * sees, and the one listed with the files extension declared, which only an
 * attachment with uploads on sees (`mcpCatalogForAttachment`).
 */

import { createHash } from "node:crypto";

import { type AuthorizeMcpUseDeps, authorizeMcpUse } from "./authorize.js";
import { rewriteMcpFileSchema } from "./files.js";
import { exposedToolName } from "./names.js";
import { mcpCatalogForAttachment } from "./extensions.js";
import type { McpCatalog, McpCatalogTool, McpDroppedTool } from "./registry-db.js";
import { listMcpAttachments } from "./registry-db.js";
import type { ContextRecord } from "../router/router-db.js";

/** A stored description is capped; listings cap it further. */
export const MCP_CATALOG_DESCRIPTION_MAX = 8 * 1024;
/** An input schema larger than this (as JSON) drops the tool. */
export const MCP_CATALOG_SCHEMA_MAX_BYTES = 64 * 1024;
/** At most this many tools of one server are kept; the rest are dropped. */
export const MCP_CATALOG_MAX_TOOLS = 512;

/** The tool fields the catalog reads from a `tools/list` entry. */
export interface McpRemoteTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
}

export interface BuiltMcpCatalog {
  catalog: McpCatalog;
  fingerprint: string;
}

function capDescription(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MCP_CATALOG_DESCRIPTION_MAX ? trimmed.slice(0, MCP_CATALOG_DESCRIPTION_MAX) : trimmed;
}

function shownName(name: unknown): string {
  if (typeof name !== "string") return "(no name)";
  return name.length > 80 ? `${name.slice(0, 80)}…` : name;
}

/** JSON with object keys sorted at every level, so equal catalogs encode equally. */
export function stableMcpJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableMcpJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableMcpJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function mcpCatalogFingerprint(catalog: McpCatalog): string {
  return createHash("sha256").update(stableMcpJson(catalog)).digest("hex");
}

/** Build the stored catalog of `server` from the tools it listed. */
export function buildMcpCatalog(server: string, remoteTools: readonly McpRemoteTool[]): BuiltMcpCatalog {
  const counts = new Map<string, number>();
  for (const tool of remoteTools) {
    if (typeof tool?.name === "string") counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  const tools: McpCatalogTool[] = [];
  const dropped: McpDroppedTool[] = [];
  for (const tool of remoteTools) {
    const name = tool?.name;
    const exposed = exposedToolName(server, typeof name === "string" ? name : "");
    if (!exposed.ok) {
      dropped.push({ name: shownName(name), reason: exposed.reason });
      continue;
    }
    if ((counts.get(name as string) ?? 0) > 1) {
      dropped.push({ name: name as string, reason: "the server lists this tool name more than once" });
      continue;
    }
    const schema = tool.inputSchema;
    if (schema !== undefined && (!schema || typeof schema !== "object" || Array.isArray(schema))) {
      dropped.push({ name: name as string, reason: "the input schema is not a JSON object" });
      continue;
    }
    if (schema !== undefined && Buffer.byteLength(JSON.stringify(schema), "utf8") > MCP_CATALOG_SCHEMA_MAX_BYTES) {
      dropped.push({ name: name as string, reason: "the input schema is larger than 64 KB" });
      continue;
    }
    const files = rewriteMcpFileSchema((schema as Record<string, unknown> | undefined) ?? { type: "object" });
    if (!files.ok) {
      dropped.push({ name: name as string, reason: `the input schema has ${files.reason}` });
      continue;
    }
    const description = capDescription(tool.description);
    tools.push({
      name: name as string,
      exposedName: exposed.name,
      ...(description ? { description } : {}),
      inputSchema: files.schema,
      ...(files.fileArguments.length > 0 ? { fileArguments: files.fileArguments } : {}),
    });
  }
  tools.sort((a, b) => (a.exposedName < b.exposedName ? -1 : a.exposedName > b.exposedName ? 1 : 0));
  if (tools.length > MCP_CATALOG_MAX_TOOLS) {
    for (const tool of tools.splice(MCP_CATALOG_MAX_TOOLS)) {
      dropped.push({ name: tool.name, reason: `the server lists more than ${MCP_CATALOG_MAX_TOOLS} tools` });
    }
  }
  dropped.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const catalog: McpCatalog = { tools, dropped };
  return { catalog, fingerprint: mcpCatalogFingerprint(catalog) };
}

export interface AuthorizedMcpTool extends McpCatalogTool {
  server: string;
}

export interface ListAuthorizedMcpToolsInput {
  context: ContextRecord | null | undefined;
  agentId: string;
  /** One server; every server attached to the agent when omitted. */
  server?: string;
}

/**
 * The cached tools this turn may call, after `authorizeMcpUse` (surface
 * `list`) on each attached server, in stable order: by server, then by
 * exposed name. No network: only the stored catalogs are read.
 */
export function listAuthorizedMcpTools(
  input: ListAuthorizedMcpToolsInput,
  deps: AuthorizeMcpUseDeps = {},
): AuthorizedMcpTool[] {
  const servers =
    input.server !== undefined
      ? [input.server]
      : listMcpAttachments({ agentId: input.agentId }).map((attachment) => attachment.server);
  const out: AuthorizedMcpTool[] = [];
  for (const name of [...new Set(servers)].sort()) {
    const decision = authorizeMcpUse(
      { context: input.context, agentId: input.agentId, server: name, surface: "list" },
      deps,
    );
    if (!decision.allowed) continue;
    const allowed = new Set(decision.tools ?? []);
    for (const tool of mcpCatalogForAttachment(decision.server, decision.attachment)?.tools ?? []) {
      const exposed = exposedToolName(decision.server.name, tool.name);
      if (exposed.ok && allowed.has(exposed.name)) {
        out.push({ ...tool, exposedName: exposed.name, server: decision.server.name });
      }
    }
  }
  return out;
}
