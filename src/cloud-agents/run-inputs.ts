/**
 * Local files given to a cloud run (`ravi cloud runs start --file <path>`,
 * contract F1 "File inputs"): read here, sent base64 in the start body, and
 * mounted read-only in the run at `/mnt/session/inputs/<name>`.
 *
 * Limits are checked before anything is sent: at most 10 files and 3 MB
 * decoded in all. A file leaves this machine for a run that acts as a person,
 * so hidden files and folders and Ravi's own state are never sent, and in
 * another person's turn only files inside the agent's folder are.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";

import { getRaviStateDir } from "../utils/paths.js";

export const CLOUD_RUN_FILES_MAX = 10;
export const CLOUD_RUN_FILES_MAX_BYTES = 3 * 1024 * 1024;
const NAME_MAX = 120;

export interface CloudRunFileInput {
  name: string;
  contentBase64: string;
  mimeType?: string;
}

export interface PreparedCloudRunFiles {
  files: CloudRunFileInput[];
  /** For the plan: names and sizes, never contents. */
  summary: Array<{ name: string; size: number }>;
  totalBytes: number;
}

export interface CloudRunFileDeps {
  /** Folder relative paths resolve against (the turn's cwd, else the process's). */
  cwd: string;
  /** Another person's turn: only files inside `cwd`. */
  insideCwdOnly: boolean;
  stateDir?: string;
  readFile?: (path: string) => Uint8Array;
  fileSize?: (path: string) => number | null;
  /** Where a path really points (symlinks resolved); the path itself when it does not resolve. */
  realPath?: (path: string) => string;
}

const MIME_TYPES: Record<string, string> = {
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

export function cloudFileMimeType(name: string): string | undefined {
  return MIME_TYPES[extname(name).toLowerCase()];
}

/** The file's name in the run: its base name, letters, digits, `.`, `_`, `-` and spaces only. */
export function sanitizeCloudFileName(path: string): string {
  const cleaned = basename(path)
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s_-]+/, "")
    .trim();
  if (!cleaned) return "file";
  if (cleaned.length <= NAME_MAX) return cleaned;
  const extension = extname(cleaned).slice(0, 12);
  return `${cleaned.slice(0, NAME_MAX - extension.length)}${extension}`;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function defaultRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Why a path may not go to a cloud run, or null when it may. */
function refusal(path: string, cwd: string, stateDir: string, insideCwdOnly: boolean, shown: string): string | null {
  // Inside the folder only its own subpath counts (an agent folder may itself sit under a dot folder).
  const checked = inside(path, cwd) ? relative(cwd, path) : path;
  if (checked.split(sep).some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")) {
    return `--file ${shown}: hidden files and folders are not sent to a cloud run.`;
  }
  if (inside(path, stateDir)) return `--file ${shown}: files of Ravi's own state are not sent to a cloud run.`;
  if (insideCwdOnly && !inside(path, cwd)) {
    return `--file ${shown}: in another person's turn, only files inside the agent's folder are sent.`;
  }
  return null;
}

function defaultFileSize(path: string): number | null {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/** Reads and checks `--file` paths; a string is the error to show (a usage error). */
export function prepareCloudRunFiles(paths: readonly string[], deps: CloudRunFileDeps): PreparedCloudRunFiles | string {
  const raw = paths.map((path) => path.trim()).filter(Boolean);
  if (raw.length > CLOUD_RUN_FILES_MAX) return `--file takes at most ${CLOUD_RUN_FILES_MAX} files.`;
  const realPath = deps.realPath ?? defaultRealPath;
  const stateDir = resolve(deps.stateDir ?? getRaviStateDir());
  const cwd = resolve(deps.cwd);
  const realStateDir = realPath(stateDir);
  const realCwd = realPath(cwd);
  const seen = new Set<string>();
  const files: CloudRunFileInput[] = [];
  const summary: Array<{ name: string; size: number }> = [];
  let totalBytes = 0;
  for (const entry of raw) {
    const path = resolve(cwd, entry);
    const shown = entry.slice(0, 200);
    const refused = refusal(path, cwd, stateDir, deps.insideCwdOnly, shown);
    if (refused) return refused;
    // A symlink is judged by where it points too, and its target is what gets read.
    const target = realPath(path);
    if (target !== path) {
      const refusedTarget = refusal(target, realCwd, realStateDir, deps.insideCwdOnly, shown);
      if (refusedTarget) return refusedTarget;
    }
    const size = (deps.fileSize ?? defaultFileSize)(target);
    if (size === null) return `--file ${shown}: no such file.`;
    totalBytes += size;
    if (totalBytes > CLOUD_RUN_FILES_MAX_BYTES) {
      return `--file: the files add up to more than ${CLOUD_RUN_FILES_MAX_BYTES / (1024 * 1024)} MB (the run takes at most 3 MB in all).`;
    }
    const name = sanitizeCloudFileName(path);
    const key = name.toLowerCase();
    if (seen.has(key)) return `--file: two files would be named ${name} in the run; rename one.`;
    seen.add(key);
    const bytes = (deps.readFile ?? ((file: string) => readFileSync(file)))(target);
    const mimeType = cloudFileMimeType(name);
    files.push({ name, contentBase64: Buffer.from(bytes).toString("base64"), ...(mimeType ? { mimeType } : {}) });
    summary.push({ name, size: bytes.byteLength });
  }
  return { files, summary, totalBytes };
}
