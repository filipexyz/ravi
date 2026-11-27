/**
 * Executable identity for the Bash permission guard.
 *
 * A grant names an executable (`execute:executable:git`). The guard must check
 * the binary the shell will run, not the last path segment the agent typed:
 * `cp /bin/sh /tmp/p/git && /tmp/p/git -c id` is a shell named `git`.
 *
 * - A bare name runs what the host PATH resolves; its real path must not be a
 *   shell or interpreter wearing another name.
 * - A path-qualified word runs that file; its real path (symlinks resolved)
 *   must live under a trusted root and must not be a disguised interpreter.
 */

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { UNCONDITIONAL_BLOCKS } from "./parser.js";

/** Shell builtins: the shell never searches PATH for these. */
export const SHELL_BUILTINS = new Set([
  ":",
  "[",
  "alias",
  "break",
  "builtin",
  "cd",
  "command",
  "continue",
  "declare",
  "dirs",
  "echo",
  "exit",
  "export",
  "false",
  "getopts",
  "hash",
  "jobs",
  "kill",
  "let",
  "local",
  "mapfile",
  "popd",
  "printf",
  "pushd",
  "pwd",
  "read",
  "readarray",
  "readonly",
  "return",
  "set",
  "shift",
  "test",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "wait",
]);

const EXTRA_SHELLS = new Set(["rbash", "ash", "busybox", "mksh", "pdksh", "yash", "posh", "elvish", "nu", "xonsh"]);

const INTERPRETER_NAME =
  /^(?:python[\d.]*|pypy[\d.]*|node(?:js)?|bun|bunx|bun\.exe|deno|perl[\d.]*|ruby[\d.]*|irb|php[\d.]*|lua(?:jit)?[\d.]*|tclsh[\d.]*|wish[\d.]*|expect|osascript|[gmn]?awk|Rscript|julia|pwsh|powershell|npx|npm|pnpm|yarn)$/;

/** A shell, string evaluator or source builtin. */
export function isShellName(name: string): boolean {
  return UNCONDITIONAL_BLOCKS.has(name) || EXTRA_SHELLS.has(name);
}

/** A program that runs code it is given (file, stdin or argument). */
export function isInterpreterName(name: string): boolean {
  return INTERPRETER_NAME.test(name);
}

const DEFAULT_TRUSTED_ROOTS = [
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/libexec",
  // uutils coreutils (Ubuntu 25.10+): /usr/bin/ls, env, sort... are symlinks to
  // hardlinks of one multicall binary in this root-owned package directory. Only
  // this directory is trusted, not /usr/lib/cargo/bin (sudo-rs, su) nor
  // /usr/lib/cargo, so other packaged Rust binaries stay outside the roots.
  "/usr/lib/cargo/bin/coreutils",
  "/usr/local",
  "/opt/homebrew",
  "/opt/local",
  "/nix/store",
  "/run/current-system",
  "/snap",
  "/System",
  "/Library/Apple",
  "/Library/Developer/CommandLineTools",
  "/Applications/Xcode.app/Contents/Developer",
];

export interface ExecutablePathOptions {
  /** Working directory the shell starts in. Without it, relative executables cannot be resolved. */
  cwd?: string;
  /** PATH the shell searches. Defaults to the host process PATH. */
  pathEnv?: string;
  /** Replaces the default trusted roots (tests). Absolute PATH entries are always added. */
  trustedRoots?: string[];
  /** A `cd`/`pushd`/`popd` earlier in the command makes relative executables unresolvable. */
  changesDirectory?: boolean;
}

export type ExecutablePathCheck =
  | { ok: true; realPath?: string }
  | { ok: false; rule: "untrusted_executable_path" | "indirect_execution"; reason: string };

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    // no-cause: a path that cannot be resolved is untrusted; every caller refuses or skips it
    return null;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    // no-cause: a missing or unreadable file is not an executable candidate, as the shell sees it
    return false;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** The roots trusted by default, before RAVI_BASH_TRUSTED_EXECUTABLE_ROOTS and PATH entries. */
export function defaultTrustedExecutableRoots(): readonly string[] {
  return DEFAULT_TRUSTED_ROOTS;
}

