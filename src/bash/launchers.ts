/**
 * Launchers: executables whose arguments name another command to run.
 *
 * The guard must see the launched command, not just the launcher. Each parser
 * here returns the argv of every payload, or says it cannot tell. It never
 * decides authority: the policy in hook.ts does, and refuses an interpreter
 * behind a launcher unless the context has arbitrary execution authority.
 */

import { ShellAnalysisError } from "./shell-structure.js";

/** A decoded argument; `null` marks a dynamic word (variable, glob, substitution). */
export type Argv = Array<string | null>;

export type LauncherPayloads =
  | { kind: "payloads"; payloads: Argv[]; assignments: string[] }
  /** The launcher hands a string to a shell (`parallel`, `watch`, `sudo -s`). */
  | { kind: "shell_string"; reason: string };

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/** Launchers that run their payload through a shell string, never as argv. */
export const SHELL_STRING_LAUNCHERS = new Set(["parallel", "sem", "watch", "su", "runuser", "script"]);

/** Launchers that exec their payload argv directly. */
export const ARGV_LAUNCHERS = new Set([
  "env",
  "timeout",
  "gtimeout",
  "nice",
  "nohup",
  "xargs",
  "gxargs",
  "find",
  "gfind",
  "sudo",
  "doas",
  "command",
  "builtin",
  "stdbuf",
  "setsid",
  "caffeinate",
  "time",
]);

function fail(launcher: string, detail: string): never {
  throw new ShellAnalysisError(`Cannot resolve the command launched by ${launcher}: ${detail}`);
}

/**
 * Walk leading options. `withValue` options consume the next word unless the
 * value is attached (`-n1`, `--signal=KILL`); `flags` take none. Anything else
 * is refused so an unknown option cannot hide the payload position.
 */
function skipOptions(
  launcher: string,
  argv: Argv,
  start: number,
  spec: { flags: string[]; withValue: string[]; optionalValue?: string[]; numeric?: boolean },
): number {
  let i = start;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === null) fail(launcher, "a dynamic option");
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-") || arg === "-") return i;
    if (spec.flags.includes(arg)) {
      i++;
      continue;
    }
    if (spec.withValue.includes(arg)) {
      if (i + 1 >= argv.length) fail(launcher, `option ${arg} has no value`);
      i += 2;
      continue;
    }
    if (arg.startsWith("--") && arg.includes("=")) {
      if (spec.withValue.includes(arg.slice(0, arg.indexOf("=")))) {
        i++;
        continue;
      }
      fail(launcher, `unsupported option ${arg}`);
    }
    const short = arg.slice(0, 2);
    if (!arg.startsWith("--") && (spec.withValue.includes(short) || spec.optionalValue?.includes(short))) {
      i++;
      continue;
    }
    if (spec.optionalValue?.includes(arg)) {
      i++;
      continue;
    }
    if (spec.numeric && /^-\d+$/.test(arg)) {
      i++;
      continue;
    }
    // Bundled short flags (`-0r`, `-iv`) are fine when every letter is a known flag.
    if (!arg.startsWith("--") && [...arg.slice(1)].every((letter) => spec.flags.includes(`-${letter}`))) {
      i++;
      continue;
    }
    fail(launcher, `unsupported option ${arg}`);
  }
  return i;
}

function rest(argv: Argv, index: number): Argv[] {
  return index < argv.length ? [argv.slice(index)] : [];
}

function envPayload(argv: Argv): LauncherPayloads {
  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === null) fail("env", "a dynamic option");
    if (arg === "--") {
      i++;
      break;
    }
    if (arg === "-S" || arg.startsWith("--split-string") || /^-[^-]*S/.test(arg)) {
      fail("env", "-S/--split-string builds the command from a string");
    }
    if (arg === "-P" || /^-[^-]*P/.test(arg)) fail("env", "-P changes the search path of the command");
    if (!arg.startsWith("-") || arg === "-") {
      if (arg === "-") {
        i++;
        continue;
      }
      break;
    }
    if (["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"].includes(arg)) {
      i++;
      continue;
    }
    if (["-u", "-C", "--unset", "--chdir"].includes(arg)) {
      i += 2;
      continue;
    }
    if (/^--(unset|chdir)=/.test(arg) || /^-[iv0]*[uC].+/.test(arg)) {
      i++;
      continue;
    }
    if (/^-[iv0]*[uC]$/.test(arg)) {
      i += 2;
      continue;
    }
    if (/^-[iv0]+$/.test(arg)) {
      i++;
      continue;
    }
    fail("env", `unsupported option ${arg}`);
  }
  const assignments: string[] = [];
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === null) fail("env", "a dynamic assignment or command");
    const match = ASSIGNMENT.exec(arg);
    if (!match) break;
    assignments.push(match[1]!);
    i++;
  }
  return { kind: "payloads", payloads: rest(argv, i), assignments };
}

