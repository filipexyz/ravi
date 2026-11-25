/**
 * File arguments of MCP tools (spec mcp, File Uploads).
 *
 * The files extension (`io.modelcontextprotocol/files`) lets a server mark a
 * tool argument `x-mcp-file`: the client sends a `FileInput` (`id`,
 * `mimeType`, `size`, `name`, `digest`) there, and uploads the bytes to the
 * target the server hands back. Ravi never shows the marker, a `FileInput`
 * shape or an upload target to a model. Instead:
 *
 * - The catalog rewrites each marked argument into a path handle (a string,
 *   or a list of strings) and records it in `fileArguments`
 *   (`rewriteMcpFileSchema`). A marker Ravi cannot map (at the schema root,
 *   nested inside another argument, mixed one-or-many branches) drops the
 *   tool: a file is never sent as text.
 * - Gate A (`stageMcpFileArguments`) decides each handle before anything is
 *   sent: the turn may use `Read`, the real path (symlinks followed) is a
 *   regular file with one name, inside the agent's workspace or a temp
 *   directory (unless the turn may run any executable), not a runtime
 *   provider's configuration and not Ravi's state directory, within the size
 *   limits and the server's `accept` hint. The bytes are read once, from the
 *   same file that was checked, and the `FileInput` is built from them.
 *
 * Gate B (the attachment's uploads flag, the `upload` surface of
 * `authorizeMcpUse`, the server and agent kind) and the uploads themselves
 * live in the gateway and `upload-target.ts`.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readlinkSync, readSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, parse, sep } from "node:path";

import { canExecuteArbitraryShell, canUseToolInContext } from "../bash/hook.js";
import {
  canonicalCase,
  isProviderConfigPath,
  physicalPathForPermissionCheck,
} from "../permissions/provider-config-paths.js";
import type { ContextRecord } from "../router/router-db.js";
import { getRaviStateDir } from "../utils/paths.js";
import type { McpCatalogTool, McpFileArgument } from "./registry-db.js";

export const MCP_FILES_EXTENSION_MARKER = "x-mcp-file";
/** The largest file Ravi uploads. */
export const MCP_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** The most bytes one call uploads, all files together. */
export const MCP_FILES_TOTAL_MAX_BYTES = 100 * 1024 * 1024;
/** The most files one call uploads. */
export const MCP_FILES_MAX_PER_CALL = 10;
const HANDLE_MAX = 4096;

/** What the runtime reads about a file argument. Never a URL, a marker or the `FileInput` shape. */
export const MCP_FILE_HANDLE_DESCRIPTION =
  "Path of a file in the agent's workspace (relative to it, or absolute). Ravi reads the file and uploads it; never put file contents here.";

// ============================================================================
// Schema
// ============================================================================