/** True when `realPath` is a root itself or a path below one of `roots` (segment boundary, not a prefix). */
export function isWithinTrustedRoots(realPath: string, roots: readonly string[]): boolean {
  return roots.some((root) => within(realPath, root) || within(dirname(realPath), root));
}

export function trustedExecutableRoots(options: ExecutablePathOptions = {}): string[] {
  const roots = new Set<string>();
  const extra = (process.env.RAVI_BASH_TRUSTED_EXECUTABLE_ROOTS ?? "").split(delimiter);
  const pathEntries = (options.pathEnv ?? process.env.PATH ?? "").split(delimiter);
  for (const candidate of [...(options.trustedRoots ?? DEFAULT_TRUSTED_ROOTS), ...extra, ...pathEntries]) {
    if (!candidate || !isAbsolute(candidate)) continue;
    roots.add(resolve(candidate));
    const real = safeRealpath(candidate);
    if (real) roots.add(real);
  }
  return [...roots];
}

/** A binary that is really a shell/interpreter but is invoked under another name. */
function disguise(name: string, realPath: string): ExecutablePathCheck | null {
  const realName = basename(realPath);
  if (realName === name) return null;
  if (isShellName(realName) && !isShellName(name)) {
    return {
      ok: false,
      rule: "indirect_execution",
      reason: `Executable "${name}" resolves to the shell ${realPath}`,
    };
  }
  if (isInterpreterName(realName) && !isInterpreterName(name) && !isShellName(name)) {
    return {
      ok: false,
      rule: "indirect_execution",
      reason: `Executable "${name}" resolves to the interpreter ${realPath}`,
    };
  }
  return null;
}

/** Shells and interpreters whose bytes a renamed copy would carry. */
const knownProgramNames = (): string[] => [
  ...[...UNCONDITIONAL_BLOCKS].filter((name) => !["eval", "exec", "source", "."].includes(name)),
  ...EXTRA_SHELLS,
  "python3",
  "python",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "php",
  "lua",
  "osascript",
  "awk",
  "gawk",
  "pwsh",
];
const KNOWN_PROGRAM_DIRS = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"];

interface KnownProgram {
  name: string;
  realPath: string;
  size: number;
}

let knownPrograms: KnownProgram[] | undefined;
const digestCache = new Map<string, string>();

/** Real files of the shells and interpreters on this host (standard dirs and PATH), found once. */
function knownProgramFiles(): KnownProgram[] {
  if (knownPrograms) return knownPrograms;
  const dirs = new Set([...KNOWN_PROGRAM_DIRS, ...(process.env.PATH ?? "").split(delimiter).filter(isAbsolute)]);
  const seen = new Set<string>();
  knownPrograms = [];
  for (const name of knownProgramNames()) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (!isExecutableFile(candidate)) continue;
      const realPath = safeRealpath(candidate);
      if (!realPath || seen.has(realPath)) continue;
      seen.add(realPath);
      knownPrograms.push({ name, realPath, size: statSync(realPath).size });
    }
  }
  return knownPrograms;
}

function isWritableDirectory(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    // no-cause: EACCES/EROFS is the answer (not writable); any other failure also means no planted copy can land there
    return false;
  }
}

/** sha256 of a file, cached by path, size and mtime; null when it cannot be read. */
function fileDigest(path: string): string | null {
  const stat = statSync(path);
  const key = `${path}\0${stat.size}\0${stat.mtimeMs}`;
  const cached = digestCache.get(key);
  if (cached) return cached;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    // no-cause: an unreadable file cannot be compared; the caller treats it as unidentified, not as trusted
    return null;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  digestCache.set(key, digest);
  return digest;
}

/**
 * A copy of a shell or interpreter under another name: `cp /bin/sh
 * ~/.bun/bin/ls` lands in a trusted PATH directory with a harmless name and a
 * new real path, so only its bytes give it away. Sizes are compared first; a
 * file is hashed only when its size equals a known program's.
 */
