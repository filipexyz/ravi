/**
 * Output files of a sandbox run, treated as data from an untrusted machine.
 *
 * Everything a run saves (daemon log, patch, task.json, traces, transcripts,
 * E2B telemetry) was produced inside the sandbox by a worker following
 * instructions it did not write, so a prompt-injected worker can shape every
 * byte of it. Four things follow: the files are private to the operator (0600
 * in 0700 directories, under a custom `--output` too) and written without
 * following symbolic links; nothing is read without a size cap, enforced both
 * in the sandbox and by counting what the host actually receives (a sandbox
 * cannot fill the host's disk or memory); nothing is printed to the terminal
 * without stripping terminal control sequences (a log line cannot rewrite the
 * screen, write the clipboard or hide text behind a hyperlink); and `--json`
 * output escapes the C1 and bidi characters JSON itself leaves raw.
 */

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const MiB = 1024 * 1024;
/** The full daemon log read at the end of a run; the live copy is capped the same way. */
export const MAX_DAEMON_LOG = 50 * MiB;
/** `changes.patch`; over this nothing is saved but a marker (a partial patch applies partially). */
export const MAX_PATCH = 20 * MiB;
/** Each Claude Code transcript, session trace and TASK.md. */
export const MAX_TRANSCRIPT = 10 * MiB;
/** Everything one run's collection receives from the sandbox; once reached, later files are not read. */
export const MAX_TOTAL = 200 * MiB;
/** JSON the run parses (`ravi tasks show`, `ravi sessions list`); over this it is rejected, not truncated. */
export const MAX_JSON = 1 * MiB;
/** A command's stderr, kept by the sandbox wrapper (the size line comes after it). */
export const MAX_STDERR = 64 * 1024;
/**
 * What a command may stream back beyond its cap before the host kills it. The wrapper
 * sends at most cap + 1 bytes of stdout and MAX_STDERR of stderr; a sandbox that sends
 * more is not running the wrapper as written.
 */
export const STREAM_MARGIN = 1 * MiB;
/** Longest daemon log line kept in host memory while waiting for its newline; longer lines are cut. */
export const MAX_DAEMON_LINE = 64 * 1024;
/** Commands that are not reads (clone, agent setup, task create) may stream this much before they are killed. */
export const MAX_COMMAND_OUTPUT = 4 * MiB;

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Create `dir` 0700 or check an existing one: never a symbolic link, always a directory. */
function ensurePrivateDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dir}`);
  chmodSync(dir, PRIVATE_DIR_MODE);
}

/**
 * Create `dir` (and its parents) and make it owner-only. An existing directory is
 * made 0700 too: the output directory holds the repository's changes and the
 * worker's transcripts, so a custom `--output` should be a directory for the run.
 * A symbolic link is refused, never followed; with `root`, every directory from
 * `root` down to `dir` is checked that way, not only the last one.
 */
export function mkdirPrivate(dir: string, root?: string): void {
  if (root === undefined) {
    ensurePrivateDir(dir);
    return;
  }
  const rel = relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${dir} is outside ${root}`);
  let current = root;
  ensurePrivateDir(current);
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    ensurePrivateDir(current);
  }
}

/** Write all of `data` to an open file descriptor. */
function writeAll(fd: number, data: string): void {
  const buf = Buffer.from(data);
  for (let at = 0; at < buf.length; ) at += writeSync(fd, buf, at, buf.length - at);
}

// O_NOFOLLOW: a symbolic link planted at the path fails the open (ELOOP) instead of
// redirecting the write; O_NONBLOCK: a planted FIFO fails instead of blocking.
const NO_FOLLOW = constants.O_NOFOLLOW | constants.O_NONBLOCK;