export type McpFileSchemaRewrite =
  | { ok: true; schema: Record<string, unknown>; fileArguments: McpFileArgument[] }
  | { ok: false; reason: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function marked(node: unknown): Record<string, unknown> | null {
  const record = asRecord(node);
  if (!record || !Object.hasOwn(record, MCP_FILES_EXTENSION_MARKER)) return null;
  return asRecord(record[MCP_FILES_EXTENSION_MARKER]) ?? {};
}

/** Whether a marker sits anywhere inside `node` (objects and arrays walked, depth-capped). */
function containsMarker(node: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(node)) return node.some((item) => containsMarker(item, depth + 1));
  const record = asRecord(node);
  if (!record) return false;
  if (Object.hasOwn(record, MCP_FILES_EXTENSION_MARKER)) return true;
  return Object.values(record).some((value) => containsMarker(value, depth + 1));
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function markerSettings(marker: Record<string, unknown>): Pick<McpFileArgument, "maxSize" | "accept"> {
  const maxSize = count(marker.maxSize);
  const accept = Array.isArray(marker.accept)
    ? marker.accept.filter((item): item is string => typeof item === "string" && item.length <= 200).slice(0, 64)
    : undefined;
  return { ...(maxSize !== undefined ? { maxSize } : {}), ...(accept?.length ? { accept } : {}) };
}

type ArgumentShape = { multiple: boolean; marker: Record<string, unknown>; array?: Record<string, unknown> };

/** How one top-level property carries files: itself, its items, or `anyOf`/`oneOf` branches of those. */
function argumentShape(property: Record<string, unknown>): ArgumentShape | "none" | "unsupported" {
  const own = marked(property);
  if (own) return { multiple: false, marker: own };
  const items = marked(property.items);
  if (items) return { multiple: true, marker: items, array: property };
  const branches = [property.anyOf, property.oneOf].filter(Array.isArray).flat() as unknown[];
  const shapes: ArgumentShape[] = [];
  for (const branch of branches) {
    const record = asRecord(branch);
    if (!record) continue;
    const shape = argumentShape(record);
    if (shape === "unsupported") return "unsupported";
    if (shape !== "none") shapes.push(shape);
  }
  if (shapes.length > 0) {
    // One argument is either one file or a list of files, never both.
    if (shapes.some((shape) => shape.multiple !== shapes[0]!.multiple)) return "unsupported";
    return shapes[0]!;
  }
  return containsMarker(property) ? "unsupported" : "none";
}

/**
 * Rewrite the file arguments of one tool's input schema into path handles.
 * Returns the schema the runtime sees and what the gateway needs to build
 * each `FileInput`; a marker Ravi cannot map is a reason to drop the tool.
 */
export function rewriteMcpFileSchema(schema: Record<string, unknown>): McpFileSchemaRewrite {
  if (!containsMarker(schema)) return { ok: true, schema, fileArguments: [] };
  const rootBranches = [schema.anyOf, schema.oneOf, schema.allOf].filter(Array.isArray).flat();
  if (marked(schema) || containsMarker(rootBranches)) {
    return { ok: false, reason: "a file argument at the root of the input schema, which Ravi cannot map" };
  }
  const properties = asRecord(schema.properties);
  if (!properties) return { ok: false, reason: "a file argument outside the input schema's properties" };
  const rewritten: Record<string, unknown> = {};
  const fileArguments: McpFileArgument[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const property = asRecord(value);
    if (!property) {
      rewritten[name] = value;
      continue;
    }
    const shape = argumentShape(property);
    if (shape === "unsupported") {
      return { ok: false, reason: `a file argument (${name.slice(0, 64)}) in a shape Ravi cannot map` };
    }
    if (shape === "none") {
      rewritten[name] = value;
      continue;
    }
    const remote = typeof property.description === "string" ? property.description.trim().slice(0, 1024) : "";
    const description = remote
      ? `${MCP_FILE_HANDLE_DESCRIPTION} The server says: ${remote}`
      : MCP_FILE_HANDLE_DESCRIPTION;
    const minItems = count(shape.array?.minItems);
    const maxItems = count(shape.array?.maxItems);
    fileArguments.push({
      name,
      multiple: shape.multiple,
      ...markerSettings(shape.marker),
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
    });
    rewritten[name] = shape.multiple
      ? {
          type: "array",
          description,
          items: { type: "string", description: MCP_FILE_HANDLE_DESCRIPTION },
          ...(minItems !== undefined ? { minItems } : {}),
          ...(maxItems !== undefined ? { maxItems: Math.min(maxItems, MCP_FILES_MAX_PER_CALL) } : {}),
        }
      : { type: "string", description };
  }
  const next = { ...schema, properties: rewritten };
  if (containsMarker(next)) return { ok: false, reason: "a file argument in a shape Ravi cannot map" };
  fileArguments.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, schema: next, fileArguments };
}

// ============================================================================
// Gate A: what a handle may name
// ============================================================================

export type McpFileGateCode =
  | "invalid_handle"
  | "artifact_handle"
  | "read_denied"
  | "outside_workspace"
  | "provider_config"
  | "state_dir"
  | "hard_link"
  | "not_a_file"
  | "too_large"
  | "not_accepted"
  | "too_many_files"
  | "unreadable";

/** A file read for one call: its `FileInput` and the bytes the upload sends. */
export interface McpStagedFile {
  fileId: string;
  argument: string;
  name: string;
  mimeType: string;
  size: number;
  /** sha-256 of the bytes, base64url without padding (43 characters). */
  digest: string;
  bytes: Uint8Array;
}

