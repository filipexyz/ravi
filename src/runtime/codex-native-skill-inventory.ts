import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export type CodexNativeSkillInventory = Readonly<{
  revision: string;
  disabledSkills: readonly Readonly<{ path: string; enabled: false }>[];
}>;

export type CodexNativeDiscoveryOptions = Readonly<{
  projectRootMarkers?: readonly string[];
  projectCodexSkillRoots?: readonly string[];
  systemSkillRoots?: readonly string[];
  pluginSkillRoots?: readonly string[];
}>;

export function readCodexNativeDiscoveryOptions(configResponse: unknown): CodexNativeDiscoveryOptions {
  try {
    const parsed = configLayersSchema.safeParse(configResponse);
    if (!parsed.success) throw new CodexNativeSkillInventoryError("invalid-input");
    const projectRoots: string[] = [];
    const systemRoots: string[] = [];
    for (const layer of parsed.data.layers) {
      if (layer.name.type === "project") {
        projectRoots.push(join(normalizeAbsolutePath(layer.name.dotCodexFolder), "skills"));
      } else if (layer.name.type === "system") {
        systemRoots.push(join(dirname(normalizeAbsolutePath(layer.name.file)), "skills"));
      }
    }
    if (systemRoots.length === 0) throw new CodexNativeSkillInventoryError("invalid-input");
    return Object.freeze({
      projectRootMarkers: Object.freeze(parsed.data.config.project_root_markers ?? [".git"]),
      projectCodexSkillRoots: Object.freeze(projectRoots),
      systemSkillRoots: Object.freeze(systemRoots),
      pluginSkillRoots: Object.freeze([]),
    });
  } catch (error) {
    if (error instanceof CodexNativeSkillInventoryError) throw error;
    throw new CodexNativeSkillInventoryError("invalid-input");
  }
}

const skillSchema = z.object({
  path: z.string().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  description: z.string().optional(),
  scope: z.string().optional(),
});

const inventorySchema = z.object({
  data: z
    .array(
      z.object({
        cwd: z.string().min(1),
        skills: z.array(skillSchema),
        errors: z.array(z.unknown()).length(0),
      }),
    )
    .length(1),
});

const discoveryOptionsSchema = z.object({
  projectRootMarkers: z.array(z.string().min(1)).optional(),
  projectCodexSkillRoots: z.array(z.string().min(1)).optional(),
  systemSkillRoots: z.array(z.string().min(1)).optional(),
  pluginSkillRoots: z.array(z.string().min(1)).optional(),
});

const configLayersSchema = z.object({
  config: z.object({ project_root_markers: z.array(z.string()).nullable().optional() }),
  layers: z
    .array(
      z.object({
        name: z.union([
          z.object({ type: z.literal("project"), dotCodexFolder: z.string().min(1) }),
          z.object({ type: z.literal("system"), file: z.string().min(1) }),
          z.object({
            type: z.enum([
              "packagedDefaults",
              "mdm",
              "enterpriseManaged",
              "user",
              "sessionFlags",
              "legacyManagedConfigTomlFromFile",
              "legacyManagedConfigTomlFromMdm",
            ]),
          }),
        ]),
        version: z.string(),
      }),
    )
    .min(1),
});

const INVALID_INVENTORY = "Codex native skill inventory is invalid";
const RESERVED_ROOTS = new Set([".codex", ".agents", "skills"]);

type NativeInventoryFailureCode =
  | "invalid-input"
  | "unsafe-path"
  | "unsafe-root"
  | "symbolic-link"
  | "sensitive-entry"
  | "unsupported-entry"
  | "invalid-size"
  | "linked-file"
  | "traversal-limit"
  | "filesystem-changed"
  | "filesystem-unavailable";

export class CodexNativeSkillInventoryError extends Error {
  readonly code: NativeInventoryFailureCode;

  constructor(code: NativeInventoryFailureCode) {
    super(INVALID_INVENTORY);
    this.name = "CodexNativeSkillInventoryError";
    this.code = code;
  }
}

