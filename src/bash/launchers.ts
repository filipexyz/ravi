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
  | {
      kind: "payloads";
      payloads: Argv[];
      assignments: string[];
      /** The launcher adds arguments read at run time (xargs input) to the payload argv. */
      openArgs?: boolean;
    }
  /** The launcher hands a string to a shell (`parallel`, `watch`, `sudo -s`). */
  | { kind: "shell_string"; reason: string };

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/** xargs options whose value is the next word (see the `withValue` list in xargsPayload). */
const XARGS_VALUE_OPTIONS = new Set([
  "-a",
  "-E",
  "-L",
  "-n",
  "-P",
  "-R",
  "-S",
  "-s",
  "-d",
  "--arg-file",
  "--max-args",
  "--max-procs",
  "--max-chars",
  "--delimiter",
  "--process-slot-var",
]);

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
      const option = arg.slice(0, arg.indexOf("="));
      if (spec.withValue.includes(option) || spec.optionalValue?.includes(option)) {
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
      "--max-args",
      "--max-procs",
      "--max-chars",
      "--delimiter",
      "--process-slot-var",
    ],
    // GNU: the value is attached or absent (`-i`, `--replace`, `--replace=R`);
    // these never consume the next word, which is already the payload.
    optionalValue: ["-i", "-l", "-e", "--replace", "--eof", "--max-lines"],
  });
  const payloads = rest(argv, i);
  const replace = xargsReplaceStrings(argv.slice(1, i) as string[]);
  // Without a replace string xargs appends the words it reads, quotes honored,
  // to the payload argv. With one, input text lands wherever the string occurs.
  let openArgs = replace.length === 0;
  for (const payload of payloads) {
    const [word, ...args] = payload;
    if (replace.some((value) => word === null || word === undefined || word.includes(value))) {
      fail(name, "its replace string can rewrite the command word from input");
    }
    if (args.some((arg) => arg === null || replace.some((value) => arg.includes(value)))) openArgs = true;
  }
  return { kind: "payloads", payloads, assignments: [], ...(openArgs ? { openArgs } : {}) };
}

/** Replace strings set by `-I R`, `-IR`, `-i[R]`, `--replace[=R]` and BSD `-J R` (`{}` when bare). */
function xargsReplaceStrings(options: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < options.length; i++) {
    const option = options[i]!;
    if (option === "--") break;
    if (option === "-I" || option === "-J") values.push(options[++i] ?? "");
    else if (/^-[IJ]./.test(option)) values.push(option.slice(2));
    else if (option === "-i" || option === "--replace") values.push("{}");
    else if (option.startsWith("-i")) values.push(option.slice(2));
    else if (option.startsWith("--replace=")) values.push(option.slice("--replace=".length));
    else if (XARGS_VALUE_OPTIONS.has(option)) i++;
  }
  // An empty replace string would match everywhere; xargs refuses it too.
  return values.map((value) => value || "{}");
}

/**
 * find primaries that take exactly one operand in GNU and BSD find. The
 * operand is data even when it spells an action: `-name '-exec'` matches a
 * file. Only primaries certain to consume a word are listed; an unlisted one
 * leaves its operand to be read as a primary, which can only add a payload.
 */
const FIND_ONE_OPERAND = new Set([
  "-name",
  "-iname",
  "-path",
  "-ipath",
  "-wholename",
  "-iwholename",
  "-regex",
  "-iregex",
  "-lname",
  "-ilname",
  "-type",
  "-xtype",
  "-user",
  "-group",
  "-uid",
  "-gid",
  "-perm",
  "-size",
  "-mtime",
  "-atime",
  "-ctime",
  "-mmin",
  "-amin",
  "-cmin",
  "-Bmin",
  "-Btime",
  "-newer",
  "-anewer",
  "-cnewer",
  "-Bnewer",
  "-samefile",
  "-inum",
  "-links",
  "-maxdepth",
  "-mindepth",
  "-fstype",
  "-used",
  "-context",
  "-printf",
  "-fprint",
  "-fprint0",
  "-fls",
  "-regextype",
  "-files0-from",
  "-flags",
]);

function findPayloads(name: string, argv: Argv): LauncherPayloads {
  const payloads: Argv[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    // An unquoted variable or glob can expand to several words, `-exec sh -c id ;` included.
    if (arg === null) fail(name, "a dynamic argument could add an action such as -exec");
    if (FIND_ONE_OPERAND.has(arg) || /^-newer[aBcmt][aBcmt]$/.test(arg)) {
      if (i + 1 < argv.length && argv[i + 1] === null)
        fail(name, "a dynamic argument could add an action such as -exec");
      i++;
      continue;
    }
    if (arg === "-fprintf") {
      if (argv.slice(i + 1, i + 3).includes(null)) fail(name, "a dynamic argument could add an action such as -exec");
      i += 2;
      continue;
    }
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(arg)) continue;
    const start = i + 1;
    let end = start;
    while (end < argv.length && argv[end] !== ";" && argv[end] !== "+") end++;
    if (end >= argv.length) fail(name, `${arg} is not terminated by ';' or '+'`);
    if (end === start) fail(name, `${arg} has no command`);
    // A dynamic word could end this action early (`;`) and start another.
    if (argv.slice(start, end).includes(null)) fail(name, "a dynamic argument could add an action such as -exec");
    payloads.push(argv.slice(start, end));
    i = end;
  }
  return { kind: "payloads", payloads, assignments: [] };
}

function sudoPayload(name: string, argv: Argv): LauncherPayloads {
  // sudo puts NAME=VALUE words before the command in its environment. They go
  // to the same execution-override check as `env NAME=VALUE`, whatever
  // env_reset in sudoers would keep at run time.
  const assignments: string[] = [];
  const payloadFrom = (start: number): LauncherPayloads => {
    let i = start;
    while (i < argv.length) {
      const arg = argv[i];
      if (arg === null) fail(name, "a dynamic assignment or command");
      const match = ASSIGNMENT.exec(arg);
      if (!match) break;
      assignments.push(match[1]!);
      i++;
    }
    return { kind: "payloads", payloads: rest(argv, i), assignments };
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === null) fail(name, "a dynamic option");
    if (arg === "--") return payloadFrom(i + 1);
    if (!arg.startsWith("-")) return payloadFrom(i);
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
