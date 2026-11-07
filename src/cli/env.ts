/**
 * Load environment from ~/.ravi/.env
 * This file must be imported FIRST before any other modules.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { markRaviEnvFileSourced } from "../runtime/ravi-env-file-origin.js";

import { captureRuntimeBootObservation } from "../runtime-process-identity.js";

captureRuntimeBootObservation();

const envFile = join(getRaviStateDir(), ".env");
const isChannelRunner = process.argv[2] === "channels" && process.argv[3] === "run";

if (existsSync(envFile)) {
  const content = readFileSync(envFile, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Remove quotes if present
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // A runner restart must reload the managed file over PM2/updater inheritance.
    // Ordinary CLI invocations keep the caller's environment precedence.
    if (isChannelRunner || !process.env[key]) {
      process.env[key] = value;
      markRaviEnvFileSourced(process.env, key, value, envFile);
    }
  }
}
