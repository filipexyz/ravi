import { randomUUID } from "node:crypto";
import { lstat, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { reportErrorDiagnostic } from "../utils/error-reporting.js";
import { logger } from "../utils/logger.js";
import type { ResponseMediaAttachment } from "./message-types.js";

const log = logger.child("runtime:generated-media-allocation");

declare const allocationBrand: unique symbol;

/** In-process capability; copying or serializing its fields cannot transfer ownership. */
export interface GeneratedMediaAllocation {
  readonly [allocationBrand]: true;
}

export interface AllocatedGeneratedMedia {
  attachment: ResponseMediaAttachment;
  allocation: GeneratedMediaAllocation;
}

export type GeneratedMediaCleanupResult =
  | { status: "released" | "already_missing"; filePath: string }
  | {
      status: "rejected";
      filePath: string;
      reason: "identity_unavailable" | "not_regular_file" | "identity_changed";
    }
  | { status: "failed"; filePath: string; reason: "stat_failed" | "unlink_failed"; error: unknown };

export type GeneratedMediaCleanupRunner = () => Promise<GeneratedMediaCleanupResult>;

export interface GeneratedMediaFileStat {
  dev: number | bigint;
  ino: number | bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface GeneratedMediaFileHandle {
  stat(): Promise<GeneratedMediaFileStat>;
  writeFile(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}

/** Supply the entire filesystem so a virtual test cannot fall back to a physical removal. */
export interface GeneratedMediaFileSystem {
  open(filePath: string, flags: "wx", mode: number): Promise<GeneratedMediaFileHandle>;
  lstat(filePath: string): Promise<GeneratedMediaFileStat>;
  unlink(filePath: string): Promise<void>;
}

export interface GeneratedMediaAllocatorDependencies {
  fs?: GeneratedMediaFileSystem;
  tmpdir?: () => string;
  randomUUID?: () => string;
}

/** Allocation failure retains the original error even when closing or disposal also fails. */
export class GeneratedMediaAllocationError extends Error {
  constructor(
    cause: unknown,
    readonly cleanup: GeneratedMediaCleanupResult,
    readonly closeError?: unknown,
  ) {
    super("Failed to allocate generated media", { cause });
    this.name = "GeneratedMediaAllocationError";
  }
}

interface FileIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

interface AllocationRecord {
  attachment: ResponseMediaAttachment;
  identity: FileIdentity;
  state: "fresh" | "pending" | "retained" | "discarded";
  owner?: object;
}

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isMissing(error: unknown): boolean {
  return isObject(error) && "code" in error && error.code === "ENOENT";
}

/** Keep the raw cause internal while recording only the normalized diagnostic. */
function cleanupFailure(
  error: unknown,
  filePath: string,
  reason: "stat_failed" | "unlink_failed",
): Extract<GeneratedMediaCleanupResult, { status: "failed" }> {
  reportErrorDiagnostic(log, "Could not release a generated-media allocation", error, {
    operation: `generated_media_cleanup_${reason}`,
  });
  return { status: "failed", filePath, reason, error };
}

/**
 * Each materialization owns a new exclusive path, independently of its semantic
 * idempotency key or display filename. Only this factory's WeakMap authenticates
 * tokens; paths, source markers and serialized attachment metadata grant no authority.
 */
export function createGeneratedMediaAllocator(deps: GeneratedMediaAllocatorDependencies = {}) {
  const fs: GeneratedMediaFileSystem = deps.fs ?? { open, lstat, unlink };
  const temporaryDirectory = deps.tmpdir ?? tmpdir;
  const newUUID = deps.randomUUID ?? randomUUID;
  const allocations = new WeakMap<GeneratedMediaAllocation, AllocationRecord>();

  async function release(filePath: string, identity: FileIdentity): Promise<GeneratedMediaCleanupResult> {
    let current: GeneratedMediaFileStat;
    try {
      current = await fs.lstat(filePath);
    } catch (error) {
      if (isMissing(error)) return { status: "already_missing", filePath };
      return cleanupFailure(error, filePath, "stat_failed");
    }
    if (current.isSymbolicLink() || !current.isFile()) {
      return { status: "rejected", filePath, reason: "not_regular_file" };
    }
    if (current.dev !== identity.dev || current.ino !== identity.ino) {
      return { status: "rejected", filePath, reason: "identity_changed" };
    }
    // lstat + unlink is not an atomic conditional unlink. This rejects observed
    // replacements, but cannot defeat adversarial replacement between these calls.
    try {
      await fs.unlink(filePath);
      return { status: "released", filePath };
    } catch (error) {
      if (isMissing(error)) return { status: "already_missing", filePath };
      return cleanupFailure(error, filePath, "unlink_failed");
    }
  }

  function claim(record: AllocationRecord): GeneratedMediaCleanupRunner {
    record.state = "discarded";
    record.owner = undefined;
    let result: Promise<GeneratedMediaCleanupResult> | undefined;
    // Do not make this wrapper async: every call must return the same promise,
    // including failures, with no second stat/unlink attempt or implicit retry.
    return () => (result ??= release(record.attachment.filePath, record.identity));
  }

  return {
    async allocate(input: {
      bytes: Buffer;
      attachment: Omit<ResponseMediaAttachment, "filePath">;
    }): Promise<AllocatedGeneratedMedia> {
      const id = newUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error("Generated media allocation requires a UUID");
      }
      const suffix = extname(input.attachment.filename);
      const extension = /^\.[a-z0-9]{1,10}$/i.test(suffix) ? suffix.toLowerCase() : "";
      const filePath = join(temporaryDirectory(), `ravi-generated-media-${id}${extension}`);
      const attachment: ResponseMediaAttachment = Object.freeze({ ...input.attachment, filePath });
      // An EEXIST refusal has created nothing: never attempt cleanup of that path.
      const handle = await fs.open(filePath, "wx", 0o600);
      let identity: FileIdentity | undefined;
      let failed = false;
      let failure: unknown;
      let closeError: unknown;
      try {
        const stat = await handle.stat();
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error("Generated media allocation is not a regular file");
        }
        identity = { dev: stat.dev, ino: stat.ino };
        await handle.writeFile(input.bytes);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
        if (!failed) failure = error;
        failed = true;
      }
      if (failed || !identity) {
        const cleanup: GeneratedMediaCleanupResult = identity
          ? await release(filePath, identity)
          : { status: "rejected", filePath, reason: "identity_unavailable" };
        throw new GeneratedMediaAllocationError(failure, cleanup, closeError);
      }
      const allocation = Object.freeze(Object.create(null)) as GeneratedMediaAllocation;
      allocations.set(allocation, { attachment, identity, state: "fresh" });
      return { attachment, allocation };
    },

    adopt(allocated: AllocatedGeneratedMedia, owner: object): void {
      const record = allocations.get(allocated?.allocation);
      if (!record || allocated.attachment !== record.attachment || !isObject(owner)) {
        throw new Error("Generated media adoption requires an authentic allocation and its exact attachment");
      }
      if (record.state === "fresh") {
        record.state = "pending";
        record.owner = owner;
        return;
      }
      if (record.owner === owner && (record.state === "pending" || record.state === "retained")) return;
      throw new Error("Generated media allocation is already owned or discarded");
    },

    /** Pins final or other-transport output; deferred-discard cleanup cannot release it later. */
    retain(allocation: GeneratedMediaAllocation, owner: object): void {
      const record = allocations.get(allocation);
      if (
        !record ||
        !isObject(owner) ||
        record.owner !== owner ||
        (record.state !== "pending" && record.state !== "retained")
      ) {
        throw new Error("Generated media retention requires its current owner");
      }
      record.state = "retained";
    },

    /** Claims ownership synchronously after terminal acceptance; performs no filesystem I/O. */
    prepareDiscard(allocation: GeneratedMediaAllocation, owner: object): GeneratedMediaCleanupRunner | undefined {
      const record = allocations.get(allocation);
      if (!record || record.state !== "pending" || record.owner !== owner) return undefined;
      return claim(record);
    },

    /** Only a fresh rejected/deduplicated materialization may use this disposal path. */
    prepareUnadoptedDiscard(allocation: GeneratedMediaAllocation): GeneratedMediaCleanupRunner | undefined {
      const record = allocations.get(allocation);
      if (!record || record.state !== "fresh") return undefined;
      return claim(record);
    },
  };
}

export const generatedMediaAllocations = createGeneratedMediaAllocator();
