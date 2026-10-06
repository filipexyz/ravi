/**
 * Command shape rule for operations exposed through the Pages app gateway
 * (`pages/app-gateway` in the OSS specs, `console/pages/app-gateway/relay` in
 * the Console specs).
 *
 * Viewer args are spliced verbatim into the operation command, and a positional
 * value is free text. The fixed part of the command must therefore choose what
 * runs before the viewer args start. Otherwise one declared operation lets the
 * viewer pick another subcommand or program: `ravi {args}`, `git {args}`,
 * `bash -c {args}`, `npx {args}`, `npm run {args}`.
 *
 * The installation knows the grammar of one program, the Ravi CLI, so `ravi`
 * commands are checked against the CLI registry: a full read command that
 * leaves no subcommand slot to the viewer. For any other program the
 * rule is structural, and the app author still has to point the command at
 * its final subcommand.
 */

import { basename } from "node:path";
import { parseRaviAppCommand } from "./command.js";
import type { NormalizedGatewayArgs } from "./gateway-declaration.js";

/** Programs whose job is to run another program named in their arguments. */
export const GATEWAY_PROGRAM_RUNNERS: ReadonlySet<string> = new Set([
  "env",
  "xargs",
  "sudo",
  "doas",
  "su",
  "runuser",
  "pkexec",
  "nohup",
  "nice",
  "ionice",
  "chrt",
  "taskset",
  "timeout",
  "gtimeout",
  "time",
  "exec",
  "command",
  "builtin",
  "eval",
  "watch",
  "caffeinate",
  "chroot",
  "setsid",
  "stdbuf",
  "unbuffer",
  "flock",
  "npx",
  "bunx",
  "pnpx",
  "uvx",
  "pipx",
  "ssh",
  "open",
  "xdg-open",
]);

/** Subcommands that run whatever comes next (`npm run`, `bun x`, `pnpm dlx`). */
export const GATEWAY_RUNNER_VERBS: ReadonlySet<string> = new Set(["run", "exec", "x", "dlx", "eval"]);

/** Ravi CLI read commands that hand the choice of app, operation, tool, or command to their args. */
export const GATEWAY_RAVI_DISPATCH_COMMANDS: ReadonlySet<string> = new Set([
  "apps.run",
  "apps.import-cli",
  "jobs.run",
  "commands.run",
  "tools.invoke",
  "tools.test",
]);

/** The Ravi CLI command that the leading words of a `ravi` command name. */
export interface RaviCommandMatch {
  /** Canonical dotted name, the same when the words use an alias (`crm.account`). */
  fullName: string;
  /** How many leading words the command name takes (group path, then command). */
  words: number;
  /** Deeper commands start with this one, as `crm account create` does with `crm account`. */
  hasSubcommands: boolean;
  /** Access kind the CLI registry declares for the command. */
  kind: "read" | "mutate";
}

/**
 * Finds the Ravi CLI command whose path (group segments, then the command
 * name, aliases included) is the longest prefix of `words`, or null when the
 * words do not start with a full command.
 */
export type RaviCommandLookup = (words: readonly string[]) => RaviCommandMatch | null;

/**
 * Returns why `command` must not be exposed through the gateway with this
 * declaration, or null when its shape is acceptable. A declaration of
 * `"none"` passes no viewer args, so any command shape is acceptable.
 */
