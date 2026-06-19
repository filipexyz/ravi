import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectionPage, CredentialConnectionRecord } from "./types.ts";

interface StoreFile {
  version: 1;
  connections: Record<string, CredentialConnectionRecord>;
}

const DEFAULT_STORE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".state", "connections.json");

export function defaultStorePath(): string {
  return process.env.RAVI_CREDENTIALS_POC_STATE?.trim() || DEFAULT_STORE_PATH;
}

export class ConnectionStore {
  constructor(private readonly path = defaultStorePath()) {}

  getPath(): string {
    return this.path;
  }

  list(options: { provider?: string; limit?: number; offset?: number } = {}): ConnectionPage {
    const records = Object.values(this.read().connections)
      .filter((record) => (options.provider ? record.provider === options.provider : true))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.connection.localeCompare(b.connection));
    const limit = normalizePageNumber(options.limit, 50, 1, 500);
    const offset = normalizePageNumber(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return {
      total: records.length,
      limit,
      offset,
      items: records.slice(offset, offset + limit),
    };
  }

  get(provider: string, connection: string): CredentialConnectionRecord | null {
    return this.read().connections[connectionId(provider, connection)] ?? null;
  }

  upsert(input: Omit<CredentialConnectionRecord, "id" | "createdAt" | "updatedAt">): CredentialConnectionRecord {
    const file = this.read();
    const id = connectionId(input.provider, input.connection);
    const now = new Date().toISOString();
    const existing = file.connections[id];
    const next: CredentialConnectionRecord = {
      id,
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    file.connections[id] = next;
    this.write(file);
    return next;
  }

  remove(provider: string, connection: string): CredentialConnectionRecord | null {
    const file = this.read();
    const id = connectionId(provider, connection);
    const existing = file.connections[id] ?? null;
    if (!existing) return null;
    delete file.connections[id];
    this.write(file);
    return existing;
  }

  private read(): StoreFile {
    if (!existsSync(this.path)) return { version: 1, connections: {} };
    const parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid credential broker store: ${this.path}`);
    }
    const file = parsed as Partial<StoreFile>;
    if (file.version !== 1 || !file.connections || typeof file.connections !== "object") {
      throw new Error(`Unsupported credential broker store shape: ${this.path}`);
    }
    return { version: 1, connections: file.connections };
  }

  private write(file: StoreFile): void {
    const dir = dirname(this.path);
    const dirExisted = existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!dirExisted) chmodSync(dir, 0o700);
    const tmp = join(dir, `.connections.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
  }
}

export function connectionId(provider: string, connection: string): string {
  const providerId = normalizeIdentifier(provider, "provider");
  const connectionId = normalizeIdentifier(connection, "connection");
  return `${providerId}:${connectionId}`;
}

export function normalizeIdentifier(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`${label} must use lowercase letters, numbers, dot, underscore or dash.`);
  }
  return normalized;
}

function normalizePageNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
