import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";

export function getCredentialsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.RAVI_CREDENTIALS_DB_PATH?.trim() || join(getRaviStateDir(env), "credentials.db");
}

/** Stores owned for the daemon's entire lifetime, before any of them is opened. */
export function runtimeStateDatabasePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = getRaviStateDir(env);
  return [
    join(root, "ravi.db"),
    join(root, "chat.db"),
    getCredentialsDbPath(env),
    join(root, "insights.db"),
    join(root, "knowledge.db"),
    join(root, "devin.db"),
    join(root, "human-bridge", "bridge.db"),
  ];
}
