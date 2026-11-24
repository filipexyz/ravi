import { basename } from "node:path";
import { getContext } from "../cli/context.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { isWithheldByDeny } from "./capability-snapshot.js";

/**
 * One gate for every process the core spawns from a name that came from a
 * command argument or a manifest (app commands: `apps import-cli`, `apps run`,
 * app permission providers). The Bash hook only sees `ravi ...`; the process
 * the core spawns behind it must ask the turn too. A turn that withholds
 * `execute:executable:*` (a person held below the agent's break-glass) cannot
 * spawn anything but Ravi itself. Code outside a turn is unaffected.
 */
export function assertTurnMayExecute(executable: string, op: string): void {
  const context = getContext()?.context;
  if (!context || !Array.isArray(context.capabilities)) return;
  const name = basename(executable.trim());
  if (!name) return;
  if (!isWithheldByDeny(context.capabilities, "execute", "executable", name)) return;
  throw new CliExpectedError(
    `${op} cannot run '${name}' in this turn: running executables is not granted to the person who asked.`,
    "PERMISSION_DENIED",
    1,
    "Ask the operator to grant it in this chat (ravi permissions request) or to run it.",
  );
}