function contentDisguise(name: string, realPath: string): ExecutablePathCheck | null {
  if (isShellName(name) || isInterpreterName(name)) return null;
  // Only a directory this user can write can receive a planted copy. System
  // directories also hold multi-call shims (macOS /usr/bin/git, python3 and make
  // are one xcrun binary that dispatches on its name), which are not copies.
  if (!isWritableDirectory(dirname(realPath))) return null;
  const size = statSync(realPath).size;
  const sameSize = knownProgramFiles().filter((known) => known.size === size && known.realPath !== realPath);
  if (sameSize.length === 0) return null;
  const digest = fileDigest(realPath);
  if (digest === null) {
    return { ok: false, rule: "untrusted_executable_path", reason: `Cannot read ${realPath} to verify what it is` };
  }
  const match = sameSize.find((known) => fileDigest(known.realPath) === digest);
  if (!match) return null;
  return {
    ok: false,
    rule: "indirect_execution",
    reason: `Executable "${name}" at ${realPath} is a copy of the ${isShellName(match.name) ? "shell" : "interpreter"} ${match.realPath}`,
  };
}

/**
 * Check that `word` (the decoded command word) names a binary whose real path
 * is trusted. `name` is the name the grant is checked against.
 */
export function checkExecutablePath(word: string, options: ExecutablePathOptions = {}): ExecutablePathCheck {
  const name = basename(word);
  if (!word.includes("/")) {
    if (SHELL_BUILTINS.has(word)) return { ok: true };
    const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
    for (const entry of pathEnv.split(delimiter)) {
      const relativeEntry = !entry || !isAbsolute(entry);
      if (relativeEntry && (!options.cwd || options.changesDirectory)) {
        // The shell resolves this entry in a directory the guard does not know,
        // so the binary it runs may sit there instead of in a later entry.
        return {
          ok: false,
          rule: "untrusted_executable_path",
          reason: `PATH entry "${entry}" is relative to a working directory the guard cannot resolve`,
        };
      }
      const dir = relativeEntry ? resolve(options.cwd!, entry || ".") : entry;
      const candidate = join(dir, word);
      if (!isExecutableFile(candidate)) continue;
      if (relativeEntry) {
        return {
          ok: false,
          rule: "untrusted_executable_path",
          reason: `Executable "${word}" resolves through the relative PATH entry "${entry}" to ${candidate}`,
        };
      }
      const realPath = safeRealpath(candidate);
      if (!realPath) {
        return { ok: false, rule: "untrusted_executable_path", reason: `Cannot resolve the real path of ${candidate}` };
      }
      return disguise(name, realPath) ?? contentDisguise(name, realPath) ?? { ok: true, realPath };
    }
    // Not on the host PATH: a builtin or function the shell knows, or a typo.
    // The grant check on the name still applies.
    return { ok: true };
  }

  let absolute: string;
  if (word.startsWith("~/")) absolute = join(homedir(), word.slice(2));
  else if (word.startsWith("~")) {
    return { ok: false, rule: "untrusted_executable_path", reason: `Cannot resolve the executable path ${word}` };
  } else if (isAbsolute(word)) absolute = word;
  else {
    if (!options.cwd || options.changesDirectory) {
      return {
        ok: false,
        rule: "untrusted_executable_path",
        reason: `Cannot resolve the relative executable ${word} without a fixed working directory`,
      };
    }
    absolute = resolve(options.cwd, word);
  }

  if (!existsSync(absolute)) {
    return {
      ok: false,
      rule: "untrusted_executable_path",
      reason: `Executable ${word} does not exist when the command is checked`,
    };
  }
  const realPath = safeRealpath(absolute);
  if (!realPath || !isExecutableFile(realPath)) {
    return { ok: false, rule: "untrusted_executable_path", reason: `Executable ${word} is not an executable file` };
  }
  const roots = trustedExecutableRoots(options);
  if (!isWithinTrustedRoots(realPath, roots)) {
    return {
      ok: false,
      rule: "untrusted_executable_path",
      reason: `Executable ${word} resolves to ${realPath}, outside the trusted executable directories`,
    };
  }
  return disguise(name, realPath) ?? contentDisguise(name, realPath) ?? { ok: true, realPath };
}