function xargsPayload(name: string, argv: Argv): LauncherPayloads {
  const i = skipOptions(name, argv, 1, {
    flags: [
      "-0",
      "-r",
      "-t",
      "-p",
      "-x",
      "-o",
      "--null",
      "--no-run-if-empty",
      "--verbose",
      "--interactive",
      "--exit",
      "--open-tty",
      "--show-limits",
    ],
    withValue: [
      "-a",
      "-E",
      "-I",
      "-J",
      "-L",
      "-n",
      "-P",
      "-R",
      "-S",
      "-s",
      "-d",
      "--arg-file",
      "--eof",
      "--replace",
      "--max-lines",
      "--max-args",
      "--max-procs",
      "--max-chars",
      "--delimiter",
      "--process-slot-var",
    ],
    optionalValue: ["-i", "-l", "-e"],
  });
  return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
}

function findPayloads(name: string, argv: Argv): LauncherPayloads {
  const payloads: Argv[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === null) continue;
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) continue;
    const start = i + 1;
    let end = start;
    while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end++;
    if (end >= argv.length) fail(name, `${arg} is not terminated by ';' or '+'`);
    if (end === start) fail(name, `${arg} has no command`);
    payloads.push(argv.slice(start, end));
    i = end;
  }
  return { kind: "payloads", payloads, assignments: [] };
}

function sudoPayload(name: string, argv: Argv): LauncherPayloads {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === null) fail(name, "a dynamic option");
    if (arg === "--") return { kind: "payloads", payloads: rest(argv, i + 1), assignments: [] };
    if (!arg.startsWith("-")) {
      // sudo accepts NAME=VALUE before the command.
      if (ASSIGNMENT.test(arg)) continue;
      return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
    }
    if (/^-[^-]*[si]/.test(arg) || arg === "--shell" || arg === "--login") {
      return { kind: "shell_string", reason: `${name} ${arg} starts a shell` };
    }
    if (/^-[CghprtUuDRT]$/.test(arg) || (name === "doas" && arg === "-C")) {
      i++;
      continue;
    }
    if (/^--[a-z-]+=/.test(arg) || /^-[AbEeHKklnPSVv]+$/.test(arg) || /^-[CghprtUuDRT].+/.test(arg)) continue;
    if (/^--[a-z-]+$/.test(arg)) continue;
    fail(name, `unsupported option ${arg}`);
  }
  return { kind: "payloads", payloads: [], assignments: [] };
}

/**
 * Payloads of `argv[0]` (already resolved to `name`), `null` when it is not a
 * launcher. Throws {@link ShellAnalysisError} when the payload is unknowable.
 */
export function launcherPayloads(name: string, argv: Argv): LauncherPayloads | null {
  if (SHELL_STRING_LAUNCHERS.has(name)) {
    return { kind: "shell_string", reason: `${name} runs its command through a shell string` };
  }
  if (!ARGV_LAUNCHERS.has(name)) return null;
  switch (name) {
    case "env":
      return envPayload(argv);
    case "timeout":
    case "gtimeout": {
      const i = skipOptions(name, argv, 1, {
        flags: ["--preserve-status", "--foreground", "-v", "--verbose", "-f", "-p"],
        withValue: ["-s", "-k", "--signal", "--kill-after"],
      });
      if (i >= argv.length) fail(name, "missing duration");
      return { kind: "payloads", payloads: rest(argv, i + 1), assignments: [] };
    }
    case "nice": {
      const i = skipOptions(name, argv, 1, { flags: [], withValue: ["-n", "--adjustment"], numeric: true });
      return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
    }
    case "nohup":
    case "setsid": {
      const i = skipOptions(name, argv, 1, { flags: ["-c", "-f", "-w", "--ctty", "--fork", "--wait"], withValue: [] });
      return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
    }
    case "caffeinate": {
      const i = skipOptions(name, argv, 1, { flags: ["-d", "-i", "-m", "-s", "-u"], withValue: ["-t", "-w"] });
      return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
    }
    case "stdbuf": {
      const i = skipOptions(name, argv, 1, {
        flags: [],
        withValue: ["-i", "-o", "-e", "--input", "--output", "--error"],
      });
      return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
    }
    case "time": {
      const i = skipOptions(name, argv, 1, {
        flags: ["-p", "-l", "-h", "-a", "-v", "-q", "--portability", "--verbose", "--append", "--quiet"],
        withValue: ["-o", "-f", "--output", "--format"],
      });
      return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
    }
    case "xargs":
    case "gxargs":
      return xargsPayload(name, argv);
    case "find":
    case "gfind":
      return findPayloads(name, argv);
    case "sudo":
    case "doas":
      return sudoPayload(name, argv);
    case "command": {
      let i = 1;
      while (i < argv.length) {
        const arg = argv[i];
        if (arg === null) fail(name, "a dynamic option");
        if (arg === "--") {
          i++;
          break;
        }
        if (arg === "-v" || arg === "-V") return { kind: "payloads", payloads: [], assignments: [] };
        if (arg === "-p") {
          i++;
          continue;
        }
        if (arg.startsWith("-")) fail(name, `unsupported option ${arg}`);
        break;
      }
      return { kind: "payloads", payloads: rest(argv, i), assignments: [] };
    }
    case "builtin":
      return { kind: "payloads", payloads: rest(argv, 1), assignments: [] };
  }
  return null;
}
