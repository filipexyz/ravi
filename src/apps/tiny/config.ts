import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const TENANT_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DEFAULT_API_BASE_URL = "https://api.tiny.com.br/api2";
const OFFICIAL_API_HOST = "api.tiny.com.br";

export interface TinyTenantConfig {
  tenant: string;
  apiVersion: "v2" | "v3";
  credentialProvider: "tiny";
  credentialConnection: string;
  baseUrl: string;
}

export interface LoadedTinyTenantConfig {
  config: TinyTenantConfig;
}

export function tinyConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const stateDirectory = env.RAVI_STATE_DIR?.trim() || join(homedir(), ".ravi");
  return env.RAVI_TINY_CONFIG_DIR?.trim() || join(stateDirectory, "apps", "tiny", "tenants");
}

export async function loadTinyTenantConfig(
  tenant: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedTinyTenantConfig> {
  if (!TENANT_PATTERN.test(tenant)) {
    throw new Error("Tenant Tiny invalido: use letras minusculas, numeros e hifens (maximo 63 caracteres).");
  }

  const raw = await readFile(join(tinyConfigDirectory(env), `${tenant}.json`), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Configuracao Tiny ausente para o tenant ${tenant}.`);
    }
    throw error;
  });
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error(`Configuracao Tiny invalida para o tenant ${tenant}.`);
  if (parsed.tenant !== tenant) throw new Error(`Configuracao Tiny pertence a outro tenant: ${String(parsed.tenant)}.`);
  if (parsed.apiVersion !== "v2" && parsed.apiVersion !== "v3") {
    throw new Error("apiVersion Tiny deve ser v2 ou v3.");
  }
  if (parsed.credentialEnv !== undefined) {
    throw new Error("credentialEnv legado nao e aceito; use credentialConnection no broker Ravi.");
  }
  const credentialConnection = normalizeConnection(parsed.credentialConnection ?? tenant);

  const baseUrl = normalizeBaseUrl(parsed.baseUrl, parsed.apiVersion, env);
  return {
    config: {
      tenant,
      apiVersion: parsed.apiVersion,
      credentialProvider: "tiny",
      credentialConnection,
      baseUrl,
    },
  };
}

function normalizeBaseUrl(value: unknown, apiVersion: "v2" | "v3", env: NodeJS.ProcessEnv): string {
  const expectedBaseUrl = apiVersion === "v2" ? DEFAULT_API_BASE_URL : "https://api.tiny.com.br/public-api/v3";
  const expectedPath = apiVersion === "v2" ? "/api2" : "/public-api/v3";
  const raw = typeof value === "string" && value.trim() ? value.trim() : expectedBaseUrl;
  const url = new URL(raw);
  const isLocalTest = (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.protocol === "http:";
  if (isLocalTest && env.RAVI_TINY_ALLOW_LOCAL_HTTP === "1") return raw.replace(/\/+$/, "");

  if (
    url.protocol !== "https:" ||
    url.hostname !== OFFICIAL_API_HOST ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.replace(/\/+$/, "") !== expectedPath
  ) {
    throw new Error(`baseUrl Tiny ${apiVersion} live deve ser ${expectedBaseUrl}.`);
  }
  return raw.replace(/\/+$/, "");
}

function normalizeConnection(value: unknown): string {
  if (typeof value !== "string") throw new Error("credentialConnection Tiny deve ser string.");
  const connection = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(connection)) {
    throw new Error("credentialConnection Tiny deve usar letras minusculas, numeros, ponto, underscore ou hifen.");
  }
  return connection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
