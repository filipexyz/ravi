/**
 * `ravi home <group> <command> …`: run one allowlisted task command against
 * HOME (the daemon that started this sandbox run) through the sandbox gateway.
 *
 * Spec: `sandbox/home-passthrough`.
 *
 * The entrypoint strips the `home` token and sets an in-process invocation
 * target (a module flag, never env), so only this invocation goes to
 * `RAVI_HOME_GATEWAY_URL`; every other command keeps its normal transport.
 * The registry then dispatches the decorated command with its usual parsing
 * and body, authenticated only by the sandbox grant. The client-side
 * allowlist is UX: the Gate and the HOME listener enforce it.
 */

import { stripTerminalControls, terminalSafeJson } from "../sandbox/outputs.js";
import {
  CONTRACT_EXIT_POLICY,
  ContractError,
  type ContractErrorDetails,
  renderContractError,
} from "./agent-contract.js";
import { getContext } from "./context.js";
import {
  HOME_GATEWAY_URL_ENV,
  knownSandboxGrant,
  mapJsonStrings,
  type RemoteDispatchResult,
  SANDBOX_GRANT_ENV,
  scrubHomeContractError,
  scrubHomeGrant,
  scrubHomeGrantText,
} from "./remote-gateway.js";

export const HOME_INVOCATION_TOKEN = "home";
export const HOME_COMMANDS_ENV = "RAVI_HOME_COMMANDS";

/**
 * Milestone 1 static allowlist, equal to Console's `SANDBOX_COMMAND_ALLOWLIST`
 * and the HOME listener's. `tasks.comment` is excluded (ADR 0003 #3).
 */
export const HOME_STATIC_COMMANDS = Object.freeze([
  "tasks.block",
  "tasks.done",
  "tasks.fail",
  "tasks.report",
  "tasks.show",
] as const);

const COMMAND_SEGMENT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export type CliInvocationTarget = "local" | "home";

let invocationTarget: CliInvocationTarget = "local";

export function getCliInvocationTarget(): CliInvocationTarget {
  return invocationTarget;
}

/** Set by the entrypoint for `ravi home …`; tests reset it. */
export function setCliInvocationTarget(target: CliInvocationTarget): void {
  invocationTarget = target;
}

/**
 * Commands this run may send HOME: the static allowlist, narrowed by
 * `RAVI_HOME_COMMANDS` (comma- or space-separated command ids) when set.
 */
export function homeCommands(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[HOME_COMMANDS_ENV]?.trim();
  if (!raw) return [...HOME_STATIC_COMMANDS];
  const requested = new Set(raw.split(/[\s,]+/).filter(Boolean));
  return HOME_STATIC_COMMANDS.filter((id) => requested.has(id));
}

export function isHomeCommand(commandId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return homeCommands(env).includes(commandId);
}

export function homeCommandNotAllowedError(
  commandId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): ContractError {
  const allowed = homeCommands(env);
  const shown =
    commandId && /^[a-z0-9.-]{1,129}$/.test(commandId) ? `'${commandId.replace(".", " ")}'` : "This command";
  return new ContractError(
    "home",
    "HOME_COMMAND_NOT_ALLOWED",
    `${shown} is not a HOME command for this run.`,
    CONTRACT_EXIT_POLICY,
    {
      allowed,
      suggestedAction:
        allowed.length > 0
          ? `Use one of: ${allowed.map((id) => `ravi home ${id.replace(".", " ")}`).join(", ")}`
          : `This run allows no HOME command (${HOME_COMMANDS_ENV} is empty after the allowlist)`,
    },
  );
}

export type HomeInvocation =
  | { kind: "help"; asJson: boolean }
  | { kind: "refused"; error: ContractError; asJson: boolean }
  | { kind: "dispatch"; commandId: string };

/**
 * Inspect `argv` for `ravi home …`. Returns null when the first argument is
 * not `home`. On `dispatch` the `home` token is removed from `argv` and the
 * invocation target is set, so commander parses the decorated command.
 */
