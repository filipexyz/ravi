import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { canonicalStatePath } from "../db/state-boundary.js";
import {
  recordedProcessExitState,
  type MaintenanceProcess,
  type ProcessCompletionEvidence,
} from "../runtime-maintenance.js";
import { resolveAccountHome } from "../utils/account-home.js";
import type { ThreadFenceBootstrapContext } from "./schema-fence.js";

type EvidenceReference = { path: string; sha256: string };
type DatabaseIdentity = { path: string; device: number; inode: number };
type BootstrapAudit = {
  reason: "exclusively-created-isolated-state" | "verified-predecessor-exits" | "empty-isolated-state";
  evidence?: EvidenceReference[];
  predecessors?: MaintenanceProcess[];
};
type Scope = { database: DatabaseIdentity; verify: () => BootstrapAudit };

// Lexical and synchronous: detached tasks never inherit a bootstrap grant.
let activeScope: Scope | undefined;

function blocked(detail: string): never {
  throw new Error(`THREAD_FENCE_BOOTSTRAP_BLOCKED: ${detail}`);
}

function synchronous<T>(value: T): T {
  if (value && typeof (value as { then?: unknown }).then === "function") {
    void Promise.resolve(value).catch(() => {
      // no-cause: Async authorization is rejected synchronously; consume only its later rejection.
    });
    blocked("bootstrap authorization must be synchronous");
  }
  return value;
}

function identity(path: string): DatabaseIdentity {
  const canonical = canonicalStatePath(path);
  const info = statSync(canonical);
  if (!info.isFile() || info.nlink !== 1) blocked("database identity is not exclusive");
  return { path: canonical, device: info.dev, inode: info.ino };
}

function withScope<T>(scope: Scope, callback: () => T): T {
  const previous = activeScope;
  activeScope = scope;
  try {
    return synchronous(callback());
  } finally {
    activeScope = previous;
  }
}

