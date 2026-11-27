/**
 * Install, update, roll back, uninstall and expose store apps (spec apps/store).
 *
 * Every change is planned first and applied only on `execute`, so the CLI can
 * show the operator the exact version, tree hash, class and grants before any
 * file moves. Nothing here changes a permission: a receipt only narrows what
 * agents see (see gate.ts).
 */

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { semver } from "bun";
import packageInfo from "../../../package.json" with { type: "json" };
import { isExactVersion, satisfiesRange } from "../composition.js";
import { DIRECTORY_SKIPLIST, discoverAppManifests, readAppManifestFile } from "../service.js";
import { classifyAppManifest, type ClassifyOptions } from "./classify.js";
import {
  type AppPackageFile,
  checkPackageFiles,
  packageTreeHash,
  readPackageDir,
  sha256Hex,
  writePackageDir,
} from "./package.js";
import { appIdFileName, appIdToPath, appStoreRoot, stateAppsRoot } from "./paths.js";
import { ensureStoreInitialized, listReceipts, readReceipt, receiptPath, writeReceipt } from "./receipts.js";
import {
  APP_BUNDLE_MAX_BYTES,
  type AppStoreContext,
  defaultAppStoreFetcher,
  findBlock,
  loadCachedSource,
  refreshSource,
  sourceFileUrl,
  type VerifiedSource,
} from "./source.js";
import {
  APP_RECEIPT_SCHEMA,
  type AppGrants,
  type AppIndexVersion,
  type AppReceipt,
  AppStoreError,
  appBundleFileSchema,
  type RaviAppClass,
} from "./types.js";

export const UPDATE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const KEEP_PACKAGES = 3;

export interface StoreOperationContext extends AppStoreContext, ClassifyOptions {
  cwd?: string;
  raviVersion?: string;
}

export interface GrantsDiff {
  contextAllow: { added: string[]; removed: string[] };
  operations: { added: string[]; removed: string[]; changed: string[] };
}

export interface StorePlan {
  action: "install" | "update" | "rollback";
  id: string;
  source: "official" | "local";
  version: string;
  class: RaviAppClass;
  treeHash: string;
  grants: AppGrants;
  from: { version: string; treeHash: string } | null;
  grantsDiff: GrantsDiff | null;
  /** Agents that keep seeing the app after this change. */
  exposedTo: string[];
  notes: string[];
}

export interface PreparedChange {
  plan: StorePlan;
  files: AppPackageFile[];
}