export function captureCodexNativeDiscoveryRevision(
  value: unknown,
  cwd: string,
  codexHome: string,
  userHome: string,
  options: CodexNativeDiscoveryOptions = {},
): string {
  try {
    const inventory = parseNativeInventory(value, cwd);
    const parsedOptions = discoveryOptionsSchema.safeParse(options);
    if (!parsedOptions.success) throw new CodexNativeSkillInventoryError("invalid-input");
    const markers = parsedOptions.data.projectRootMarkers ?? [".git"];
    if (
      markers.some(
        (marker) =>
          marker.includes("\0") ||
          isAbsolute(marker) ||
          marker.split(/[/\\]/).some((part) => part === ".." || part === "." || part.length === 0),
      )
    ) {
      throw new CodexNativeSkillInventoryError("unsafe-path");
    }
    const normalizedCodexHome = normalizeAbsolutePath(codexHome);
    const normalizedUserHome = normalizeAbsolutePath(userHome);
    const forbiddenRoots = new Set([pathIdentity(normalizedCodexHome), pathIdentity(normalizedUserHome)]);
    const roots = new Map<string, string>();
    const addRoot = (path: string) => {
      const normalized = normalizeAbsolutePath(path);
      if (
        dirname(normalized) === normalized ||
        forbiddenRoots.has(pathIdentity(normalized)) ||
        isSensitiveEntry(basename(normalized))
      ) {
        throw new CodexNativeSkillInventoryError("unsafe-root");
      }
      roots.set(pathIdentity(normalized), normalized);
    };

    // rust-v0.154.0 ext/skills/src/host_roots.rs:127-252 limits .agents roots to the project.
    for (const projectDirectory of projectSkillDirectories(inventory.cwd, markers)) {
      addRoot(join(projectDirectory, ".agents", "skills"));
    }
    // host_roots.rs:74 uses ALL project layers; config/src/state.rs:501 includes disabled layers.
    for (const projectRoot of parsedOptions.data.projectCodexSkillRoots ?? []) addRoot(projectRoot);
    addRoot(join(normalizedCodexHome, "skills"));
    // codex-rs/skills/src/lib.rs:58-63 registers the hidden builtin cache as its own root.
    addRoot(join(normalizedCodexHome, "skills", ".system"));
    addRoot(join(normalizedUserHome, ".agents", "skills"));
    // Windows system roots come from config/read.layers, not an environment-variable guess.
    const systemRoots =
      parsedOptions.data.systemSkillRoots ?? (process.platform === "win32" ? [] : ["/etc/codex/skills"]);
    for (const systemRoot of systemRoots) addRoot(systemRoot);
    for (const pluginRoot of parsedOptions.data.pluginSkillRoots ?? []) addRoot(pluginRoot);
    for (const skill of inventory.skills) addRoot(findNativeDiscoveryRoot(skill.path));

    const hash = createHash("sha256");
    hash.update(JSON.stringify({ version: 2, cwd: pathIdentity(inventory.cwd) }));
    for (const root of [...roots.values()].sort(comparePaths)) {
      assertNoSymbolicExistingAncestors(root);
      hash.update(JSON.stringify(["root", pathIdentity(root)]));
      hashDiscoveryMetadata(root, hash, {
        forbiddenRoots,
        activeDirectories: new Set(),
        entries: 0,
        directories: 0,
        // host.rs:148-149 follows directory links for User/Repo/Admin, but not System.
        followDirectoryLinks: pathIdentity(root) !== pathIdentity(join(normalizedCodexHome, "skills", ".system")),
      });
    }
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof CodexNativeSkillInventoryError) throw error;
    throw new CodexNativeSkillInventoryError("filesystem-unavailable");
  }
}