export function enterHomeInvocation(argv: string[], env: NodeJS.ProcessEnv = process.env): HomeInvocation | null {
  if (argv[2] !== HOME_INVOCATION_TOKEN) return null;
  const rest = argv.slice(3);
  const asJson = rest.includes("--json");
  const [group, command] = rest;
  if (group === undefined || group === "--help" || group === "-h" || (group === "--json" && rest.length === 1)) {
    return { kind: "help", asJson };
  }
  const commandId =
    group && command && COMMAND_SEGMENT_PATTERN.test(group) && COMMAND_SEGMENT_PATTERN.test(command)
      ? `${group}.${command}`
      : null;
  if (!commandId || !isHomeCommand(commandId, env)) {
    return { kind: "refused", error: homeCommandNotAllowedError(commandId, env), asJson };
  }
  argv.splice(2, 1);
  setCliInvocationTarget("home");
  return { kind: "dispatch", commandId };
}

export function homeHelp(env: NodeJS.ProcessEnv = process.env): { text: string; json: Record<string, unknown> } {
  const commands = homeCommands(env);
  const gatewayConfigured = Boolean(env[HOME_GATEWAY_URL_ENV]?.trim());
  const text = [
    "Usage: ravi home <group> <command> [args...] [--json]",
    "",
    "Runs one task command against HOME, the Ravi daemon that started this sandbox run,",
    `through the sandbox gateway in ${HOME_GATEWAY_URL_ENV}. Arguments and flags are those of`,
    "the same command (`ravi <group> <command> --help`). The request carries no context key",
    "and no working directory; the run's sandbox grant is its only credential.",
    "",
    "HOME commands for this run:",
    ...(commands.length > 0 ? commands.map((id) => `  ravi home ${id.replace(".", " ")}`) : ["  (none)"]),
    "",
    "Environment:",
    `  ${HOME_GATEWAY_URL_ENV}  https gateway URL of this run (${gatewayConfigured ? "set" : "not set"})`,
    `  ${HOME_COMMANDS_ENV}     command ids this run's grant allows`,
    `  ${SANDBOX_GRANT_ENV}     fallback only, when the egress proxy does not add the grant`,
    "",
    "A command outside the list exits 3 here; HOME enforces the list on its own.",
  ].join("\n");
  return { text, json: { success: true, commands, gatewayConfigured } };
}

function stripTerminalControlsDeep(value: unknown): unknown {
  return mapJsonStrings(value, stripTerminalControls);
}

/**
 * Render a home-mode error. The grant is scrubbed; text mode strips C0 (but
 * `\n` and `\t`), C1 and bidi controls, `--json` writes them as `\uXXXX`.
 */
export function renderHomeContractError(
  error: ContractError,
  asJson: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const scrubbed = scrubHomeContractError(error, knownSandboxGrant(env));
  if (asJson) {
    if (getContext({ localOnly: true })?.suppressCliOutput === true) return;
    console.log(terminalSafeJson(scrubbed.envelope()));
    return;
  }
  renderContractError(
    new ContractError(
      scrubbed.op,
      scrubbed.code,
      stripTerminalControls(scrubbed.message),
      scrubbed.exitCode,
      stripTerminalControlsDeep(scrubbed.details) as ContractErrorDetails,
    ),
    false,
  );
}

/**
 * The printable form of a 2xx HOME answer: grant scrubbed, JSON pretty-printed,
 * terminal controls stripped in text mode and escaped as `\uXXXX` with `--json`.
 * A HOME answer is never written as raw bytes.
 */
export function formatHomeOutput(
  result: RemoteDispatchResult,
  asJson: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (result.body.length === 0) return "";
  const grant = knownSandboxGrant(env);
  if (result.contentType?.includes("json")) {
    try {
      const value = scrubHomeGrant(JSON.parse(result.body), grant);
      return `${asJson ? terminalSafeJson(value) : JSON.stringify(stripTerminalControlsDeep(value), null, 2)}\n`;
    } catch {
      // Not JSON after all: printed as text below.
    }
  }
  const text = stripTerminalControls(scrubHomeGrantText(result.body, grant));
  return text.endsWith("\n") ? text : `${text}\n`;
}