function now(ctx: StoreOperationContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

export function diffGrants(before: AppGrants | null, after: AppGrants): GrantsDiff {
  const prevAllow = new Set(before?.contextAllow ?? []);
  const nextAllow = new Set(after.contextAllow);
  const prevOps = before?.operations ?? {};
  return {
    contextAllow: {
      added: [...nextAllow].filter((entry) => !prevAllow.has(entry)).sort(),
      removed: [...prevAllow].filter((entry) => !nextAllow.has(entry)).sort(),
    },
    operations: {
      added: Object.keys(after.operations)
        .filter((id) => !(id in prevOps))
        .sort(),
      removed: Object.keys(prevOps)
        .filter((id) => !(id in after.operations))
        .sort(),
      changed: Object.keys(after.operations)
        .filter((id) => id in prevOps && JSON.stringify(prevOps[id]) !== JSON.stringify(after.operations[id]))
        .sort(),
    },
  };
}

function grantsEqual(left: AppGrants, right: AppGrants): boolean {
  const diff = diffGrants(left, right);
  return (
    diff.contextAllow.added.length === 0 &&
    diff.contextAllow.removed.length === 0 &&
    diff.operations.added.length === 0 &&
    diff.operations.removed.length === 0 &&
    diff.operations.changed.length === 0
  );
}

function compareVersions(left: string, right: string): number {
  if (isExactVersion(left) && isExactVersion(right)) return semver.order(left, right);
  return left.localeCompare(right);
}

/** The newest active version that is not blocked and that this Ravi can run. */
function pickVersion(
  verified: VerifiedSource,
  id: string,
  requested: string | undefined,
  raviVersion: string,
): AppIndexVersion {
  const entry = verified.index.apps[id];
  if (!entry) {
    throw new AppStoreError("APP_NOT_IN_INDEX", `${id} is not in the ${verified.source.id} index.`, 1, { id });
  }
  const usable = (version: AppIndexVersion) =>
    version.status === "active" && !findBlock(verified.blocklist, id, version.version, version.treeHash);
  if (requested) {
    const version = entry.versions.find((candidate) => candidate.version === requested);
    if (!version) {
      throw new AppStoreError("APP_VERSION_NOT_FOUND", `${id}@${requested} is not in the index.`, 1, { id, requested });
    }
    const block = findBlock(verified.blocklist, id, version.version, version.treeHash);
    if (block) {
      throw new AppStoreError(
        "APP_BLOCKED",
        `${id}@${requested} is blocked: ${block.reason || "no reason given"}.`,
        3,
        {
          id,
          version: requested,
          reason: block.reason,
        },
      );
    }
    if (version.status !== "active") {
      throw new AppStoreError("APP_VERSION_YANKED", `${id}@${requested} was withdrawn from the index.`, 3, {
        id,
        version: requested,
      });
    }
    checkEngine(id, version, raviVersion);
    return version;
  }
  const candidates = entry.versions
    .filter(usable)
    .filter((version) => !version.engines.ravi || satisfiesRange(raviVersion, version.engines.ravi))
    .sort((left, right) => compareVersions(right.version, left.version));
  const chosen = candidates[0];
  if (!chosen) {
    throw new AppStoreError(
      "APP_NO_INSTALLABLE_VERSION",
      `${id} has no version this Ravi (${raviVersion}) can install.`,
      1,
      {
        id,
      },
    );
  }
  return chosen;
}

function checkEngine(id: string, version: AppIndexVersion, raviVersion: string): void {
  if (version.engines.ravi && !satisfiesRange(raviVersion, version.engines.ravi)) {
    throw new AppStoreError(
      "APP_ENGINE_MISMATCH",
      `${id}@${version.version} needs Ravi ${version.engines.ravi}; this is ${raviVersion}.`,
      1,
      { id, version: version.version, engines: version.engines },
    );
  }
}

async function downloadBundle(
  ctx: StoreOperationContext,
  verified: VerifiedSource,
  id: string,
  version: AppIndexVersion,
): Promise<AppPackageFile[]> {
  const fetcher = ctx.fetcher ?? defaultAppStoreFetcher;
  const bytes = await fetcher(sourceFileUrl(verified.source, version.bundle.path), APP_BUNDLE_MAX_BYTES);
  if (bytes.byteLength !== version.bundle.size || sha256Hex(bytes) !== version.bundle.sha256) {
    throw new AppStoreError(
      "APP_BUNDLE_MISMATCH",
      `The bundle of ${id}@${version.version} does not match the index.`,
      1,
      {
        id,
        version: version.version,
      },
    );
  }
  let bundle: ReturnType<typeof appBundleFileSchema.parse>;
  try {
    bundle = appBundleFileSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (error) {
    throw new AppStoreError("APP_BUNDLE_MISMATCH", `The bundle of ${id}@${version.version} is malformed.`, 1, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (bundle.id !== id || bundle.version !== version.version) {
    throw new AppStoreError("APP_BUNDLE_MISMATCH", `The bundle names ${bundle.id}@${bundle.version}.`, 1, {
      id,
      version: version.version,
    });
  }
  const files = checkPackageFiles(bundle.files);
  if (packageTreeHash(files) !== version.treeHash) {
    throw new AppStoreError(
      "APP_BUNDLE_MISMATCH",
      `The files of ${id}@${version.version} do not match the index hash.`,
      1,
      {
        id,
        version: version.version,
      },
    );
  }
  return files;
}

/** Validate a package as an app: manifest valid, id and version as expected, class derived. */
export function inspectPackage(
  files: AppPackageFile[],
  expected: { id?: string; version?: string },
  ctx: StoreOperationContext = {},
): { id: string; version: string; class: RaviAppClass; reasons: string[]; grants: AppGrants; treeHash: string } {
  const sorted = checkPackageFiles(files);
  // Planning never writes store state: the manifest check runs in a throwaway folder outside it.
  const scratch = mkdtempSync(join(tmpdir(), "ravi-app-inspect-"));
  const staging = join(scratch, "app");
  try {
    writePackageDir(staging, sorted);
    const record = readAppManifestFile(join(staging, "ravi.app.json"), dirname(staging));
    const problems = record.errors.filter((error) => !error.startsWith("Manifest id"));
    if (problems.length > 0 || !record.manifest) {
      throw new AppStoreError("APP_PACKAGE_INVALID", `The app manifest is invalid: ${problems.join("; ")}`, 1, {
        errors: problems,
      });
    }
    const id = record.manifest.id.trim().toLowerCase();
    const version = String(record.manifest.version);
    if (expected.id && id !== expected.id) {
      throw new AppStoreError("APP_PACKAGE_INVALID", `The package declares app ${id}, expected ${expected.id}.`);
    }
    if (expected.version && version !== expected.version) {
      throw new AppStoreError(
        "APP_PACKAGE_INVALID",
        `The package declares version ${version}, expected ${expected.version}.`,
      );
    }
    const classification = classifyAppManifest(record.manifest, ctx);
    return {
      id,
      version,
      class: classification.class,
      reasons: classification.reasons,
      grants: classification.grants,
      treeHash: packageTreeHash(sorted),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Deepest folder discovery reads under the state apps root (see findManifestFiles). */
const MAX_ID_SEGMENTS = 5;

function nested(left: string, right: string): boolean {
  return left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

/**
 * The app's folder must be one discovery reads, and no other app may own the
 * same id, a parent folder or a child folder (spec: an id is never shadowed).
 */
function assertNoForeignApp(id: string, ctx: StoreOperationContext): void {
  const segments = appIdToPath(id);
  if (segments.length > MAX_ID_SEGMENTS || segments.some((segment) => DIRECTORY_SKIPLIST.has(segment))) {
    throw new AppStoreError(
      "APP_ID_UNSUPPORTED",
      `${id} cannot be installed: discovery skips that folder name or depth.`,
      1,
      { id },
    );
  }
  const owned = !!readReceipt(id, ctx.env);
  const records = discoverAppManifests({ cwd: ctx.cwd, env: ctx.env });
  const clash = records.find((record) => {
    const other = record.manifest?.id ?? record.id;
    return (other === id && !owned) || nested(other, id);
  });
  const receiptClash = listReceipts(ctx.env).find((receipt) => nested(receipt.id, id));
  const conflict = clash
    ? { id: clash.manifest?.id ?? clash.id, path: clash.path }
    : receiptClash
      ? { id: receiptClash.id, path: activeDirFor(receiptClash.id, ctx) }
      : null;
  if (conflict) {
    throw new AppStoreError("APP_ID_CONFLICT", `${id} conflicts with the app ${conflict.id} at ${conflict.path}.`, 1, {
      id,
      conflictsWith: conflict.id,
      path: conflict.path,
    });
  }
}

export async function prepareOfficialInstall(
  id: string,
  options: { version?: string; persist?: boolean },
  ctx: StoreOperationContext = {},
): Promise<PreparedChange> {
  const existing = readReceipt(id, ctx.env);
  if (existing) {
    throw new AppStoreError(
      "APP_ALREADY_INSTALLED",
      `${id}@${existing.version} is already installed; use ravi apps update.`,
      1,
      {
        id,
        version: existing.version,
      },
    );
  }
  assertNoForeignApp(id, ctx);
  // A plan verifies the source without saving it; only an install that goes ahead updates the cache.
  const verified = await refreshSource(ctx, { persist: options.persist !== false });
  const raviVersion = ctx.raviVersion ?? packageInfo.version;
  const version = pickVersion(verified, id, options.version, raviVersion);
  if (version.class !== "compose") {
    throw new AppStoreError(
      "APP_CLASS_UNSUPPORTED",
      `${id}@${version.version} is a ${version.class} app; this Ravi installs only compose apps from the index.`,
      3,
      { id, class: version.class },
    );
  }
  const files = await downloadBundle(ctx, verified, id, version);
  const inspected = inspectPackage(files, { id, version: version.version }, ctx);
  assertMatchesIndex(id, version, inspected);
  return {
    files,
    plan: {
      action: "install",
      id,
      source: "official",
      version: version.version,
      class: inspected.class,
      treeHash: inspected.treeHash,
      grants: inspected.grants,
      from: null,
      grantsDiff: diffGrants(null, inspected.grants),
      exposedTo: [],
      notes: ["Installing exposes the app to no agent. Use ravi apps allow <id> --agent <agent> afterwards."],
    },
  };
}

function assertMatchesIndex(
  id: string,
  version: AppIndexVersion,
  inspected: { class: RaviAppClass; grants: AppGrants; reasons: string[] },
): void {
  if (inspected.class !== version.class) {
    throw new AppStoreError(
      "APP_CLASS_MISMATCH",
      `${id}@${version.version} is listed as ${version.class} but its manifest is ${inspected.class}: ${inspected.reasons.join("; ")}`,
      1,
      { id, reasons: inspected.reasons },
    );
  }
  if (!grantsEqual(inspected.grants, version.grants)) {
    throw new AppStoreError(
      "APP_GRANTS_MISMATCH",
      `The grants of ${id}@${version.version} differ from the ones the index shows.`,
      1,
      { id, diff: diffGrants(version.grants, inspected.grants) },
    );
  }
}

export function prepareLocalInstall(
  dir: string,
  options: { allowCode?: boolean },
  ctx: StoreOperationContext = {},
): PreparedChange {
  const files = readPackageDir(dir);
  const inspected = inspectPackage(files, {}, ctx);
  if (inspected.class === "code" && !options.allowCode) {
    throw new AppStoreError(
      "APP_CODE_REQUIRES_OPT_IN",
      `${inspected.id} runs commands other than ravi (${inspected.reasons.join("; ")}). It would run with the operator's authority; pass --allow-code to install it anyway.`,
      3,
      { id: inspected.id, reasons: inspected.reasons },
    );
  }
  const existing = readReceipt(inspected.id, ctx.env);
  assertNoForeignApp(inspected.id, ctx);
  if (existing && existing.source !== "local") {
    throw new AppStoreError(
      "APP_SOURCE_CONFLICT",
      `${inspected.id} was installed from the ${existing.source} source.`,
      1,
    );
  }
  const keepExposure = existing
    ? grantsEqual(existing.grants, inspected.grants) && inspected.class === existing.class
    : false;
  return {
    files,
    plan: {
      action: existing ? "update" : "install",
      id: inspected.id,
      source: "local",
      version: inspected.version,
      class: inspected.class,
      treeHash: inspected.treeHash,
      grants: inspected.grants,
      from: existing ? { version: existing.version, treeHash: existing.treeHash } : null,
      grantsDiff: diffGrants(existing?.grants ?? null, inspected.grants),
      exposedTo: keepExposure ? (existing?.exposedTo ?? []) : [],
      notes: [
        ...(inspected.class === "code" ? ["This app runs its own code with the operator's authority."] : []),
        ...(existing && !keepExposure && existing.exposedTo.length > 0
          ? [`Grants changed: exposure to ${existing.exposedTo.join(", ")} is cleared.`]
          : []),
      ],
    },
  };
}

export async function prepareOfficialUpdate(
  id: string,
  options: { version?: string; skipCooldown?: boolean; persist?: boolean },
  ctx: StoreOperationContext = {},
): Promise<PreparedChange | { upToDate: true; id: string; version: string }> {
  const receipt = readReceipt(id, ctx.env);
  if (!receipt) throw new AppStoreError("APP_NOT_INSTALLED", `${id} is not installed from the store.`, 1, { id });
  if (receipt.source !== "official") {
    throw new AppStoreError("APP_SOURCE_CONFLICT", `${id} was installed from a folder; reinstall it with --from.`, 1, {
      id,
    });
  }
  // A plan verifies the source without saving it; only an install that goes ahead updates the cache.
  const verified = await refreshSource(ctx, { persist: options.persist !== false });
  const raviVersion = ctx.raviVersion ?? packageInfo.version;
  const version = pickVersion(verified, id, options.version, raviVersion);
  if (version.treeHash === receipt.treeHash && version.version === receipt.version) {
    return { upToDate: true, id, version: receipt.version };
  }
  if (!options.version && compareVersions(version.version, receipt.version) < 0) {
    return { upToDate: true, id, version: receipt.version };
  }
  const age = now(ctx).getTime() - Date.parse(version.publishedAt);
  if (!version.security && !options.skipCooldown && age < UPDATE_COOLDOWN_MS) {
    const until = new Date(Date.parse(version.publishedAt) + UPDATE_COOLDOWN_MS).toISOString();
    throw new AppStoreError(
      "APP_UPDATE_COOLDOWN",
      `${id}@${version.version} was published less than 24 hours ago; it can be installed after ${until}.`,
      3,
      { id, version: version.version, until },
    );
  }
  if (version.class !== "compose") {
    throw new AppStoreError("APP_CLASS_UNSUPPORTED", `${id}@${version.version} is a ${version.class} app.`, 3, { id });
  }
  const files = await downloadBundle(ctx, verified, id, version);
  const inspected = inspectPackage(files, { id, version: version.version }, ctx);
  assertMatchesIndex(id, version, inspected);
  const keepExposure = grantsEqual(receipt.grants, inspected.grants);
  return {
    files,
    plan: {
      action: "update",
      id,
      source: "official",
      version: version.version,
      class: inspected.class,
      treeHash: inspected.treeHash,
      grants: inspected.grants,
      from: { version: receipt.version, treeHash: receipt.treeHash },
      grantsDiff: diffGrants(receipt.grants, inspected.grants),
      exposedTo: keepExposure ? receipt.exposedTo : [],
      notes:
        !keepExposure && receipt.exposedTo.length > 0
          ? [`Grants changed: exposure to ${receipt.exposedTo.join(", ")} is cleared; allow again after review.`]
          : [],
    },
  };
}

function packageDirFor(id: string, version: string, treeHash: string, ctx: StoreOperationContext): string {
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(appStoreRoot(ctx.env), "packages", appIdFileName(id), `${safeVersion}-${treeHash.slice(0, 12)}`);
}

function activeDirFor(id: string, ctx: StoreOperationContext): string {
  return join(stateAppsRoot(ctx.env), ...appIdToPath(id));
}

function stampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Put `packageDir` in place as the active copy, moving any current copy to the trash. */
function activate(id: string, packageDir: string, ctx: StoreOperationContext): void {
  const root = appStoreRoot(ctx.env);
  const active = activeDirFor(id, ctx);
  const incoming = join(root, "staging", `${appIdFileName(id)}-${randomUUID()}`);
  mkdirSync(dirname(incoming), { recursive: true });
  cpSync(packageDir, incoming, { recursive: true, errorOnExist: true });
  if (existsSync(active)) {
    if (!readReceipt(id, ctx.env)) {
      throw new AppStoreError("APP_ID_CONFLICT", `${active} exists and was not installed by the store.`, 1, { id });
    }
    const trash = join(root, "trash", `${appIdFileName(id)}-${stampForPath(now(ctx))}-${randomUUID().slice(0, 8)}`);
    mkdirSync(dirname(trash), { recursive: true });
    renameSync(active, trash);
  }
  mkdirSync(dirname(active), { recursive: true });
  renameSync(incoming, active);
}

function storePackage(files: AppPackageFile[], dir: string, treeHash: string): void {
  if (existsSync(dir)) {
    if (packageTreeHash(readPackageDir(dir)) === treeHash) return;
    rmSync(dir, { recursive: true, force: true });
  }
  const tmp = `${dir}.${randomUUID()}.tmp`;
  writePackageDir(tmp, files);
  renameSync(tmp, dir);
}

function pruneOldPackages(receipt: AppReceipt, ctx: StoreOperationContext): void {
  const base = join(appStoreRoot(ctx.env), "packages", appIdFileName(receipt.id));
  if (!existsSync(base)) return;
  const keep = new Set([receipt.packagePath, ...receipt.previous.map((entry) => entry.packagePath)]);
  for (const name of readdirSync(base)) {
    const full = join(base, name);
    if (!keep.has(full)) rmSync(full, { recursive: true, force: true });
  }
}

function initializeBaseline(ctx: StoreOperationContext): void {
  const ids = discoverAppManifests({ cwd: ctx.cwd, env: ctx.env, source: "state" }).map((record) => record.id);
  ensureStoreInitialized(ids, ctx.env);
}

/** Apply a prepared install or update. Returns the new receipt. */
export function commitChange(prepared: PreparedChange, ctx: StoreOperationContext = {}): AppReceipt {
  const { plan, files } = prepared;
  if (packageTreeHash(checkPackageFiles(files)) !== plan.treeHash) {
    throw new AppStoreError("APP_PACKAGE_INVALID", "The package changed between plan and install.");
  }
  initializeBaseline(ctx);
  const previousReceipt = readReceipt(plan.id, ctx.env);
  const packageDir = packageDirFor(plan.id, plan.version, plan.treeHash, ctx);
  storePackage(files, packageDir, plan.treeHash);
  activate(plan.id, packageDir, ctx);
  const previous = previousReceipt
    ? [
        {
          version: previousReceipt.version,
          treeHash: previousReceipt.treeHash,
          packagePath: previousReceipt.packagePath,
          class: previousReceipt.class,
        },
        ...previousReceipt.previous,
      ]
        .filter((entry) => entry.packagePath !== packageDir)
        .slice(0, KEEP_PACKAGES - 1)
    : [];
  const receipt: AppReceipt = {
    schema: APP_RECEIPT_SCHEMA,
    id: plan.id,
    source: plan.source,
    version: plan.version,
    class: plan.class,
    treeHash: plan.treeHash,
    grants: plan.grants,
    packagePath: packageDir,
    installedAt: now(ctx).toISOString(),
    state: "active",
    quarantine: null,
    exposedTo: [...plan.exposedTo],
    previous,
  };
  writeReceipt(receipt, ctx.env);
  pruneOldPackages(receipt, ctx);
  return receipt;
}

export function planRollback(id: string, ctx: StoreOperationContext = {}): StorePlan & { packagePath: string } {
  const receipt = readReceipt(id, ctx.env);
  if (!receipt) throw new AppStoreError("APP_NOT_INSTALLED", `${id} is not installed from the store.`, 1, { id });
  const target = receipt.previous[0];
  if (!target)
    throw new AppStoreError("APP_NO_PREVIOUS_VERSION", `${id} has no earlier version to roll back to.`, 1, { id });
  if (!existsSync(target.packagePath) || packageTreeHash(readPackageDir(target.packagePath)) !== target.treeHash) {
    throw new AppStoreError(
      "APP_PACKAGE_MISSING",
      `The kept copy of ${id}@${target.version} is missing or changed.`,
      1,
      {
        id,
        version: target.version,
      },
    );
  }
  if (receipt.source === "official") {
    const cached = loadCachedSource(ctx);
    const block = cached ? findBlock(cached.blocklist, id, target.version, target.treeHash) : null;
    if (block) {
      throw new AppStoreError(
        "APP_BLOCKED",
        `${id}@${target.version} is blocked: ${block.reason || "no reason given"}.`,
        3,
        {
          id,
          version: target.version,
        },
      );
    }
  }
  const files = readPackageDir(target.packagePath);
  const inspected = inspectPackage(files, { id, version: target.version }, ctx);
  const keepExposure = grantsEqual(receipt.grants, inspected.grants);
  return {
    action: "rollback",
    id,
    source: receipt.source,
    version: target.version,
    class: inspected.class,
    treeHash: target.treeHash,
    grants: inspected.grants,
    from: { version: receipt.version, treeHash: receipt.treeHash },
    grantsDiff: diffGrants(receipt.grants, inspected.grants),
    exposedTo: keepExposure ? receipt.exposedTo : [],
    notes: [],
    packagePath: target.packagePath,
  };
}

export function commitRollback(plan: StorePlan & { packagePath: string }, ctx: StoreOperationContext = {}): AppReceipt {
  const receipt = readReceipt(plan.id, ctx.env);
  if (!receipt) throw new AppStoreError("APP_NOT_INSTALLED", `${plan.id} is not installed from the store.`, 1);
  activate(plan.id, plan.packagePath, ctx);
  const next: AppReceipt = {
    ...receipt,
    version: plan.version,
    class: plan.class,
    treeHash: plan.treeHash,
    grants: plan.grants,
    packagePath: plan.packagePath,
    installedAt: now(ctx).toISOString(),
    state: "active",
    quarantine: null,
    exposedTo: plan.exposedTo,
    previous: [
      { version: receipt.version, treeHash: receipt.treeHash, packagePath: receipt.packagePath, class: receipt.class },
      ...receipt.previous.filter((entry) => entry.packagePath !== plan.packagePath),
    ].slice(0, KEEP_PACKAGES - 1),
  };
  writeReceipt(next, ctx.env);
  return next;
}

/** Remove the active copy and the receipt; both go to the trash, so nothing is lost by accident. */
import { untrustApp } from "../trust.js";

export function uninstallApp(
  id: string,
  ctx: StoreOperationContext = {},
): { id: string; version: string; trash: string } {
  const receipt = readReceipt(id, ctx.env);
  if (!receipt) throw new AppStoreError("APP_NOT_INSTALLED", `${id} is not installed from the store.`, 1, { id });
  untrustApp(id, ctx.env);
  const trash = join(
    appStoreRoot(ctx.env),
    "trash",
    `${appIdFileName(id)}-${stampForPath(now(ctx))}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(trash, { recursive: true });
  const active = activeDirFor(id, ctx);
  if (existsSync(active)) renameSync(active, join(trash, "app"));
  renameSync(receiptPath(id, ctx.env), join(trash, "receipt.json"));
  return { id, version: receipt.version, trash };
}

export function setExposure(
  id: string,
  agentId: string,
  exposed: boolean,
  ctx: StoreOperationContext = {},
): { receipt: AppReceipt; changed: boolean } {
  const receipt = readReceipt(id, ctx.env);
  if (!receipt) throw new AppStoreError("APP_NOT_INSTALLED", `${id} is not installed from the store.`, 1, { id });
  const agent = agentId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) {
    throw new AppStoreError("INVALID_AGENT", `"${agentId}" is not an agent id.`, 2);
  }
  if (exposed && receipt.state !== "active") {
    throw new AppStoreError("APP_QUARANTINED", `${id} is quarantined: ${receipt.quarantine?.reason ?? ""}`, 3, { id });
  }
  const has = receipt.exposedTo.includes(agent);
  if (has === exposed) return { receipt, changed: false };
  const next = {
    ...receipt,
    exposedTo: exposed ? [...receipt.exposedTo, agent].sort() : receipt.exposedTo.filter((entry) => entry !== agent),
  };
  writeReceipt(next, ctx.env);
  return { receipt: next, changed: true };
}

export interface VerifyReport {
  id: string;
  version: string;
  source: "official" | "local";
  state: AppReceipt["state"];
  ok: boolean;
  problems: string[];
  exposedTo: string[];
}

/** Check installed trees against their receipts, and official apps against the cached block list. */
export function verifyInstalled(id: string | undefined, ctx: StoreOperationContext = {}): VerifyReport[] {
  const receipts = id
    ? [readReceipt(id, ctx.env)].filter((entry): entry is AppReceipt => !!entry)
    : listReceipts(ctx.env);
  if (id && receipts.length === 0) {
    throw new AppStoreError("APP_NOT_INSTALLED", `${id} is not installed from the store.`, 1, { id });
  }
  let cached: VerifiedSource | null = null;
  let sourceProblem: string | null = null;
  try {
    cached = loadCachedSource(ctx);
  } catch (error) {
    sourceProblem = error instanceof Error ? error.message : String(error);
  }
  return receipts.map((receipt) => {
    const problems = checkReceiptTree(receipt, ctx);
    if (receipt.state === "quarantined") problems.push(`quarantined: ${receipt.quarantine?.reason ?? ""}`);
    if (receipt.source === "official") {
      if (sourceProblem) problems.push(`the cached index cannot be verified: ${sourceProblem}`);
      const block = cached ? findBlock(cached.blocklist, receipt.id, receipt.version, receipt.treeHash) : null;
      if (block) problems.push(`blocked: ${block.reason || "no reason given"}`);
    }
    return {
      id: receipt.id,
      version: receipt.version,
      source: receipt.source,
      state: receipt.state,
      ok: problems.length === 0,
      problems,
      exposedTo: receipt.exposedTo,
    };
  });
}

export function checkReceiptTree(receipt: AppReceipt, ctx: StoreOperationContext = {}): string[] {
  const active = activeDirFor(receipt.id, ctx);
  if (!existsSync(active)) return [`the app folder ${active} is missing`];
  try {
    const hash = packageTreeHash(readPackageDir(active));
    return hash === receipt.treeHash ? [] : [`the files in ${active} changed since install`];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** Mark blocked official apps quarantined. Returns the ids that changed. */
export function quarantineBlocked(ctx: StoreOperationContext = {}): string[] {
  const cached = loadCachedSource(ctx);
  if (!cached) return [];
  const changed: string[] = [];
  for (const receipt of listReceipts(ctx.env)) {
    if (receipt.source !== "official" || receipt.state === "quarantined") continue;
    const block = findBlock(cached.blocklist, receipt.id, receipt.version, receipt.treeHash);
    if (!block) continue;
    writeReceipt(
      {
        ...receipt,
        state: "quarantined",
        quarantine: { reason: block.reason || "blocked by the index", at: now(ctx).toISOString() },
      },
      ctx.env,
    );
    changed.push(receipt.id);
  }
  return changed;
}

/** Search the cached (or freshly refreshed) index. */
export function searchIndex(
  verified: VerifiedSource,
  query: string | undefined,
  ctx: StoreOperationContext = {},
): Array<{
  id: string;
  name: string;
  description: string;
  publisher: string;
  latest: string | null;
  class: RaviAppClass | null;
  installed: string | null;
  blocked: boolean;
}> {
  const needle = query?.trim().toLowerCase() ?? "";
  return Object.entries(verified.index.apps)
    .filter(([id, entry]) => !needle || `${id} ${entry.name} ${entry.description}`.toLowerCase().includes(needle))
    .map(([id, entry]) => {
      const active = entry.versions
        .filter((version) => version.status === "active")
        .sort((left, right) => compareVersions(right.version, left.version));
      const latest = active[0] ?? null;
      const receipt = readReceipt(id, ctx.env);
      return {
        id,
        name: entry.name,
        description: entry.description,
        publisher: entry.publisher,
        latest: latest?.version ?? null,
        class: latest?.class ?? null,
        installed: receipt?.version ?? null,
        blocked: latest ? !!findBlock(verified.blocklist, id, latest.version, latest.treeHash) : false,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