function projectSkillDirectories(cwd: string, markers: readonly string[]): string[] {
  if (markers.length === 0) return [cwd];
  let projectRoot = cwd;
  let ancestor = cwd;
  while (true) {
    let foundMarker = false;
    for (const markerName of markers) {
      const marker = join(ancestor, markerName);
      assertNoSymbolicExistingAncestors(marker);
      const stat = lstatSync(marker, { throwIfNoEntry: false });
      if (!stat) continue;
      projectRoot = ancestor;
      foundMarker = true;
      break;
    }
    if (foundMarker) break;
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const directories: string[] = [];
  let current = cwd;
  while (true) {
    directories.push(current);
    if (current === projectRoot) return directories;
    current = dirname(current);
  }
}

export function captureCodexNativeSkillInventory(
  value: unknown,
  cwd: string,
  extraSkillPaths: readonly string[] = [],
): CodexNativeSkillInventory {
  try {
    const { cwd: expectedCwd, skills: nativeSkills } = parseNativeInventory(value, cwd);

    const paths = new Map(nativeSkills.map((skill) => [pathIdentity(skill.path), skill.path]));
    for (const extraPath of extraSkillPaths) {
      const path = normalizeSkillPath(extraPath, expectedCwd);
      paths.set(pathIdentity(path), path);
    }

    const hash = createHash("sha256");
    hash.update(JSON.stringify({ version: 1, cwd: pathIdentity(expectedCwd), nativeSkills }));
    for (const path of [...paths.values()].sort(comparePaths)) {
      assertNoSymbolicAncestors(path);
      if (!lstatSync(path).isFile()) throw new CodexNativeSkillInventoryError("unsupported-entry");
      hash.update(JSON.stringify(["skill", pathIdentity(path)]));
      hashDirectory(dirname(path), hash);
    }

    return Object.freeze({
      revision: hash.digest("hex"),
      disabledSkills: Object.freeze(nativeSkills.map((skill) => Object.freeze({ path: skill.path, enabled: false }))),
    });
  } catch (error) {
    // Filesystem and schema errors can contain private paths or skill contents.
    if (error instanceof CodexNativeSkillInventoryError) throw error;
    throw new CodexNativeSkillInventoryError("filesystem-unavailable");
  }
}

function parseNativeInventory(value: unknown, cwd: string) {
  const result = inventorySchema.safeParse(value);
  const expectedCwd = normalizeAbsolutePath(cwd);
  if (!result.success) throw new CodexNativeSkillInventoryError("invalid-input");
  const row = result.data.data[0];
  if (!row || pathIdentity(normalizeAbsolutePath(row.cwd)) !== pathIdentity(expectedCwd)) {
    throw new CodexNativeSkillInventoryError("invalid-input");
  }
  assertNoSymbolicAncestors(expectedCwd);
  const seenPaths = new Set<string>();
  const skills = row.skills
    .map((skill) => {
      const path = normalizeSkillPath(skill.path, expectedCwd);
      const identity = pathIdentity(path);
      if (seenPaths.has(identity)) throw new CodexNativeSkillInventoryError("invalid-input");
      seenPaths.add(identity);
      return { ...skill, path };
    })
    .sort((left, right) => comparePaths(left.path, right.path));
  return { cwd: expectedCwd, skills };
}

function findNativeDiscoveryRoot(path: string): string {
  const fallback = dirname(dirname(path));
  let ancestor = fallback;
  while (true) {
    if (basename(ancestor).toLowerCase() === "skills") return ancestor;
    const parent = dirname(ancestor);
    if (parent === ancestor) return fallback;
    ancestor = parent;
  }
}

function assertNoSymbolicExistingAncestors(path: string): void {
  let current = path;
  while (true) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new CodexNativeSkillInventoryError("symbolic-link");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

type DiscoveryTraversal = {
  readonly forbiddenRoots: ReadonlySet<string>;
  readonly activeDirectories: Set<string>;
  readonly followDirectoryLinks: boolean;
  entries: number;
  directories: number;
};

function hashDiscoveryMetadata(
  path: string,
  hash: ReturnType<typeof createHash>,
  traversal: DiscoveryTraversal,
  depth = 0,
): void {
  // Independent guard bounds: stop rather than silently accept a partial inventory.
  if (depth > 64) throw new CodexNativeSkillInventoryError("traversal-limit");
  const isRoot = depth === 0;
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!before) {
    if (!isRoot) throw new CodexNativeSkillInventoryError("filesystem-changed");
    hash.update(JSON.stringify(["absent"]));
    return;
  }
  if (before.isSymbolicLink()) {
    if (isRoot || !traversal.followDirectoryLinks) throw new CodexNativeSkillInventoryError("symbolic-link");
    hashDiscoveryLink(path, before, hash, traversal, depth);
    return;
  }
  if ((!before.isFile() && !before.isDirectory()) || (isRoot && !before.isDirectory())) {
    throw new CodexNativeSkillInventoryError("unsupported-entry");
  }
  if (before.size < 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CodexNativeSkillInventoryError("invalid-size");
  }
  if (before.isFile() && before.nlink !== 1n) throw new CodexNativeSkillInventoryError("linked-file");
  if (before.isDirectory()) {
    const identity = pathIdentity(path);
    if (traversal.activeDirectories.has(identity)) throw new CodexNativeSkillInventoryError("symbolic-link");
    traversal.directories += 1;
    if (traversal.directories > 2_000) throw new CodexNativeSkillInventoryError("traversal-limit");
    traversal.activeDirectories.add(identity);
    // Hidden additions change directory timestamps, but not the native visible inventory.
    hash.update(JSON.stringify(["directory", before.ino.toString(), before.dev.toString()]));
    const names = readdirSync(path).sort();
    traversal.entries += names.length;
    if (traversal.entries > 20_000) throw new CodexNativeSkillInventoryError("traversal-limit");
    for (const name of names) {
      const entryPath = join(path, name);
      const entryStat = lstatSync(entryPath);
      // rust-v0.154.0 ext/skills/src/loader/host.rs:159-163 sets HiddenDirectoryPolicy::Skip.
      if (name.startsWith(".") && (entryStat.isDirectory() || entryStat.isSymbolicLink())) continue;
      if (isSensitiveEntry(name)) throw new CodexNativeSkillInventoryError("sensitive-entry");
      hash.update(JSON.stringify(["entry", name]));
      hashDiscoveryMetadata(entryPath, hash, traversal, depth + 1);
    }
    hash.update(JSON.stringify(["end-directory"]));
    traversal.activeDirectories.delete(identity);
  } else {
    hash.update(
      JSON.stringify([
        "file",
        before.size.toString(),
        before.mtimeNs.toString(),
        before.ctimeNs.toString(),
        before.ino.toString(),
        before.dev.toString(),
      ]),
    );
  }
  const after = lstatSync(path, { bigint: true });
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.isSymbolicLink()
  ) {
    throw new CodexNativeSkillInventoryError("filesystem-changed");
  }
}

