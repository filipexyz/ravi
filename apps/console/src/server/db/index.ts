import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";
import { getDatabaseUrl } from "./url";

type PostgresClient = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as {
  raviConsoleDbClient?: PostgresClient;
};

export const dbClient =
  globalForDb.raviConsoleDbClient ??
  postgres(getDatabaseUrl(), {
    max: 10,
    prepare: false,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.raviConsoleDbClient = dbClient;
}

export const db = drizzle(dbClient, { schema });
export { schema };
export { getDatabaseUrl, resolveDatabaseUrl } from "./url";
