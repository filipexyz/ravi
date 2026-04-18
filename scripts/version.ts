#!/usr/bin/env bun

/**
 * Sync Ravi package version to the date-based release format.
 *
 * Format: <prefix>.YYMMDD.N
 * Example: 3.260418.2
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
  [key: string]: unknown;
};

function repoRoot(): string {
  return join(dirname(import.meta.path), "..");
}

function todayUtc(): string {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function readCurrentPackage(root: string): PackageJson {
  const packagePath = join(root, "package.json");
  return JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
}

function resolvePrefix(pkg: PackageJson): string {
  const explicit = process.env.RAVI_VERSION_PREFIX?.trim();
  if (explicit) return explicit;

  const current = pkg.version ?? "3.0.0";
  const [major] = current.split(".");
  return /^\d+$/.test(major) ? major : "3";
}

function countTagsForToday(prefix: string, datePrefix: string): number {
  try {
    const output = execSync(`git tag --list "v${prefix}.${datePrefix}.*"`, {
      encoding: "utf8",
      timeout: 5000,
    });
    return output.trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

function resolveBuildNumber(prefix: string, datePrefix: string): number {
  const explicit = process.env.RAVI_BUILD_NUMBER?.trim();
  if (explicit) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    throw new Error(`Invalid RAVI_BUILD_NUMBER: ${explicit}`);
  }

  return countTagsForToday(prefix, datePrefix) + 1;
}

async function updatePackageVersion(root: string, version: string): Promise<void> {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) throw new Error(`package.json not found: ${packagePath}`);

  const pkg = JSON.parse(await readFile(packagePath, "utf8")) as PackageJson;
  pkg.version = version;
  await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function main(): Promise<void> {
  const root = repoRoot();
  const pkg = readCurrentPackage(root);
  const prefix = resolvePrefix(pkg);
  const datePrefix = todayUtc();
  const buildNumber = resolveBuildNumber(prefix, datePrefix);
  const version = process.env.RAVI_VERSION?.trim() || `${prefix}.${datePrefix}.${buildNumber}`;

  await updatePackageVersion(root, version);
  console.log(`Ravi version: ${version}`);
  console.log("Updated package.json");
}

main().catch((error) => {
  console.error(`Version sync failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
