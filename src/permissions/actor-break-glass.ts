import type { ContextCapability } from "../router/router-db.js";
import { BREAK_GLASS_CAPABILITIES } from "./break-glass.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "./provider-runtime.js";

/** The break-glass set of permissions/break-glass, as targets to withhold. */
const BREAK_GLASS_TARGETS: ReadonlyArray<Pick<ContextCapability, "permission" | "objectType" | "objectId">> =
  BREAK_GLASS_CAPABILITIES.map((value) => {
    const [permission = "", objectType = "", objectId = ""] = value.split(":");
    return { permission, objectType, objectId };
  });

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
