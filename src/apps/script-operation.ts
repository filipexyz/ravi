/**
 * Host side of script operations (spec apps/router, "Script Operations"): read
 * the script from the app package, read the declared input folder from the
 * caller's working directory, check what the script returns, and stage its
 * files for the declared `handoff` command. Nothing here runs app code.
 */

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertCallerFileAccess } from "../cli/caller-cwd.js";
import { APP_SCRIPT_LIMITS, AppScriptError, isSafeScriptPath } from "./script-sandbox.js";

/** Read a regular file without following a symbolic link swapped in after the listing. */
function readRegularFile(path: string, maxBytes: number): Buffer | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) {
      throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", "An input file is larger than the script input limit.");
    }
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

function inside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."));
}

/** Read the script file named by the manifest. It must be a regular file inside the app folder. */
export function readScriptSource(appRoot: string, scriptPath: string): string {
  if (!isSafeScriptPath(scriptPath) || !scriptPath.endsWith(".js")) {
    throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", "The operation's script path is not a package path.");
  }
  const root = realpathSync(appRoot);
  const full = join(root, ...scriptPath.split("/"));
  const stat = lstatSync(full);
  if (!stat.isFile()) throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", "The operation's script is not a file.");
  if (!inside(root, realpathSync(full))) {
    throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", "The operation's script is outside the app folder.");
  }
  if (stat.size > APP_SCRIPT_LIMITS.sourceBytes) {
    throw new AppScriptError("APP_SCRIPT_LIMIT", "The operation's script is too large.");
  }
  return readFileSync(full, "utf8");
}

/**
 * Split `--flag <dir>` (or `--flag=<dir>`) out of the caller's args. The
 * folder must resolve inside `baseDir` (the caller's working directory) with
 * no symbolic link anywhere below it, and a runtime caller must hold the right
 * to read local files (`use:tool:Read`), as for any CLI file argument. Its
 * UTF-8 text files become the input.
 */
export function collectScriptInput(
  args: readonly string[],
  flag: string | undefined,
  baseDir: string,
): { args: string[]; files: Record<string, string>; inputDir: string | null } {
  if (!flag) return { args: [...args], files: {}, inputDir: null };
  const rest: string[] = [];
  let value: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === flag || token.startsWith(`${flag}=`)) {
      if (value !== null) throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `${flag} was given more than once.`);
      value = token === flag ? (args[++index] ?? "") : token.slice(flag.length + 1);
      if (!value) throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `${flag} needs a folder.`);
      continue;
    }
    rest.push(token);
  }
  if (value === null) return { args: rest, files: {}, inputDir: null };

  const base = realpathSync(baseDir);
  const requested = resolve(base, value);
  let real: string;
  try {
    real = realpathSync(requested);
  } catch (error) {
    throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `${flag} folder does not exist.`, { cause: error });
  }
  if (!inside(base, real) || real !== requested) {
    throw new AppScriptError(
      "APP_SCRIPT_INPUT_INVALID",
      `${flag} must name a folder inside the working directory, without symbolic links.`,
    );
  }
  if (!lstatSync(real).isDirectory()) {
    throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `${flag} must name a folder.`);
  }
  assertCallerFileAccess(real, "read");

  const files: Record<string, string> = {};
  let count = 0;
  let bytes = 0;
  const visit = (dir: string, prefix: string, depth: number) => {
    if (depth > 8) throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `${flag} folder is nested too deep.`);
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry}` : entry;
      const full = join(dir, entry);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `${flag} folder contains a symbolic link: ${rel}`);
      }
      if (stat.isDirectory()) {
        visit(full, rel, depth + 1);
        continue;
      }
      if (!stat.isFile() || !isSafeScriptPath(rel)) continue;
      count++;
      bytes += stat.size;
      if (count > APP_SCRIPT_LIMITS.inputFiles || bytes > APP_SCRIPT_LIMITS.inputBytes) {
        throw new AppScriptError("APP_SCRIPT_INPUT_INVALID", `${flag} folder is larger than the script input limit.`);
      }
      const data = readRegularFile(full, APP_SCRIPT_LIMITS.inputBytes);
      if (!data) continue;
      const text = data.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(data) || text.includes("\0")) continue; // binary files are left out
      files[rel] = text;
    }
  };
  visit(real, "", 0);
  return { args: rest, files, inputDir: real };
}

/**
 * The script may add only declared flags to the `handoff` command, each followed
 * by exactly one value that does not look like a flag.
 */
export function checkThenArgs(args: readonly string[], allowed: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag)) {
      throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", `The script may not pass ${flag.slice(0, 40)}.`);
    }
    if (value === undefined || value.startsWith("-") || /[\r\n\0]/.test(value)) {
      throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", `The script must give ${flag} one plain value.`);
    }
    out.push(flag, value);
  }
  return out;
}

/** Write the script's files to a new private folder. The caller removes it. */
export function stageScriptOutput(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ravi-app-script-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      if (!isSafeScriptPath(path)) throw new AppScriptError("APP_SCRIPT_OUTPUT_INVALID", "Unsafe output path.");
      const target = join(dir, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}
