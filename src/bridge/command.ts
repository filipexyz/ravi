import type { ContextAuthorizationOptions } from "../approval/service.js";
import { authorizeBridgeAction } from "./native.js";

/** v2 command adapter supports a single literal argv command. Shell programs/expansions/redirections
 * cannot be bound to one executable and are an unsupported protocol shape, not a local allowlist. */
export function bridgeExecutable(command: string): string | null {
  if (!command || command.length > 16_384 || /[\n\r\0$`\\;|&<>(){}[\]*?~#]/.test(command)) return null;
  const tokens = command.trim().match(/(?:[^\s'"=]+|'[^']*'|"[^"]*")+/g);
  if (!tokens?.length || tokens.join(" ").replace(/\s+/g, " ") !== command.trim().replace(/\s+/g, " ")) return null;
  return /^[A-Za-z0-9_-]+$/.test(tokens[0]!) ? tokens[0]! : null;
}
export async function authorizeBridgeCommand(
  context: ContextAuthorizationOptions["context"],
  command: string,
  eventData: ContextAuthorizationOptions["eventData"],
  beforeExternalApproval?: () => void,
) {
  const executable = bridgeExecutable(command);
  if (!executable)
    return {
      approved: false,
      reason: "Bridge supports one literal executable and arguments; shell syntax is unsupported",
    };
  let inherited = true;
  for (const capability of [
    { permission: "use", objectType: "tool", objectId: "Bash" },
    { permission: "execute", objectType: "executable", objectId: executable },
  ]) {
    const decision = await authorizeBridgeAction({
      context,
      ...capability,
      eventData: { ...eventData, command },
      beforeExternalApproval,
    });
    if (!decision.allowed) return { approved: false, reason: decision.reason };
    inherited &&= decision.inherited;
  }
  return { approved: true, inherited };
}