export interface McpFileInput {
  id: string;
  mimeType: string;
  size: number;
  name: string;
  digest: { algorithm: "sha-256"; value: string };
}

export type McpFileStaging =
  | { ok: true; arguments: Record<string, unknown>; files: McpStagedFile[] }
  | { ok: false; code: McpFileGateCode; reason: string };

export interface McpFileGateDeps {
  /** `use tool:<name>` for the turn (default: the tool hook's decision). */
  canUseTool?: (context: ContextRecord, agentId: string, toolName: string) => boolean;
  /** The turn may run any executable (default: the tool hook's decision), which lifts the workspace limit. */
  canReadAnywhere?: (context: ContextRecord, agentId: string) => boolean;
  /** Ravi's state directories (default: `RAVI_STATE_DIR` and `~/.ravi`). */
  stateDirs?: () => string[];
  /** Temp directories a file may come from (default: the OS temp directory, `/tmp`, `/private/tmp`). */
  tempDirs?: () => string[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface StageMcpFileArgumentsInput {
  context: ContextRecord;
  agentId: string;
  /** The agent's workspace (relative handles resolve against it). */
  cwd: string | null;
  tool: Pick<McpCatalogTool, "name" | "fileArguments">;
  arguments: Record<string, unknown>;
}

function bashContext(context: ContextRecord, agentId: string) {
  return {
    agentId,
    contextId: context.contextId,
    context,
    kind: context.kind,
    sessionKey: context.sessionKey,
    sessionName: context.sessionName,
    source: context.source,
    capabilities: context.capabilities,
    metadata: context.metadata,
  };
}

function defaultCanUseTool(context: ContextRecord, agentId: string, toolName: string): boolean {
  return canUseToolInContext(bashContext(context, agentId), toolName);
}

function defaultCanReadAnywhere(context: ContextRecord, agentId: string): boolean {
  return canExecuteArbitraryShell(bashContext(context, agentId));
}

function physical(path: string, cwd?: string): string | null {
  const resolved = physicalPathForPermissionCheck(path, cwd);
  return resolved ? canonicalCase(resolved) : null;
}

function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function defaultStateDirs(): string[] {
  return [getRaviStateDir(), join(homedir(), ".ravi")];
}

function defaultTempDirs(): string[] {
  return [tmpdir(), "/tmp", "/private/tmp"];
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** The media type Ravi declares for a file name; `application/octet-stream` when it does not know. */
export function mcpFileMimeType(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

function accepted(name: string, mimeType: string, accept: readonly string[] | undefined): boolean {
  if (!accept || accept.length === 0) return true;
  const extension = extname(name).toLowerCase();
  return accept.some((entry) => {
    const rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return rule === extension;
    if (rule === "*/*") return true;
    if (rule.endsWith("/*")) return mimeType.startsWith(rule.slice(0, -1));
    return rule === mimeType;
  });
}

/** sha-256 as the files extension writes it: base64url, no padding. */
export function mcpFileDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

type GateResult =
  | { ok: true; file: Omit<McpStagedFile, "fileId" | "argument"> }
  | { ok: false; code: McpFileGateCode; reason: string };

function refuse(code: McpFileGateCode, reason: string): { ok: false; code: McpFileGateCode; reason: string } {
  return { ok: false, code, reason };
}

/**
 * The physical path of an open file. On Linux the kernel names it
 * (`/proc/self/fd`); elsewhere the path is resolved again and must still
 * name the same device and inode. Null when it cannot be told.
 */
function openedFilePath(fd: number, decided: string): string | null {
  const opened = fstatSync(fd);
  try {
    const named = readlinkSync(`/proc/self/fd/${fd}`);
    if (isAbsolute(named)) return canonicalCase(named);
  } catch {
    // no-cause: no /proc here (macOS); fall back to resolving the decided path again.
  }
  const again = physical(decided);
  if (!again) return null;
  try {
    const stat = statSync(again);
    return stat.dev === opened.dev && stat.ino === opened.ino ? again : null;
  } catch {
    // no-cause: the path went away after the open; the caller refuses.
    return null;
  }
}

/**
 * Gate A for one handle: decide on the real path, then read the bytes from
 * that same file (opened without following a final link, one name only,
 * size unchanged). After the open, the path of the open file must be the
 * path that was decided on, so a directory swapped for a symlink between the
 * decision and the open is refused. Reasons name the handle as given, never
 * a resolved location outside the workspace.
 */
function gateOneHandle(
  handle: unknown,
  input: StageMcpFileArgumentsInput,
  deps: McpFileGateDeps,
  limits: { maxBytes: number; maxSize?: number; accept?: string[] },
): GateResult {
  if (typeof handle !== "string" || !handle.trim() || handle.length > HANDLE_MAX || handle.includes("\0")) {
    return refuse("invalid_handle", "A file argument must be a file path (a non-empty string).");
  }
  const shown = JSON.stringify(handle.length > 120 ? `${handle.slice(0, 120)}…` : handle);
  if (/^art_[a-z0-9]+_[a-z0-9]+$/.test(handle.trim())) {
    return refuse(
      "artifact_handle",
      `${shown} is an artifact id; MCP file arguments take a file path in the agent's workspace. Save the artifact as a file there first.`,
    );
  }
  const canUseTool = deps.canUseTool ?? defaultCanUseTool;
  if (!canUseTool(input.context, input.agentId, "Read")) {
    return refuse(
      "read_denied",
      `Permission denied: agent:${input.agentId} cannot use tool:Read, so it cannot send files.`,
    );
  }
  const expanded = handle.replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(expanded) && !input.cwd) {
    return refuse("invalid_handle", `${shown} is relative and the agent has no workspace; give an absolute path.`);
  }
  const cwd = input.cwd ?? undefined;
  if (isProviderConfigPath(expanded, cwd)) {
    return refuse(
      "provider_config",
      `${shown} is a runtime provider's configuration, which is never sent to an MCP server.`,
    );
  }
  const real = physical(expanded, cwd);
  if (!real) return refuse("unreadable", `${shown} cannot be resolved.`);
  const stateDirs = (deps.stateDirs ?? defaultStateDirs)().flatMap((dir) => physical(dir) ?? []);
  if (stateDirs.some((root) => isUnder(real, root))) {
    return refuse("state_dir", `${shown} is inside Ravi's state directory, which is never sent to an MCP server.`);
  }
  const canReadAnywhere = (deps.canReadAnywhere ?? defaultCanReadAnywhere)(input.context, input.agentId);
  if (!canReadAnywhere) {
    const workspace = input.cwd ? physical(input.cwd) : null;
    const workspaceCounts =
      workspace !== null && workspace !== parse(workspace).root && workspace !== physical(homedir());
    const temps = (deps.tempDirs ?? defaultTempDirs)().flatMap((dir) => physical(dir) ?? []);
    const inside = (workspaceCounts && isUnder(real, workspace)) || temps.some((root) => isUnder(real, root));
    if (!inside) {
      return refuse(
        "outside_workspace",
        `${shown} is outside the agent's workspace; only files in the workspace or a temp directory can be sent.`,
      );
    }
  }
  let checked: ReturnType<typeof statSync>;
  try {
    checked = statSync(real);
  } catch {
    // no-cause: the errno text names the resolved path; the handle as given is what the caller sees.
    return refuse("unreadable", `${shown} cannot be read.`);
  }
  if (!checked.isFile()) return refuse("not_a_file", `${shown} is not a regular file.`);
  if (checked.nlink > 1) {
    return refuse("hard_link", `${shown} has more than one name (a hard link), so it could be a protected file.`);
  }
  const cap = Math.min(limits.maxBytes, limits.maxSize ?? Number.POSITIVE_INFINITY);
  if (checked.size > cap) {
    return refuse("too_large", `${shown} is ${checked.size} bytes; the limit for this argument is ${cap} bytes.`);
  }
  const name = basename(real);
  const mimeType = mcpFileMimeType(name);
  if (!accepted(name, mimeType, limits.accept)) {
    return refuse("not_accepted", `${shown} is not a type the server accepts here (${limits.accept?.join(", ")}).`);
  }
  let fd: number | null = null;
  try {
    fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino || opened.nlink > 1) {
      return refuse("unreadable", `${shown} changed while it was being read.`);
    }
    // Tie the bytes to the decision: the open file must be the one at the decided path.
    if (openedFilePath(fd, real) !== real) {
      return refuse("unreadable", `${shown} changed while it was being read.`);
    }
    const size = opened.size;
    if (size > cap) return refuse("too_large", `${shown} grew past the limit while it was being read.`);
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    const extra = new Uint8Array(1);
    if (offset !== size || readSync(fd, extra, 0, 1, size) !== 0) {
      return refuse("unreadable", `${shown} changed while it was being read.`);
    }
    return { ok: true, file: { name, mimeType, size, digest: mcpFileDigest(bytes), bytes } };
  } catch {
    // no-cause: the errno text names the resolved path; the handle as given is what the caller sees.
    return refuse("unreadable", `${shown} cannot be read.`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The `FileInput` the server receives for a staged file. Never inline bytes. */
export function mcpFileInput(file: McpStagedFile): McpFileInput {
  return {
    id: file.fileId,
    mimeType: file.mimeType,
    size: file.size,
    name: file.name,
    digest: { algorithm: "sha-256", value: file.digest },
  };
}

/**
 * Gate A for every file argument of one call. Each handle the runtime sent
 * becomes a `FileInput` in the arguments the server receives; the bytes stay
 * with the gateway for the upload. Absent file arguments are left absent
 * (the server judges what it requires). Nothing here touches the network.
 */
export function stageMcpFileArguments(input: StageMcpFileArgumentsInput, deps: McpFileGateDeps = {}): McpFileStaging {
  const fileArguments = input.tool.fileArguments ?? [];
  if (fileArguments.length === 0) return { ok: true, arguments: input.arguments, files: [] };
  const maxBytes = Math.min(deps.maxFileBytes ?? MCP_FILE_MAX_BYTES, MCP_FILE_MAX_BYTES);
  const maxTotal = Math.min(deps.maxTotalBytes ?? MCP_FILES_TOTAL_MAX_BYTES, MCP_FILES_TOTAL_MAX_BYTES);
  const args: Record<string, unknown> = { ...input.arguments };
  const files: McpStagedFile[] = [];
  let total = 0;
  for (const argument of fileArguments) {
    if (!Object.hasOwn(args, argument.name) || args[argument.name] === undefined) continue;
    const value = args[argument.name];
    const handles = argument.multiple ? value : [value];
    if (!Array.isArray(handles)) {
      return refuse("invalid_handle", `${argument.name} takes a list of file paths.`);
    }
    if (argument.multiple && argument.maxItems !== undefined && handles.length > argument.maxItems) {
      return refuse("too_many_files", `${argument.name} takes at most ${argument.maxItems} files.`);
    }
    const inputs: McpFileInput[] = [];
    for (const handle of handles) {
      if (files.length >= MCP_FILES_MAX_PER_CALL) {
        return refuse("too_many_files", `One call sends at most ${MCP_FILES_MAX_PER_CALL} files.`);
      }
      const gated = gateOneHandle(handle, input, deps, {
        maxBytes,
        ...(argument.maxSize !== undefined ? { maxSize: argument.maxSize } : {}),
        ...(argument.accept ? { accept: argument.accept } : {}),
      });
      if (!gated.ok) return gated;
      total += gated.file.size;
      if (total > maxTotal) {
        return refuse("too_large", `The files of one call add up to more than ${maxTotal} bytes.`);
      }
      const staged: McpStagedFile = { ...gated.file, fileId: `f${files.length + 1}`, argument: argument.name };
      files.push(staged);
      inputs.push(mcpFileInput(staged));
    }
    args[argument.name] = argument.multiple ? inputs : inputs[0];
  }
  return { ok: true, arguments: args, files };
}

/** Whether any file argument of the tool is present in these arguments. */
export function mcpCallHasFileArguments(
  tool: Pick<McpCatalogTool, "fileArguments"> | null | undefined,
  args: Record<string, unknown>,
): boolean {
  return (tool?.fileArguments ?? []).some((argument) => args[argument.name] !== undefined);
}
