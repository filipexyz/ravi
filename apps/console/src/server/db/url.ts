const LOCAL_DATABASE_URL =
  "postgres://ravi_console:ravi_console_dev@localhost:55432/ravi_console";

const runtimeDatabaseUrlKeys = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
] as const;

const migrationDatabaseUrlKeys = [
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
] as const;

type DatabaseUrlPurpose = "runtime" | "migration";

type ResolveDatabaseUrlOptions = {
  allowLocalFallback?: boolean;
  purpose?: DatabaseUrlPurpose;
};

export type ResolvedDatabaseUrl = {
  isLocalFallback: boolean;
  source: string;
  url: string;
};

export function resolveDatabaseUrl(options: ResolveDatabaseUrlOptions = {}): ResolvedDatabaseUrl {
  const keys = options.purpose === "migration" ? migrationDatabaseUrlKeys : runtimeDatabaseUrlKeys;

  for (const key of keys) {
    const value = normalizeDatabaseUrl(process.env[key]);
    if (value) {
      return {
        isLocalFallback: false,
        source: key,
        url: value,
      };
    }
  }

  if (shouldAllowLocalFallback(options.allowLocalFallback)) {
    return {
      isLocalFallback: true,
      source: "local-dev-fallback",
      url: LOCAL_DATABASE_URL,
    };
  }

  throw new Error(
    `Ravi Console database URL is not configured. Set one of: ${keys.join(
      ", ",
    )}. Refusing to use the local development database fallback in this environment.`,
  );
}

export function getDatabaseUrl(options: ResolveDatabaseUrlOptions = {}) {
  return resolveDatabaseUrl(options).url;
}

function normalizeDatabaseUrl(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized || normalized === '""' || normalized === "''") return null;
  return normalized;
}

function shouldAllowLocalFallback(override: boolean | undefined) {
  if (override !== undefined) return override;
  if (process.env.RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK === "true") return false;
  return true;
}
