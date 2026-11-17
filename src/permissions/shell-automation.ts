import { getContext } from "../cli/context.js";
import { CliExpectedError } from "../cli/expected-error.js";
import { canWithCapabilityContext } from "./provider-runtime.js";

/**
 * A shell cron job or trigger runs its command through the system shell as the
 * daemon user, outside the executable ceiling of the turn that wrote it. In a
 * runtime context, writing one needs the same authority as running any host
 * executable: `execute:executable:*` or `admin:system:*`.
 */
export function assertShellAutomationAuthorized(op: string): void {
  const context = getContext()?.context;
  if (!context) return;
  if (
    canWithCapabilityContext(context, "execute", "executable", "*") ||
    canWithCapabilityContext(context, "admin", "system", "*")
  ) {
    return;
  }
  throw new CliExpectedError(
    `${op}: shell jobs run arbitrary host commands and need execute:executable:* or admin:system:*.`,
    "PERMISSION_DENIED",
    1,
    "Use an agent job (--message), or ask the operator to set up the shell job.",
  );
}
