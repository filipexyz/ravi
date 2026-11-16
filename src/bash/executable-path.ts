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

import { existsSync, realpathSync, statSync } from "node:fs";
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
    return null;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
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
      const dir = relativeEntry ? (options.cwd ? resolve(options.cwd, entry || ".") : null) : entry;
      if (!dir) continue;
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
      return disguise(name, realPath) ?? { ok: true, realPath };
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
  if (!roots.some((root) => within(realPath, root) || within(dirname(realPath), root))) {
    return {
      ok: false,
      rule: "untrusted_executable_path",
      reason: `Executable ${word} resolves to ${realPath}, outside the trusted executable directories`,
    };
  }
  return disguise(name, realPath) ?? { ok: true, realPath };
}
