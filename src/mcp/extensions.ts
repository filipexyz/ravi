/**
 * What a registered server advertises (spec mcp, Raw Dispatch, File
 * Uploads), and which catalog an attachment sees. No network, no MCP client:
 * the listing surfaces and the authorization read it.
 */

import type { McpAgentServerRecord, McpCatalog, McpServerRecord } from "./registry-db.js";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
export const MCP_FILES_EXTENSION = "io.modelcontextprotocol/files";

function extensionsOf(server: Pick<McpServerRecord, "extensions">): Record<string, unknown> {
  const extensions = server.extensions;
  return extensions && typeof extensions === "object" && !Array.isArray(extensions) ? extensions : {};
}

/** The server advertises the tasks extension. */
export function mcpServerDeclaresTasks(server: Pick<McpServerRecord, "extensions">): boolean {
  return Object.hasOwn(extensionsOf(server), MCP_TASKS_EXTENSION);
}

export const MCP_SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

/** The server advertises the skills extension (as of its last refresh). */
export function mcpServerDeclaresSkills(server: Pick<McpServerRecord, "extensions">): boolean {
  return Object.hasOwn(extensionsOf(server), MCP_SKILLS_EXTENSION);
}

/** The server advertises the files extension with `upload` (the only form servers act on). */
export function mcpServerDeclaresFileUpload(server: Pick<McpServerRecord, "extensions">): boolean {
  const files = extensionsOf(server)[MCP_FILES_EXTENSION];
  if (!files || typeof files !== "object" || Array.isArray(files)) return false;
  const upload = (files as Record<string, unknown>).upload;
  return Boolean(upload) && typeof upload === "object" && !Array.isArray(upload);
}

/**
 * Whether a server's tool calls go through the raw dispatch: an HTTP row in
 * the modern era that is not pinned to legacy and whose server declares the
 * tasks or the files extension. Everything else stays on the SDK client.
 */
export function mcpUsesRawDispatch(
  server: Pick<McpServerRecord, "transport" | "era" | "protocol" | "extensions">,
): boolean {
  if (server.transport !== "http" || server.era !== "modern" || server.protocol === "legacy") return false;
  return mcpServerDeclaresTasks(server) || mcpServerDeclaresFileUpload(server);
}

/**
 * Whether an attachment's calls declare the files extension: uploads on, and
 * a modern HTTP server that offers `files.upload` (addendum A1).
 */
export function mcpAttachmentDeclaresUploads(
  server: Pick<McpServerRecord, "transport" | "era" | "protocol" | "extensions">,
  attachment: Pick<McpAgentServerRecord, "uploads"> | null | undefined,
): boolean {
  return attachment?.uploads === true && mcpUsesRawDispatch(server) && mcpServerDeclaresFileUpload(server);
}

/**
 * The catalog an attachment sees: the one listed with the files extension
 * declared when the attachment's calls declare it and that catalog exists,
 * else the plain one.
 */
export function mcpCatalogForAttachment(
  server: Pick<McpServerRecord, "transport" | "era" | "protocol" | "extensions" | "catalog" | "filesCatalog">,
  attachment: Pick<McpAgentServerRecord, "uploads"> | null | undefined,
): McpCatalog | null {
  if (mcpAttachmentDeclaresUploads(server, attachment) && server.filesCatalog) return server.filesCatalog;
  return server.catalog;
}
