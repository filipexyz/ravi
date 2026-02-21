/**
 * Omni Service Discovery
 *
 * Resolves omni API connection details:
 * 1. Env vars (OMNI_API_URL, OMNI_API_KEY)
 * 2. ~/.omni/config.json (omni's own config)
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./utils/logger.js";

const log = logger.child("omni-config");

const OMNI_CONFIG_PATH = join(homedir(), ".omni", "config.json");

export interface OmniConnection {
  apiUrl: string;
  apiKey: string;
  source: "env" | "omni-config";
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
