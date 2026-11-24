import type { ContextCapability } from "../router/router-db.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "./provider-runtime.js";

/**
 * Break-glass = power that can change who has power or run anything: any admin
 * over the system or the whole executable wildcard. Mirrors the definition in
 * permissions/break-glass (#950).
 */
const BREAK_GLASS_TARGETS: ReadonlyArray<Pick<ContextCapability, "permission" | "objectType" | "objectId">> = [
  { permission: "admin", objectType: "system", objectId: "*" },
  { permission: "execute", objectType: "executable", objectId: "*" },
];

/**
 * A turn a person triggered in a chat with no contact grants acts through the
 * agent identity as "everything of the agent except break-glass": for each
 * break-glass power the agent holds and the contact does not, the turn carries
 * a `deny_<permission>` entry. The snapshot matcher and the shell hook honor
 * it, so the admin shortcut keeps every ordinary capability (images, web, ...)
 * while system admin and arbitrary commands stay closed. The contact's own
 * capabilities still count in full.
 */
export function breakGlassDeniesForContact(
  agentCapabilities: ContextCapability[],
  contactId: string,
  contactCapabilities: ContextCapability[] = materializeSubjectCapabilities("contact", contactId),
): ContextCapability[] {
  return BREAK_GLASS_TARGETS.filter(
    (target) =>
      canWithCapabilities(agentCapabilities, target.permission, target.objectType, target.objectId) &&
      !canWithCapabilities(contactCapabilities, target.permission, target.objectType, target.objectId),
  ).map((target) => ({
    permission: `deny_${target.permission}`,
    objectType: target.objectType,
    objectId: target.objectId,
    source: "actor-break-glass",
  }));
}
