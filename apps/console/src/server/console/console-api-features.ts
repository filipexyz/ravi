import type { ConsoleFeatureKey } from "@/features/console/types";

export function consoleFeatureForSegments(segments: string[]): ConsoleFeatureKey | null {
  const [resource, id, child, fourth] = segments;

  if (!resource || resource === "organization" || resource === "organizations" || resource === "features") {
    return null;
  }

  if ((resource === "admin" || resource === "manage") && id === "bugs") {
    return null;
  }

  if (resource === "projects") {
    if (child === "published-pages") return "console.pages";
    if (child === "pages") return "console.pages";
    if (child === "mail") return "console.mail";
    if (child === "knowledge") return "console.knowledge";
    if (child === "bases") return "console.bases";
    if (child === "managed-runtime") return "console.managed_runtime";
    if (child === "ravi-control") return "console.managed_runtime";
    if (child === "github-app") return "console.github";
    if (child === "runs") return "console.runtime_runs";
    if (child === "artifacts") return "console.artifacts";
    return "console.projects";
  }

  if (resource === "github") return "console.github";
  if (resource === "artifacts") return "console.artifacts";
  if (resource === "events") return "console.audit";
  if (resource === "feedback") return "console.feedback";
  if (resource === "bugs") return "console.bugs";
  if (resource === "runs") return "console.runtime_runs";
  if (resource === "pages") return "console.pages";
  if (resource === "billing") return "console.billing";
  if (resource === "mail") return "console.mail";
  if (resource === "domains") {
    if ((id === "claims" && fourth === "bindings") || id === "bindings") {
      return "console.pages.custom_domains";
    }
    return "console.domains";
  }
  if (resource === "settings") return "console.settings";

  return null;
}
