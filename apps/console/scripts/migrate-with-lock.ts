import { spawn } from "node:child_process";
import postgres from "postgres";

import { resolveDatabaseUrl } from "@/server/db/url";
import {
  assertInboxMigrationState,
  MigrationCommandError,
  migrationCommandFailure,
  readInboxCatalogState,
} from "./lib/inbox-migration-preflight";

const LOCK_NAMESPACE = 828_326_486;
const LOCK_KEY = 260_509;

const allowLocalFallback = !isVercelBuild();
const databaseUrl = resolveDatabaseUrl({ purpose: "migration", allowLocalFallback });

console.log(`Using ${databaseUrl.source} for database migrations.`);

const sql = postgres(databaseUrl.url, {
  max: 1,
  prepare: false,
});

try {
  console.log("Acquiring database migration lock...");
  await sql`select pg_advisory_lock(${LOCK_NAMESPACE}, ${LOCK_KEY})`;
  console.log("Database migration lock acquired.");
  assertInboxMigrationState(await readInboxCatalogState(sql), "preflight");
  console.log("Inbox migration preflight passed.");
  await run("bun", ["run", "db:migrate"]);
  assertInboxMigrationState(await readInboxCatalogState(sql), "postflight");
  console.log("Inbox migration postflight passed.");
} catch (error) {
  if (!(error instanceof MigrationCommandError)) throw error;
  console.error(error.message);
  process.exitCode = error.exitCode;
} finally {
  try {
    await sql`select pg_advisory_unlock(${LOCK_NAMESPACE}, ${LOCK_KEY})`;
    console.log("Database migration lock released.");
  } finally {
    await sql.end();
  }
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK: allowLocalFallback
          ? process.env.RAVI_CONSOLE_DISABLE_LOCAL_DB_FALLBACK
          : "true",
      },
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const failure = migrationCommandFailure(code, signal);
      if (!failure) {
        resolve();
        return;
      }
      reject(failure);
    });
  });
}

function isVercelBuild() {
  return process.env.VERCEL === "1";
}