function hashDiscoveryLink(
  path: string,
  before: BigIntStats,
  hash: ReturnType<typeof createHash>,
  traversal: DiscoveryTraversal,
  depth: number,
): void {
  const target = readlinkSync(path);
  const canonicalTarget = normalizeAbsolutePath(realpathSync(path));
  if (
    dirname(canonicalTarget) === canonicalTarget ||
    traversal.forbiddenRoots.has(pathIdentity(canonicalTarget)) ||
    isSensitiveEntry(basename(canonicalTarget))
  ) {
    throw new CodexNativeSkillInventoryError("unsafe-root");
  }
  // Only directory links are followed by native skill discovery. No file contents are read.
  if (!lstatSync(canonicalTarget).isDirectory()) throw new CodexNativeSkillInventoryError("symbolic-link");
  hash.update(
    JSON.stringify([
      "directory-link",
      before.ino.toString(),
      before.dev.toString(),
      before.size.toString(),
      before.mtimeNs.toString(),
      before.ctimeNs.toString(),
      target,
      pathIdentity(canonicalTarget),
    ]),
  );
  hashDiscoveryMetadata(canonicalTarget, hash, traversal, depth + 1);
  const after = lstatSync(path, { bigint: true });
  if (
    !after.isSymbolicLink() ||
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    readlinkSync(path) !== target ||
    pathIdentity(normalizeAbsolutePath(realpathSync(path))) !== pathIdentity(canonicalTarget)
  ) {
    throw new CodexNativeSkillInventoryError("filesystem-changed");
  }
}

