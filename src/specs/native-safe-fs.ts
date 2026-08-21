import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeSpecsEntry {
  relativePath: string;
  kind: "directory" | "file";
  identity: string;
  mtimeMs: number;
  size: number;
  content?: string;
}

export interface NativeSpecsSnapshot {
  workspaceIdentity: string;
  rootBinding: string;
  rootExists: boolean;
  entries: NativeSpecsEntry[];
}

export interface NativeSpecCreationRequest {
  workspacePath: string;
  expectedWorkspaceIdentity: string;
  expectedRootBinding: string;
  targetSegments: string[];
  files: Array<{ name: string; content: string }>;
  requireAncestors: boolean;
  existing: "error" | "noop";
  existingDirectory: "error" | "populate";
  stagingName: string;
  stagingPath: string;
  beforePromote?: (stagingPath: string) => boolean;
}

export interface NativeSpecCreationResult {
  status: "created" | "noop";
  targetIdentity: string;
  entries: NativeSpecsEntry[];
}

interface NativeSpecsAddon {
  implementation: "node-api-handles-v1";
  snapshot(workspacePath: string, onEntry?: (relativePath: string) => void): NativeSpecsSnapshot;
  createSpec(request: NativeSpecCreationRequest): NativeSpecCreationResult;
}

export class NativeSpecsSafetyError extends Error {
  readonly code: string;
  readonly unsafePath: string;

  constructor(code: string, unsafePath: string, message: string) {
    super(message);
    this.name = "NativeSpecsSafetyError";
    this.code = code;
    this.unsafePath = unsafePath;
  }
}

const require = createRequire(import.meta.url);
let loadedAddon: NativeSpecsAddon | undefined;

function addonPath(): string {
  if ((process.platform !== "win32" && process.platform !== "linux") || process.arch !== "x64") {
    throw new NativeSpecsSafetyError(
      "UNSUPPORTED_NATIVE_PLATFORM",
      `${process.platform}-${process.arch}`,
      `Safe specs access is unavailable on ${process.platform}-${process.arch}.`,
    );
  }
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../native/prebuilds",
    `${process.platform}-${process.arch}`,
    "ravi_specs_safe_fs.node",
  );
}

function nativeAddon(): NativeSpecsAddon {
  if (loadedAddon) return loadedAddon;
  const path = addonPath();
  if (!existsSync(path)) {
    throw new NativeSpecsSafetyError(
      "NATIVE_SAFE_FS_UNAVAILABLE",
      path,
      `Safe specs native layer is missing: ${path}. Run bun run build:native.`,
    );
  }
  try {
    const candidate = require(path) as Partial<NativeSpecsAddon>;
    if (
      candidate.implementation !== "node-api-handles-v1" ||
      typeof candidate.snapshot !== "function" ||
      typeof candidate.createSpec !== "function"
    ) {
      throw new Error("Native module contract mismatch.");
    }
    loadedAddon = candidate as NativeSpecsAddon;
    return loadedAddon;
  } catch (error) {
    if (error instanceof NativeSpecsSafetyError) throw error;
    throw new NativeSpecsSafetyError(
      "NATIVE_SAFE_FS_UNAVAILABLE",
      path,
      `Safe specs native layer could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function callNative<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof NativeSpecsSafetyError) throw error;
    const native = error as Error & { code?: string; path?: string };
    throw new NativeSpecsSafetyError(
      native.code ?? "NATIVE_SAFE_FS_FAILED",
      native.path ?? "",
      native.message || "Safe specs native operation failed.",
    );
  }
}

export function captureNativeSpecsTree(
  workspacePath: string,
  onEntry?: (relativePath: string) => void,
): NativeSpecsSnapshot {
  return callNative(() => nativeAddon().snapshot(workspacePath, onEntry));
}

export function createNativeSpec(request: NativeSpecCreationRequest): NativeSpecCreationResult {
  return callNative(() => nativeAddon().createSpec(request));
}

export function nativeSpecsImplementation(): string {
  return nativeAddon().implementation;
}
