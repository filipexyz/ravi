/**
 * Credentials file for Ravi runtime context keys.
 *
 * Spec: `runtime/context-keys`, `sdk/auth`.
 *
 * Path: `~/.ravi/credentials.json` (override via `RAVI_CREDENTIALS_PATH`).
 *
 * The file holds rctx_* secrets, so it MUST be mode 0600. The reader refuses
 * to read a file with looser permissions to make accidental world-readable
 * keys fail loud instead of silently authenticating.
 *
 * Format is versioned (`version: 1`). Multiple keys can coexist; `default`
 * points at whichever key the CLI should use when `RAVI_CONTEXT_KEY` is unset.
 *
 * Note: a thin wrapper at `src/cli/credentials.ts` exposes the same on-disk
 * format with a higher-level API used by the `ravi context credentials *`
 * commands. Both modules read/write the same JSON file and are interoperable.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export const CREDENTIALS_VERSION = 1;
export const CREDENTIALS_FILE_MODE = 0o600;

export interface CredentialsEntry {
  /** Public context id (`ctx_*`). */
  context_id: string;
  /** Agent bound to the context. */
  agent_id: string;
  /** Human-readable label (hostname, role, etc). */
  label: string;
  /** Context kind, e.g. `admin-bootstrap` or `cli-runtime`. */
  kind: string;
  /** Issuance timestamp (ms). */
  issued_at: number;
  /** Expiration timestamp (ms), null when the context never expires. */
  expires_at: number | null;
}

export interface CredentialsFile {
  version: number;
  default: string | null;
  contexts: Record<string, CredentialsEntry>;
}

export class CredentialsFileError extends Error {
  constructor(
    message: string,
    public readonly code: "permissions_too_loose" | "missing" | "invalid_json" | "invalid_shape" | "version_mismatch",
  ) {
    super(message);
    this.name = "CredentialsFileError";
  }
}

export function getCredentialsPath(): string {
  return process.env.RAVI_CREDENTIALS_PATH?.trim() || join(homedir(), ".ravi", "credentials.json");
}

export function credentialsFileExists(path = getCredentialsPath()): boolean {
  return existsSync(path);
}

export function readCredentialsFile(path = getCredentialsPath()): CredentialsFile | null {
  if (!existsSync(path)) {
    return null;
  }

  assertSecureMode(path);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new CredentialsFileError(
      `Failed to read credentials file at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      "missing",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CredentialsFileError(
      `Credentials file is not valid JSON (${path}): ${err instanceof Error ? err.message : String(err)}`,
      "invalid_json",
    );
  }

  return normalizeCredentialsFile(parsed, path);
}

export function writeCredentialsFile(file: CredentialsFile, path = getCredentialsPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const payload: CredentialsFile = {
    version: CREDENTIALS_VERSION,
    default: file.default,
    contexts: file.contexts,
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: CREDENTIALS_FILE_MODE });
  chmodSync(path, CREDENTIALS_FILE_MODE);
}

export function emptyCredentialsFile(): CredentialsFile {
  return { version: CREDENTIALS_VERSION, default: null, contexts: {} };
}

export function upsertCredentialsEntry(
  file: CredentialsFile,
  contextKey: string,
  entry: CredentialsEntry,
  options: { setDefault?: boolean } = {},
): CredentialsFile {
  const next: CredentialsFile = {
    version: CREDENTIALS_VERSION,
    default: file.default,
    contexts: { ...file.contexts, [contextKey]: entry },
  };
  if (options.setDefault || !next.default) {
    next.default = contextKey;
  }
  return next;
}

export function setDefaultCredentialsEntry(file: CredentialsFile, contextKey: string): CredentialsFile {
  if (!(contextKey in file.contexts)) {
    throw new Error(`Credentials file does not contain context key '${contextKey}'.`);
  }
  return { ...file, default: contextKey };
}

export function selectDefaultCredentialsKey(file: CredentialsFile | null): string | null {
  if (!file) return null;
  if (!file.default) return null;
  return file.contexts[file.default] ? file.default : null;
}

function assertSecureMode(path: string): void {
  const stat = statSync(path);
  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    throw new CredentialsFileError(
      `Credentials file ${path} has mode 0${mode.toString(8).padStart(3, "0")}; expected 0600. ` +
        `Run 'chmod 600 ${path}' to fix.`,
      "permissions_too_loose",
    );
  }
}

function normalizeCredentialsFile(value: unknown, path: string): CredentialsFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialsFileError(`Credentials file ${path} must be a JSON object.`, "invalid_shape");
  }
  const obj = value as Record<string, unknown>;

  const version = typeof obj.version === "number" ? obj.version : NaN;
  if (version !== CREDENTIALS_VERSION) {
    throw new CredentialsFileError(
      `Credentials file ${path} has version ${String(obj.version)}; expected ${CREDENTIALS_VERSION}.`,
      "version_mismatch",
    );
  }

  const defaultValue =
    typeof obj.default === "string" && obj.default.length > 0 ? obj.default : obj.default === null ? null : null;

  const contexts: Record<string, CredentialsEntry> = {};
  if (obj.contexts && typeof obj.contexts === "object" && !Array.isArray(obj.contexts)) {
    for (const [key, raw] of Object.entries(obj.contexts as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      contexts[key] = {
        context_id: String(entry.context_id ?? ""),
        agent_id: String(entry.agent_id ?? ""),
        label: String(entry.label ?? ""),
        kind: String(entry.kind ?? "cli-runtime"),
        issued_at: typeof entry.issued_at === "number" ? entry.issued_at : 0,
        expires_at: typeof entry.expires_at === "number" ? entry.expires_at : entry.expires_at === null ? null : null,
      };
    }
  }

  return { version: CREDENTIALS_VERSION, default: defaultValue, contexts };
}
