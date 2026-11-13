/**
 * Keep the daemon's stdin from ever blocking the event loop.
 *
 * #539 stopped audit TTY metadata from touching `process.stdin` (isatty on the
 * raw fd). That was necessary and is kept. It is not sufficient: Bun can still
 * issue a synchronous `read(0)` (256KiB FileReader chunk) without going through
 * the JS `process.stdin` getter. Under PM2, fd 0 is often an idle socketpair
 * (`wchan=unix_stream_data_wait`). That wedges dispatch, delivery, and the
 * in-process host CLI gateway until something writes or closes the peer.
 *
 * Product fix: make daemon stdin inert. `daemon run` opens `/dev/null` and
 * dup2s it onto fd 0 before the command graph can arm stdin. PM2 registration
 * also launches through a fixed shell that execs Bun with `< /dev/null`, so
 * `ravi update --next` cannot restore a writable idle socketpair as the only
 * stdin story.
 */

import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, openSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { CHANNELS_PM2_PROCESS_NAME, clearedPm2ContextEnv, PM2_PROCESS_NAME, type Pm2Process } from "./pm2.js";

const STDIN_FD = 0;

/**
 * Keep the interpreter independent of package paths: PM2 treats any interpreter
 * containing `bun` (including `.bun` and `bundle`) as its Bun process container.
 * Dynamic paths travel through the environment and argv, never shell source.
 */
const clearPm2Context = `unset ${Object.keys(clearedPm2ContextEnv()).join(" ")};`;
export const PM2_INERT_STDIN_SHELL_COMMAND = `${clearPm2Context} exec "$RAVI_PM2_EXECUTABLE" "$0" "$@" < /dev/null`;
export const PM2_CHANNELS_SHELL_COMMAND = `${clearPm2Context} exec "$0" "$@" < /dev/null`;

export type DaemonStdinNeuterResult = { replaced: true; path: string } | { replaced: false; reason: string };

let posixDup2Fn: ((oldFd: number, newFd: number) => number) | undefined;

export function isDaemonRunArgv(argv: readonly string[] = process.argv): boolean {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "daemon" && argv[i + 1] === "run") return true;
  }
  return false;
}

function libcName(): string {
  if (process.platform === "darwin") return "libSystem.B.dylib";
  if (process.platform === "linux") return "libc.so.6";
  throw new Error(`unsupported-platform:${process.platform}`);
}

function posixDup2(oldFd: number, newFd: number): number {
  if (!posixDup2Fn) {
    const libc = dlopen(libcName(), {
      dup2: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    });
    posixDup2Fn = libc.symbols.dup2 as (oldFd: number, newFd: number) => number;
  }
  return posixDup2Fn(oldFd, newFd);
}

/**
 * Replace fd 0 with `/dev/null` so a later native `read(0)` returns EOF
 * immediately instead of blocking on an idle PM2 socketpair.
 */
export function neuterDaemonStdin(): DaemonStdinNeuterResult {
  if (process.platform === "win32") {
    return { replaced: false, reason: "unsupported-platform" };
  }

  try {
    const path = "/dev/null";
    const nullFd = openSync(path, "r");
    try {
      const duplicated = posixDup2(nullFd, STDIN_FD);
      if (duplicated !== STDIN_FD) {
        return { replaced: false, reason: `dup2-failed:${duplicated}` };
      }
      return { replaced: true, path };
    } finally {
      if (nullFd !== STDIN_FD) closeSync(nullFd);
    }
  } catch (error) {
    return { replaced: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function maybeNeuterDaemonStdin(argv: readonly string[] = process.argv): DaemonStdinNeuterResult {
  if (!isDaemonRunArgv(argv)) {
    return { replaced: false, reason: "not-daemon-run" };
  }
  return neuterDaemonStdin();
}

export function buildDaemonPm2StartArgs(input: { bundlePath: string }): string[] {
  const cwd = resolve(dirname(input.bundlePath), "../..");
  return [
    "start",
    // PM2 rewrites absolute script paths containing spaces into bash commands.
    relative(cwd, input.bundlePath),
    "--cwd",
    cwd,
    "--name",
    PM2_PROCESS_NAME,
    "--interpreter",
    "/bin/sh",
    "--interpreter-args",
    `-c '${PM2_INERT_STDIN_SHELL_COMMAND}'`,
    "--",
    "daemon",
    "run",
  ];
}

export function buildChannelsPm2Env(bunPath = process.execPath): Record<string, string> {
  const executable = realpathSync(bunPath);
  return {
    RAVI_PM2_EXECUTABLE: executable,
    PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ""}`,
  };
}

export function buildChannelsPm2StartArgs(input: {
  bundlePath: string;
  bunPath?: string;
  processes?: readonly Pick<Pm2Process, "name" | "namespace">[];
}): string[] {
  const cwd = resolve(dirname(input.bundlePath), "../..");
  const executable = realpathSync(input.bunPath ?? process.execPath);
  const script = basename(executable);
  if (script === "all" || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(script)) {
    throw new Error(`Cannot register channels with PM2: unsupported Bun executable filename ${JSON.stringify(script)}`);
  }
  if (input.processes?.some((process) => process.name === script || process.namespace === script)) {
    throw new Error(
      `Cannot register channels with PM2: Bun filename ${script} conflicts with an existing PM2 process or namespace`,
    );
  }
  const localScript = join(cwd, script);
  if (existsSync(localScript) && realpathSync(localScript) !== executable) {
    throw new Error(`Cannot register channels with PM2: ${localScript} shadows the selected Bun executable`);
  }
  return [
    "start",
    script,
    "--cwd",
    cwd,
    "--name",
    CHANNELS_PM2_PROCESS_NAME,
    "--interpreter",
    "/bin/sh",
    "--interpreter-args",
    `-c '${PM2_CHANNELS_SHELL_COMMAND}'`,
    "--",
    input.bundlePath,
    "channels",
    "run",
  ];
}

// Side effect: daemon run must replace fd 0 before later CLI imports (ink, etc.)
// can instantiate stdin or Bun can arm a FileReader on the PM2 socketpair.
maybeNeuterDaemonStdin();