/** A durable authorization log, not a successful-migration or drain receipt. */
export function recordThreadBootstrapAuthorization(databasePath: string, audit: BootstrapAudit): void {
  const path = `${canonicalStatePath(databasePath)}.thread-bootstrap.jsonl`;
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) blocked("unsafe bootstrap audit file");
    writeFileSync(
      fd,
      `${JSON.stringify({ event: "thread-bootstrap-authorized", at: Date.now(), pid: process.pid, ...audit })}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Called under the schema lock immediately before the first fence installation. */
export function verifyScopedThreadBootstrap({ databasePath, openedDatabase }: ThreadFenceBootstrapContext): boolean {
  const scope = activeScope;
  if (!scope) return false;
  const current = identity(databasePath);
  if (
    !openedDatabase ||
    openedDatabase.path !== current.path ||
    openedDatabase.device !== current.device ||
    openedDatabase.inode !== current.inode
  )
    blocked("opened SQLite connection does not match the authorized database identity");
  if (
    current.path !== scope.database.path ||
    current.device !== scope.database.device ||
    current.inode !== scope.database.inode
  )
    blocked("authorization belongs to a different database identity");
  const audit = synchronous(scope.verify());
  // The external verifier cannot substitute the file while authorizing it.
  const verified = identity(databasePath);
  if (verified.device !== current.device || verified.inode !== current.inode || verified.path !== current.path)
    blocked("database identity changed during authorization");
  recordThreadBootstrapAuthorization(databasePath, audit);
  return true;
}

/**
 * Own a newly created private database for a synchronous isolated CLI/fixture.
 * No managed runtime/launcher is started or handed this state. The caller must
 * finish initialization here before publishing the path to another process.
 * This constructor, rather than a test/env/path label, establishes no predecessor.
 * Cleanup remains with the caller, including when its callback throws.
 */
export function withNewIsolatedThreadState<T>(parentDirectory: string, callback: (stateDirectory: string) => T): T {
  const home = resolveAccountHome();
  if (!home) blocked("OS account identity is unavailable");
  const parent = canonicalStatePath(parentDirectory);
  const real = canonicalStatePath(join(home, ".ravi"));
  const legacy = canonicalStatePath(join(home, "ravi"));
  if (parent === real || parent.startsWith(`${real}/`) || parent === legacy || parent.startsWith(`${legacy}/`))
    blocked("new isolated state cannot own a real-state directory");
  const stateDirectory = mkdtempSync(join(parent, "ravi-owned-thread-"));
  const path = join(stateDirectory, "ravi.db");
  const fd = openSync(path, "wx", 0o600);
  closeSync(fd);
  const database = identity(path);
  return withScope({ database, verify: () => ({ reason: "exclusively-created-isolated-state" }) }, () =>
    callback(stateDirectory),
  );
}

export type ExitedThreadBootstrapProof = {
  inventoryComplete: true;
  inventory: MaintenanceProcess[];
  admissionsClosed: true;
  launchersExcluded: true;
  exclusionEvidence: EvidenceReference;
  completion: ProcessCompletionEvidence[];
};

function sameProcess(a: MaintenanceProcess, b: MaintenanceProcess): boolean {
  return a.name === b.name && a.pid === b.pid && a.startedAt === b.startedAt && a.bundleSha256 === b.bundleSha256;
}

function checkEvidence(reference: EvidenceReference): EvidenceReference {
  if (!reference || typeof reference.path !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256))
    blocked("external evidence reference is missing");
  if (createHash("sha256").update(readFileSync(reference.path)).digest("hex") !== reference.sha256)
    blocked("external evidence changed");
  return { ...reference };
}

/**
 * Privileged integration for a separately reviewed external coordinator, NOT a
 * parser for user claims. The verifier must establish complete inventory,
 * accepted-work persistence/completion and exclusion of every legacy launcher,
 * and keep that exclusion held for the entire synchronous callback.
 * No environment flag, PM2 empty result, stopped record or digest grants access.
 * Real-state opening/entrypoint guards and the maintenance interlock stay intact.
 */
export function withExitedThreadBootstrapAuthorization<T>(
  input: {
    databasePath: string;
    predecessors: MaintenanceProcess[];
    verify: (
      database: Readonly<DatabaseIdentity>,
      predecessors: readonly Readonly<MaintenanceProcess>[],
    ) => ExitedThreadBootstrapProof;
  },
  callback: () => T,
): T {
  const database = Object.freeze(identity(input.databasePath));
  const predecessors = input.predecessors.map((entry) => Object.freeze({ ...entry }));
  const verify = input.verify;
  if (
    predecessors.length !== 2 ||
    new Set(predecessors.map((entry) => entry.name)).size !== 2 ||
    new Set(predecessors.map((entry) => entry.pid)).size !== 2 ||
    predecessors.some(
      (entry) =>
        !["ravi", "ravi-channels"].includes(entry.name) ||
        !Number.isSafeInteger(entry.pid) ||
        entry.pid <= 0 ||
        !Number.isFinite(entry.startedAt) ||
        entry.startedAt <= 0 ||
        !/^[a-f0-9]{64}$/.test(entry.bundleSha256),
    )
  )
    blocked("complete predecessor identities are required");
  Object.freeze(predecessors);
  return withScope(
    {
      database,
      verify: () => {
        if (predecessors.some((entry) => recordedProcessExitState(entry) !== "exited"))
          blocked("a legacy predecessor is present or its physical exit is unknown");
        if (typeof verify !== "function") blocked("external completion and exclusion verifier is required");
        const proof = synchronous(verify(database, predecessors));
        if (
          !proof ||
          proof.inventoryComplete !== true ||
          proof.admissionsClosed !== true ||
          proof.launchersExcluded !== true ||
          !Array.isArray(proof.inventory) ||
          !Array.isArray(proof.completion) ||
          proof.completion.length !== 2
        )
          blocked("external persistence/completion or exclusion is unproven");
        if (proof.inventory.some((entry) => !predecessors.some((before) => sameProcess(entry, before))))
          blocked("replacement or unaccounted process observed");
        const evidence = [checkEvidence(proof.exclusionEvidence)];
        for (const predecessor of predecessors) {
          const completion = proof.completion.find((entry) => sameProcess(entry.process, predecessor));
          if (!completion || completion.admissionsClosed !== true || completion.launcherDisabled !== true)
            blocked("predecessor persistence/completion is unproven");
          evidence.push(checkEvidence({ path: completion.evidencePath, sha256: completion.evidenceSha256 }));
        }
        if (predecessors.some((entry) => recordedProcessExitState(entry) !== "exited"))
          blocked("legacy predecessor exit changed during verification");
        return {
          reason: "verified-predecessor-exits",
          predecessors: predecessors.map((entry) => ({ ...entry })),
          evidence,
        };
      },
    },
    callback,
  );
}
