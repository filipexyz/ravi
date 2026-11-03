import { defineConfig } from "drizzle-kit";

import { getDatabaseUrl } from "./src/server/db/url";

const databaseUrl = getDatabaseUrl({ purpose: "migration" });

export default defineConfig({
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
  strict: true,
  verbose: true,
});