function openNoFollow(path: string, flags: number): number {
  try {
    return openSync(path, flags | NO_FOLLOW, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing to write through a symbolic link: ${path}`);
    }
    throw error;
  }
}

/**
 * Write a whole file, mode 0600, in a 0700 directory, replacing it atomically: the
 * data goes to a fresh temp file (O_EXCL, O_NOFOLLOW) that is renamed over `path`,
 * so a symbolic link at `path` is replaced, not followed.
 */
export function writePrivate(path: string, data: string, root?: string): void {
  const dir = dirname(path);
  mkdirPrivate(dir, root);
  const tmp = join(dir, `.${basename(path).slice(0, 180)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openNoFollow(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    fchmodSync(fd, PRIVATE_FILE_MODE);
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best effort: the temp file is private and named for this write only.
    }
    throw error;
  }
}

/**
 * Append to a file that is created 0600 when missing (the live daemon log and run.log).
 * The open uses O_NOFOLLOW: a symbolic link at `path`, dangling or not, is refused and
 * whatever it points to is left untouched.
 */
export function appendPrivate(path: string, data: string, root?: string): void {
  let existed = true;
  try {
    lstatSync(path);
  } catch {
    existed = false;
  }
  if (!existed) mkdirPrivate(dirname(path), root);
  const fd = openNoFollow(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Not a regular file: ${path}`);
    if (!existed) fchmodSync(fd, PRIVATE_FILE_MODE);
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
}

/**
 * What a sandbox command returned when read through `head -c <cap + 1>`: the
 * content, whether it went past the cap, and the size the sandbox reported when
 * it did (the exact byte count, or the cap plus one when only the overflow is known).
 */
export interface CappedRead {
  content: string;
  overflow: boolean;
  bytes: number;
}

/**
 * Read `cmd`'s stdout inside the sandbox through a temp file and `head -c cap + 1`,
 * and its stderr through another temp file and `head -c MAX_STDERR`, so a wrapper
 * that runs as written sends at most cap + 1 + MAX_STDERR bytes and the exit code is
 * the command's own (a pipe would report `head`'s); the subshell keeps an `exit` or
 * `cd` in `cmd` from ending or moving the wrapper. The stdout size is reported last
 * on stderr, on a line of its own, as `ravi-bytes=<n>`, so an overflow marker can
 * name it. The sandbox can still ignore all of this (a replaced `head` or shell),
 * which is why the host also counts what it receives (`STREAM_MARGIN`).
 */
export function cappedCommand(cmd: string, cap: number): string {
  return (
    `out=$(mktemp) && err=$(mktemp) && ( ${cmd} ) > "$out" 2> "$err"; rc=$?; head -c ${cap + 1} "$out"; ` +
    `head -c ${MAX_STDERR} "$err" >&2; printf '\\nravi-bytes=%s\\n' "$(wc -c < "$out")" >&2; ` +
    `rm -f "$out" "$err"; exit $rc`
  );
}

/** Split what a capped command returned into content, overflow flag and reported size. */
export function readCapped(stdout: string, stderr: string | undefined, cap: number): CappedRead {
  const got = Buffer.byteLength(stdout);
  // The last match: the command's own stderr comes first and could hold a lookalike.
  const reported = [...(stderr ?? "").matchAll(/ravi-bytes=\s*(\d+)/g)].at(-1);
  const bytes = reported ? Number(reported[1]) : got;
  if (got <= cap) return { content: stdout, overflow: false, bytes: Math.max(bytes, got) };
  return { content: truncateBytes(stdout, cap), overflow: true, bytes: Math.max(bytes, cap + 1) };
}

/** The first `cap` bytes of `text`, cut on a character boundary. */
export function truncateBytes(text: string, cap: number): string {
  const buf = Buffer.from(text);
  if (buf.length <= cap) return text;
  let cut = buf.toString("utf8", 0, cap);
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut;
}

/** The line appended to a text file that was cut at its cap. */
export function truncationMarker(cap: number, bytes: number): string {
  return `\n[ravi: output truncated at ${cap} bytes; the sandbox reported ${bytes} bytes]\n`;
}

/** Human-readable size for markers and warnings. */
export function formatBytes(bytes: number): string {
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

// Everything a terminal interprets, except newline and tab:
// - OSC (ESC ] … BEL|ST, or the C1 form): titles, hyperlinks (OSC 8), clipboard writes (OSC 52);
// - CSI (ESC [ … final byte, or C1 CSI): cursor movement, clear screen, colours;
// - DCS/SOS/PM/APC strings (ESC P|X|^|_ … ST): programmable keys and such;
// - any other ESC + one byte (RIS, charset switches …);
// - the remaining C0 controls and DEL, incl. `\r` (overwrites the line) and BEL;
// - C1 controls U+0080–U+009F;
// - bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069) that reorder what is shown.
const TERMINAL_CONTROLS_RE = new RegExp(
  [
    "(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c)?",
    "(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]?",
    "\\x1b[PX^_][^\\x1b\\x9c\\n]*(?:\\x1b\\\\|\\x9c)?",
    "\\x1b[\\x20-\\x7e]?",
    "[\\x00-\\x08\\x0b-\\x1f\\x7f]",
    "[\\x80-\\x9f]",
    "[\\u202a-\\u202e\\u2066-\\u2069]",
  ].join("|"),
  "g",
);

/**
 * Remove what a terminal would interpret from text that came out of the sandbox,
 * before it is printed. Saved files keep the raw bytes (redacted); only the
 * terminal copy is cleaned, so a transcript stays faithful while the screen does not.
 */
export function stripTerminalControls(text: string): string {
  return text.replace(TERMINAL_CONTROLS_RE, "");
}

// JSON.stringify escapes C0 controls but leaves C1 controls (U+0080–U+009F, which
// include the 8-bit CSI and OSC introducers), bidi marks, overrides and isolates,
// and the line/paragraph separators raw. They can only occur inside JSON strings.
const JSON_UNSAFE_RE = /[\u0080-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `JSON.stringify(value, null, 2)` with the characters a terminal would act on
 * written as `\uXXXX` escapes: the same JSON value, but printing it is inert.
 */
export function terminalSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    JSON_UNSAFE_RE,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