function normalizeAbsolutePath(path: string): string {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path)) {
    throw new CodexNativeSkillInventoryError("unsafe-path");
  }
  if (process.platform === "win32" && !/^[a-z]:[/\\]/i.test(path)) {
    throw new CodexNativeSkillInventoryError("unsafe-path");
  }
  return resolve(path);
}

function normalizeSkillPath(path: string, cwd: string): string {
  const normalized = normalizeAbsolutePath(path);
  const root = dirname(normalized);
  if (
    basename(normalized) !== "SKILL.md" ||
    root === dirname(root) ||
    pathIdentity(root) === pathIdentity(cwd) ||
    RESERVED_ROOTS.has(basename(root).toLowerCase())
  )
    throw new CodexNativeSkillInventoryError("unsafe-path");
  return normalized;
}

function pathIdentity(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function comparePaths(left: string, right: string): number {
  const leftIdentity = pathIdentity(left);
  const rightIdentity = pathIdentity(right);
  return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

function assertNoSymbolicAncestors(path: string): void {
  let current = path;
  while (true) {
    if (lstatSync(current).isSymbolicLink()) throw new CodexNativeSkillInventoryError("symbolic-link");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isSensitiveEntry(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "auth.json" ||
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized === ".codex" ||
    normalized === ".agents"
  );
}

function hashDirectory(path: string, hash: ReturnType<typeof createHash>): void {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink()) throw new CodexNativeSkillInventoryError("symbolic-link");
  if (!before.isDirectory()) throw new CodexNativeSkillInventoryError("unsupported-entry");
  const names = readdirSync(path).sort();
  if (names.some(isSensitiveEntry)) throw new CodexNativeSkillInventoryError("sensitive-entry");
  for (const name of names) {
    const entryPath = join(path, name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new CodexNativeSkillInventoryError("symbolic-link");
    if (stat.isDirectory()) {
      hash.update(JSON.stringify(["directory", name]));
      hashDirectory(entryPath, hash);
      hash.update(JSON.stringify(["end-directory"]));
    } else if (stat.isFile()) {
      hash.update(JSON.stringify(["file", name]));
      hashFile(entryPath, hash);
    } else {
      throw new CodexNativeSkillInventoryError("unsupported-entry");
    }
  }
  const after = lstatSync(path, { bigint: true });
  if (
    before.ino !== after.ino ||
    before.dev !== after.dev ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    after.isSymbolicLink()
  )
    throw new CodexNativeSkillInventoryError("filesystem-changed");
}

function hashFile(path: string, hash: ReturnType<typeof createHash>): void {
  assertNoSymbolicAncestors(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile()) throw new CodexNativeSkillInventoryError("unsupported-entry");
  if (before.nlink !== 1n) throw new CodexNativeSkillInventoryError("linked-file");
  // File descriptors provide no-follow and identity checks unavailable through Bun.file(path).
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1n) {
      throw new CodexNativeSkillInventoryError("filesystem-changed");
    }
    const contentHash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      contentHash.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      after.nlink !== 1n
    )
      throw new CodexNativeSkillInventoryError("filesystem-changed");
    assertNoSymbolicAncestors(path);
    hash.update(JSON.stringify(["content", contentHash.digest("hex")]));
  } finally {
    closeSync(descriptor);
  }
}
