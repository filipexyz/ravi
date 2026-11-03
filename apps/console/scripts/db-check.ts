import { sql } from "drizzle-orm";

import { db, dbClient, getDatabaseUrl } from "@/server/db";

const [row] = await db.execute<{ ok: number }>(sql`select 1 as ok`);

if (!row) {
  throw new Error("Database check returned no rows.");
}

console.log(
  JSON.stringify(
    {
      ok: row.ok === 1,
      databaseUrl: getDatabaseUrl().replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@"),
    },
    null,
    2,
  ),
);

await dbClient.end();
