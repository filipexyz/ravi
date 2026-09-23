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
 * also launches through a tiny wrapper that execs Bun with `< /dev/null`, so
 * `ravi update --next` cannot restore a writable idle socketpair as the only
 * stdin story.
 */

import { dlopen, FFIType } from "bun:ffi";
import { chmodSync, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PM2_PROCESS_NAME } from "./pm2.js";
import { getRaviStateDir } from "./utils/paths.js";

const STDIN_FD = 0;

export const PM2_INERT_STDIN_WRAPPER_NAME = "ravi-pm2-stdin";

/**
 * PM2 interpreter wrapper. God/ProcessContainerForkBun otherwise attaches an
 * idle socketpair as fd 0. Exec the real Bun argv with stdin bound to
 * `/dev/null` so the runtime never sees that pair.
 *
 * PM2 spawn shape: `wrapper <bunPath> <bundle> daemon run`
 */
export const PM2_INERT_STDIN_WRAPPER_SOURCE = `#!/bin/sh
# Inert-stdin interpreter for the Ravi daemon PM2 app.
# Must stay a shell wrapper (not Bun) so PM2 does not use ProcessContainerForkBun.
exec "$@" < /dev/null
`;

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

export function defaultPm2InertStdinWrapperPath(bundlePath: string): string {
  return join(dirname(bundlePath), PM2_INERT_STDIN_WRAPPER_NAME);
}

export function buildDaemonPm2StartArgs(input: {
  bundlePath: string;
  bunPath?: string;
  stdinWrapperPath?: string;
}): string[] {
  const bunPath = input.bunPath ?? "bun";
  const stdinWrapperPath = input.stdinWrapperPath ?? defaultPm2InertStdinWrapperPath(input.bundlePath);
  return [
    "start",
    input.bundlePath,
    "--name",
    PM2_PROCESS_NAME,
    "--interpreter",
    stdinWrapperPath,
    "--interpreter-args",
    bunPath,
    "--",
    "daemon",
    "run",
  ];
}

export function ensurePm2InertStdinWrapper(bundlePath: string): string {
  const candidates = [
    defaultPm2InertStdinWrapperPath(bundlePath),
    join(getRaviStateDir(), PM2_INERT_STDIN_WRAPPER_NAME),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      mkdirSync(dirname(candidate), { recursive: true });
      writeFileSync(candidate, PM2_INERT_STDIN_WRAPPER_SOURCE, { encoding: "utf8", mode: 0o755 });
      chmodSync(candidate, 0o755);
      return candidate;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Unable to install PM2 inert-stdin wrapper: ${detail}`);
}

export function isInertStdinPm2StartArgs(args: readonly string[]): boolean {
  const interpreterIndex = args.indexOf("--interpreter");
  const interpreterArgsIndex = args.indexOf("--interpreter-args");
  const separator = args.indexOf("--");
  const interpreter = interpreterIndex >= 0 ? args[interpreterIndex + 1] : undefined;
  const interpreterArgs = interpreterArgsIndex >= 0 ? args[interpreterArgsIndex + 1] : undefined;
  return (
    Boolean(interpreter?.endsWith(PM2_INERT_STDIN_WRAPPER_NAME)) &&
    Boolean(interpreterArgs) &&
    separator >= 0 &&
    args[separator + 1] === "daemon" &&
    args[separator + 2] === "run"
  );
}

// Side effect: daemon run must replace fd 0 before later CLI imports (ink, etc.)
// can instantiate stdin or Bun can arm a FileReader on the PM2 socketpair.
maybeNeuterDaemonStdin();