export function gatewayCommandProblem(
  command: string,
  declaration: NormalizedGatewayArgs,
  lookupRaviCommand: RaviCommandLookup = lookupRaviRegistryCommand,
): string | null {
  if (declaration.none) return null;

  let parsed: ReturnType<typeof parseRaviAppCommand>;
  try {
    parsed = parseRaviAppCommand(command);
  } catch {
    return "the command is not a valid CLI command";
  }

  // Tokens the app author fixed before the viewer args start. Without
  // `{args}`, viewer args are appended, so every token comes before them.
  const prefix = parsed.argsPlaceholderIndex === null ? parsed.argv : parsed.argv.slice(0, parsed.argsPlaceholderIndex);
  const words = prefix.filter((token) => !token.startsWith("-"));
  const program = basename(parsed.executable).toLowerCase();

  if (program === "ravi") {
    const leading: string[] = [];
    for (const token of prefix) {
      if (token.startsWith("-")) break;
      leading.push(token);
    }
    const match = lookupRaviCommand(leading);
    if (!match) {
      return `the words before {args} must start with one full Ravi CLI command, such as "ravi tasks list {args} --json"`;
    }
    const name = `ravi ${match.fullName.split(".").join(" ")}`;
    if (GATEWAY_RAVI_DISPATCH_COMMANDS.has(match.fullName)) {
      return `"${name}" runs whatever its args name`;
    }
    if (match.kind !== "read") {
      return `"${name}" changes state (the CLI registry marks it mutate), and the gateway runs only read commands`;
    }
    // `crm account <id>` is also the group of `crm account create`: Commander
    // reads the first operand after it as a subcommand name, even after flags.
    if (match.hasSubcommands && leading.length === match.words) {
      return `"${name}" also has subcommands, so the viewer's first positional could pick one; name the subcommand before {args}`;
    }
  } else {
    if (GATEWAY_PROGRAM_RUNNERS.has(program)) {
      return `"${program}" runs another program named in its args`;
    }
    if (words.length === 0) {
      return "nothing before {args} names the subcommand or script, so the viewer would choose it";
    }
    const lastWord = words[words.length - 1]!.toLowerCase();
    if (GATEWAY_RUNNER_VERBS.has(lastWord)) {
      return `"${lastWord}" right before {args} runs whatever the viewer passes`;
    }
    // A fixed word after `{args}` may be the subcommand (`tool cli.js {args} list`),
    // so the viewer's args would come before it. Only fixed options may follow.
    if (parsed.argsPlaceholderIndex !== null) {
      const word = parsed.argv.slice(parsed.argsPlaceholderIndex + 1).find((token) => !token.startsWith("-"));
      if (word !== undefined) {
        return `"${word}" comes after {args}, so the viewer's args would land before it; move it before {args}`;
      }
    }
  }

  const lastToken = prefix[prefix.length - 1];
  if (declaration.positional > 0 && lastToken !== undefined && lastToken.startsWith("-")) {
    return `the viewer's first positional would become the value of "${lastToken}"; put fixed options after {args}`;
  }
  return null;
}

interface RaviRegistryPath {
  fullName: string;
  segments: string[];
  /** Names Commander accepts at each segment: the canonical one plus aliases. */
  names: ReadonlySet<string>[];
  kind: "read" | "mutate";
}

let raviRegistryPaths: RaviRegistryPath[] | null = null;

function loadRaviRegistryPaths(): RaviRegistryPath[] {
  if (raviRegistryPaths) return raviRegistryPaths;
  // Loaded lazily: the registry walks every command class, and some of
  // them import the apps service that calls this module.
  const { getRegistry } = require("../cli/registry-snapshot.js") as typeof import("../cli/registry-snapshot.js");
  const { groups, commands } = getRegistry();
  // Commander accepts a group or command alias wherever its canonical name goes.
  const aliases = new Map<string, string[]>();
  const addAliases = (path: string, list: readonly string[] | undefined) => {
    if (list?.length) aliases.set(path, [...(aliases.get(path) ?? []), ...list]);
  };
  for (const group of groups) addAliases(group.name, group.aliases);
  for (const entry of commands) addAliases(entry.fullName, entry.aliases);
  raviRegistryPaths = commands.map((entry) => {
    const segments = [...entry.groupSegments, entry.command];
    return {
      fullName: entry.fullName,
      segments,
      names: segments.map(
        (segment, index) => new Set([segment, ...(aliases.get(segments.slice(0, index + 1).join(".")) ?? [])]),
      ),
      kind: entry.access?.kind ?? "mutate",
    };
  });
  return raviRegistryPaths;
}

/**
 * Default lookup over the decorated CLI registry, loaded on first use. Root
 * commands that `src/cli/index.ts` registers by hand (`doctor`, `whoami`,
 * `login`) are not in the registry, so they never match.
 */
export function lookupRaviRegistryCommand(words: readonly string[]): RaviCommandMatch | null {
  const paths = loadRaviRegistryPaths();
  let best: RaviRegistryPath | null = null;
  for (const path of paths) {
    if (path.names.length > words.length) continue;
    if (!path.names.every((names, index) => names.has(words[index]!))) continue;
    if (!best || path.names.length > best.names.length) best = path;
  }
  if (!best) return null;
  const match = best;
  return {
    fullName: match.fullName,
    words: match.segments.length,
    hasSubcommands: paths.some(
      (path) =>
        path.segments.length > match.segments.length &&
        match.segments.every((segment, index) => path.segments[index] === segment),
    ),
    kind: match.kind,
  };
}
