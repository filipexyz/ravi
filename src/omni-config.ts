/**
 * Omni Service Discovery
 *
 * Resolves omni API connection details:
 * 1. Env vars (OMNI_API_URL, OMNI_API_KEY)
 * 2. ~/.omni/config.json (omni's own config)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./utils/logger.js";

const log = logger.child("omni-config");

const OMNI_CONFIG_PATH = join(homedir(), ".omni", "config.json");

/** Server name the Omni CLI treats as the local/default remote target. */
export const OMNI_CLI_DEFAULT_SERVER = "default";

export interface OmniConnection {
  apiUrl: string;
  apiKey: string;
  source: "env" | "omni-config";
}

export interface OmniCliAuthEnv {
  OMNI_API_URL: string;
  OMNI_API_KEY: string;
  OMNI_CONFIG_DIR: string;
}

interface OmniConfig {
  apiUrl?: string;
  apiKey?: string;
  natsUrl?: string;
  [key: string]: unknown;
}

/**
 * Read and parse ~/.omni/config.json.
 */
export function readOmniConfig(): OmniConfig | null {
  if (!existsSync(OMNI_CONFIG_PATH)) return null;

  try {
    const raw = readFileSync(OMNI_CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as OmniConfig;
  } catch (err) {
    log.warn("Failed to parse ~/.omni/config.json", { error: err });
    return null;
  }
}

/**
 * Resolve omni API connection.
 */
export function resolveOmniConnection(): OmniConnection | null {
  // 1. Env vars (highest priority)
  if (process.env.OMNI_API_URL && process.env.OMNI_API_KEY) {
    return {
      apiUrl: process.env.OMNI_API_URL,
      apiKey: process.env.OMNI_API_KEY,
      source: "env",
    };
  }

  // 2. ~/.omni/config.json
  const omniConfig = readOmniConfig();
  if (omniConfig?.apiUrl && omniConfig?.apiKey) {
    return {
      apiUrl: omniConfig.apiUrl,
      apiKey: omniConfig.apiKey,
      source: "omni-config",
    };
  }

  return null;
}

/**
 * Write an isolated Omni CLI config that projects the Ravi-resolved
 * connection onto both the legacy flat fields and `servers.list.default`.
 *
 * The Omni CLI (`@automagik/omni`) authenticates client commands from
 * `servers.list.<active>.apiKey` via `OMNI_CONFIG_DIR` / `~/.omni/config.json`.
 * That server entry can be stale while the top-level `apiKey` / `OMNI_API_KEY`
 * (what {@link resolveOmniConnection} returns) is still valid. A child `omni`
 * process pointed at this directory cannot prefer the stale server key.
 */
export function materializeOmniCliAuthConfig(connection: OmniConnection, configDir: string): string {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const configPath = join(configDir, "config.json");
  const config = {
    apiUrl: connection.apiUrl,
    apiKey: connection.apiKey,
    servers: {
      active: OMNI_CLI_DEFAULT_SERVER,
      list: {
        [OMNI_CLI_DEFAULT_SERVER]: {
          url: connection.apiUrl,
          apiKey: connection.apiKey,
        },
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return configPath;
}

/**
 * Env overlay that forces a spawned Omni CLI to use the same credentials as
 * the Ravi Omni client/runtime.
 */
export function buildOmniCliAuthEnv(connection: OmniConnection, configDir: string): OmniCliAuthEnv {
  return {
    OMNI_API_URL: connection.apiUrl,
    OMNI_API_KEY: connection.apiKey,
    OMNI_CONFIG_DIR: configDir,
  };
}

/**
 * Check if omni CLI is installed (i.e. ~/.omni/config.json exists).
 */
export function isOmniInstalled(): boolean {
  return existsSync(OMNI_CONFIG_PATH);
}

/**
 * Check if omni API is healthy.
 */
export async function isOmniHealthy(apiUrl?: string): Promise<boolean> {
  const url = apiUrl ?? "http://127.0.0.1:8882";
  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}
