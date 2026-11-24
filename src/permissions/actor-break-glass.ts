import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "./provider-runtime.js";

/**
 * Break-glass = power that can change who has power or run anything:
 * any admin over the system, the whole executable wildcard, or a bare wildcard
 * permission. Mirrors the definition in permissions/break-glass (#950).
 */
export function isActorBreakGlassCapability(
  capability: Pick<ContextCapability, "permission" | "objectType" | "objectId">,
): boolean {
  const permission = capability.permission.trim().toLowerCase();
  const objectType = capability.objectType.trim().toLowerCase();
  const objectId = capability.objectId.trim();
  if (permission === "*") return true;
  if (permission === "admin" && (objectType === "system" || objectType === "*")) return true;
  if (permission === "execute" && (objectType === "executable" || objectType === "*") && objectId === "*") return true;
  return false;
}

/**
 * A turn a person triggered in a chat with no contact grants acts through the
 * agent identity, but never above the person on break-glass: the agent's
 * admin/system and executable wildcard reach the turn only when the contact
 * holds that same capability. Absence of a grant means the least, not the
 * agent's most. Non break-glass agent capabilities are unchanged.
 */
export function narrowAgentBreakGlassToContact(
  agentCapabilities: ContextCapability[],
  contactId: string,
  contactCapabilities: ContextCapability[] = materializeSubjectCapabilities("contact", contactId),
): { capabilities: ContextCapability[]; withheld: number } {
  let withheld = 0;
  const capabilities = agentCapabilities.filter((capability) => {
    if (!isActorBreakGlassCapability(capability)) return true;
    if (canWithCapabilities(contactCapabilities, capability.permission, capability.objectType, capability.objectId)) {
      return true;
    }
    withheld += 1;
    return false;
  });
  return { capabilities, withheld };
}
