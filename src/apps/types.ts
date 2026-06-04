export type RaviAppManifestSource = "repo" | "plugin" | "state";

export interface RaviAppPermissions {
  required: string[];
  optional: string[];
  mutating: string[];
}

export interface RaviAppManifest {
  schema: string;
  id: string;
  name: string;
  version: string;
  description: string;
  interfaces: Record<string, unknown>;
  operations?: unknown;
  permissions?: Partial<RaviAppPermissions>;
  storage?: unknown;
  artifacts?: unknown;
  events?: unknown;
  skills?: unknown;
  health?: unknown;
  versioning?: unknown;
  [key: string]: unknown;
}

export interface RaviAppManifestRecord {
  id: string;
  name: string | null;
  version: string | null;
  description: string | null;
  schema: string | null;
  source: RaviAppManifestSource;
  path: string;
  relativePath: string;
  rootPath: string;
  interfaceNames: string[];
  permissions: RaviAppPermissions;
  valid: boolean;
  errors: string[];
  warnings: string[];
  manifest: RaviAppManifest | null;
}

export interface RaviAppDiscoveryRoot {
  source: RaviAppManifestSource;
  rootPath: string;
}

export interface RaviAppDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RaviAppListOptions extends RaviAppDiscoveryOptions {
  source?: RaviAppManifestSource;
}

export interface RaviAppCheckResult {
  id: string;
  path: string;
  source: RaviAppManifestSource;
  ok: boolean;
  errors: string[];
  warnings: string[];
}
