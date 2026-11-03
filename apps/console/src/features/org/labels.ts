import { ApiError, describeError } from "@/lib/api/client";
import type { ConsoleFeatureAccessItem, Member, OrganizationRole } from "@/features/console/types";
import { roleLabel } from "@/features/shell/workspace";

export const ROLE_ORDER: OrganizationRole[] = ["owner", "admin", "developer", "viewer", "billing"];

/** What each organization role can do today, as the server decides it. */
export const ROLE_HELP: Record<OrganizationRole, string> = {
  owner: "Manages the organization, its members and its owners. Project access is granted separately by policy.",
  admin: "Manages the organization and its members (except owners). Project access is granted separately by policy.",
  developer: "Uses the development features enabled for the organization, within projects and actions granted by policy.",
  viewer: "May view projects only when an explicit project policy grants access.",
  billing: "Has no screens in the Console right now.",
};

function joinWords(words: string[]) {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "owners and admins" for a feature's required roles. */
export function rolesPhrase(roles: string[]) {
  const plural = roles.map((role) => `${roleLabel(role).toLowerCase()}s`);
  return joinWords(plural);
}

/** Why a feature is closed, in one sentence. */
export function lockedReason(feature: ConsoleFeatureAccessItem | undefined, what: string) {
  if (!feature) return `${what} isn't available in this Console.`;
  if (feature.reason === "role_denied" && feature.requiredRoles.length) {
    return `${what} is for ${rolesPhrase(feature.requiredRoles)}.`;
  }
  return `${what} isn't turned on for this organization.`;
}

function code(error: unknown) {
  return error instanceof ApiError ? error.code : null;
}

export function settingsErrorMessage(error: unknown) {
  switch (code(error)) {
    case "slug_unavailable":
      return "This address is taken or not allowed. Try another one.";
    case "validation_failed":
      return "Check the highlighted fields.";
    case "forbidden":
    case "organization_forbidden":
      return "Your current access policy does not permit changing this organization.";
    default:
      return describeError(error);
  }
}

export function memberErrorMessage(error: unknown) {
  switch (code(error)) {
    case "forbidden":
      return "Only owners and admins can manage members.";
    case "owner_required":
      return "Only an owner can make someone an owner, or change or remove an owner.";
    case "last_owner_required":
      return "The organization needs at least one owner. Make someone else an owner first.";
    case "user_not_found":
      return "That person isn't a member anymore. Refresh the list.";
    case "validation_failed":
      return "Enter a valid email address.";
    default:
      return describeError(error);
  }
}

export function inviteErrorMessage(error: unknown) {
  switch (code(error)) {
    case "already_member":
      return "That email is already a member. Change their role in the list instead.";
    case "forbidden":
      return "Only owners and admins can invite people.";
    case "owner_required":
      return "Only an owner can invite another owner.";
    case "invite_not_found":
      return "That invite is gone. Refresh the list.";
    case "validation_failed":
      return "Enter a valid email address.";
    default:
      return describeError(error);
  }
}

export function domainErrorMessage(error: unknown) {
  switch (code(error)) {
    case "domain_unavailable":
      return "This domain can't be added. Check the spelling (like example.com). If it's right, another organization may already have it, or it's reserved.";
    case "domain_verification_unavailable":
      return "This domain has no record to check. Contact the Ravi team.";
    case "forbidden":
      return "Your role can't change domains. Ask an owner, admin or developer.";
    default:
      return describeError(error);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(value: string) {
  return UUID.test(value);
}

/**
 * A person-readable name for an audit or feedback actor. The server sends the
 * user id for people, so names come from the member list when the viewer can
 * read it.
 */
export function actorName(actor: string, members: Pick<Member, "id" | "name" | "email">[] | undefined, currentUserId: string | undefined) {
  if (actor === "system") return "Ravi";
  if (actor === "anonymous") return "Anonymous";
  if (currentUserId && actor === currentUserId) return "You";
  const member = members?.find((item) => item.id === actor);
  if (member) return member.name || member.email;
  if (looksLikeId(actor)) return "A member";
  return actor;
}
