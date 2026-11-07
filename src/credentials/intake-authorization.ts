import {
  authorizePermission,
  findApprovalRequirement,
  materializeSubjectCapabilities,
} from "../permissions/provider-runtime.js";

/** Recheck live authority, including external providers, at every intake boundary. */
export function authorizeIntakeSubject(
  type: "agent" | "contact",
  id: string,
  resource: "credentials.requests" | "credentials.secrets",
  target: string,
): boolean {
  try {
    const request = {
      subject: { type, id },
      capabilities: materializeSubjectCapabilities(type, id),
      permission: "mutate",
      objectType: resource,
      objectId: target,
    };
    if (findApprovalRequirement([request])) return false;
    const decision = authorizePermission(request);
    return decision.allowed && decision.decision === "allow";
  } catch {
    // no-cause: Authorization failures deny intake without exposing internal permission or identity diagnostics.
    return false;
  }
}
