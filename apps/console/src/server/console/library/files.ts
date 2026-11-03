// Validation and hashing for a Library version's files, sent as UTF-8 text: a
// skill is the OSS skill folder (`SKILL.md` plus `references/*`); an agent
// definition is `AGENTS.md`, an optional `HEARTBEAT.md` and an optional
// `agent.json` manifest, and nothing else. Themes and widgets add their own
// file rules and compile step in `kinds.ts`.

import { createHash } from "node:crypto";

import { cliApiError } from "@/server/cli/errors";
import { CloudDefinitionError, parseCloudBlock } from "@/server/console/cloud-agents/definition";

export const LIBRARY_LIMITS = {
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  maxVersionBytes: 1024 * 1024,
  maxPathLength: 255,
  maxNameLength: 120,
  maxDescriptionLength: 1024,
  maxNoteLength: 500,
} as const;

export type LibraryItemKind = "skill" | "agent" | "theme" | "widget";

export const LIBRARY_ENTRY_FILE = "SKILL.md";
export const LIBRARY_ENTRY_FILES: Record<LibraryItemKind, string> = {
  skill: "SKILL.md",
  agent: "AGENTS.md",
  theme: "theme.json",
  widget: "widget.html",
};
export const LIBRARY_AGENT_MANIFEST_FILE = "agent.json";
export const LIBRARY_AGENT_FILES: ReadonlySet<string> = new Set(["AGENTS.md", "HEARTBEAT.md", LIBRARY_AGENT_MANIFEST_FILE]);
export const LIBRARY_AGENT_MAX_SKILLS = 50;
export const LIBRARY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const PATH_PATTERN = /^[A-Za-z0-9._\-/]+$/;

export type LibraryFileInput = { path: string; content: string };
export type LibraryFile = { path: string; content: string; bytes: number; sha256: string };

export function isLibrarySlug(value: string) {
  return LIBRARY_SLUG_PATTERN.test(value);
}

/** Checks the files, sorts them by path and computes the version's content hash. */
export function prepareLibraryFiles(input: readonly LibraryFileInput[], kind: LibraryItemKind = "skill") {
  const entryFile = LIBRARY_ENTRY_FILES[kind];
  if (input.length === 0) throw invalid(`A version needs at least ${entryFile}.`);
  if (input.length > LIBRARY_LIMITS.maxFiles) {
    throw invalid(`A version holds at most ${LIBRARY_LIMITS.maxFiles} files.`);
  }
  const seen = new Set<string>();
  const files: LibraryFile[] = [];
  let totalBytes = 0;
  for (const file of input) {
    const path = file.path;
    if (!isSafeLibraryPath(path)) throw invalid(`Invalid file path: ${JSON.stringify(path.slice(0, 80))}.`);
    if (seen.has(path)) throw invalid(`Duplicate file path: ${path}.`);
    if (kind === "agent" && !LIBRARY_AGENT_FILES.has(path)) {
      throw invalid("An agent definition holds only AGENTS.md, HEARTBEAT.md and agent.json: no routes, credentials or other files.");
    }
    seen.add(path);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > LIBRARY_LIMITS.maxFileBytes) {
      throw invalid(`${path} is larger than ${LIBRARY_LIMITS.maxFileBytes / 1024} KiB.`);
    }
    totalBytes += bytes;
    files.push({ path, content: file.content, bytes, sha256: sha256(file.content) });
  }
  if (!seen.has(entryFile)) throw invalid(`A version needs ${entryFile} at its root.`);
  const manifest = kind === "agent" ? parseAgentManifest(files.find((file) => file.path === LIBRARY_AGENT_MANIFEST_FILE)?.content) : null;
  if (totalBytes > LIBRARY_LIMITS.maxVersionBytes) {
    throw invalid(`A version is at most ${LIBRARY_LIMITS.maxVersionBytes / 1024 / 1024} MiB.`);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, totalBytes, contentHash: libraryContentHash(files), manifest };
}

export type AgentManifest = {
  provider: string | null;
  model: string | null;
  profile: string | null;
  skills: string[];
};

const MANIFEST_KEYS = new Set(["provider", "model", "profile", "skills", "cloud"]);
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,59}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const SKILL_REF_PATTERN = /^(?:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/)?([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/;

/**
 * `agent.json`: suggested `provider`, `model` and permission `profile`, and the
 * `skills` the agent needs (`org/<slug>`, `<project>/<slug>`, or the bare name
 * of a skill shipped with Ravi). Absent means all empty. An optional `cloud`
 * block is checked here with the cloud agents validator, so every published
 * version compiles; cloud agents read it from the file.
 */
export function parseAgentManifest(content: string | undefined): AgentManifest {
  const empty: AgentManifest = { provider: null, model: null, profile: null, skills: [] };
  if (content === undefined) return empty;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw invalid("agent.json is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("agent.json must be a JSON object.");
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !MANIFEST_KEYS.has(key));
  if (unknown.length > 0) {
    throw invalid(`agent.json only takes provider, model, profile, skills and cloud; remove ${unknown.slice(0, 5).join(", ")}.`);
  }
  try {
    parseCloudBlock(record.cloud);
  } catch (error) {
    if (error instanceof CloudDefinitionError) throw invalid(`agent.json ${error.message}`);
    throw error;
  }
  const token = (key: "provider" | "profile", pattern: RegExp) => {
    const raw = record[key];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== "string" || !pattern.test(raw)) throw invalid(`agent.json ${key} is not a valid name.`);
    return raw;
  };
  const model = record.model;
  if (model !== undefined && model !== null && (typeof model !== "string" || !MODEL_PATTERN.test(model))) {
    throw invalid("agent.json model is not a valid model name.");
  }
  const skills = record.skills ?? [];
  if (!Array.isArray(skills) || skills.length > LIBRARY_AGENT_MAX_SKILLS) {
    throw invalid(`agent.json skills is a list of at most ${LIBRARY_AGENT_MAX_SKILLS} skill references.`);
  }
  const refs: string[] = [];
  for (const ref of skills) {
    if (typeof ref !== "string" || !SKILL_REF_PATTERN.test(ref)) {
      throw invalid(`agent.json skills: ${JSON.stringify(String(ref).slice(0, 80))} is not org/<slug>, <project>/<slug> or a skill name.`);
    }
    if (!refs.includes(ref)) refs.push(ref);
  }
  return {
    provider: token("provider", TOKEN_PATTERN),
    model: typeof model === "string" ? model : null,
    profile: token("profile", TOKEN_PATTERN),
    skills: refs,
  };
}

/** An agent of a scope may only require skills its agents can see. */
export function assertAgentSkillsInScope(manifest: AgentManifest | null, projectSlug: string | null) {
  for (const ref of manifest?.skills ?? []) {
    const prefix = SKILL_REF_PATTERN.exec(ref)?.[1];
    if (!prefix || prefix === "org" || prefix === projectSlug) continue;
    throw invalid(
      projectSlug
        ? `agent.json requires ${ref}, but this project's agents only see org/ skills and ${projectSlug}/ skills.`
        : `agent.json requires ${ref}, but an organization agent only sees org/ skills.`,
    );
  }
}

export function isSafeLibraryPath(path: string) {
  if (!path || path.length > LIBRARY_LIMITS.maxPathLength || !PATH_PATTERN.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** SHA-256 over `path NUL file-sha256 LF` for each file, sorted by path. */
export function libraryContentHash(files: readonly Pick<LibraryFile, "path" | "sha256">[]) {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(sorted.map((file) => `${file.path}\0${file.sha256}\n`).join(""));
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string) {
  return cliApiError(400, "PAYLOAD_INVALID", message);
}
