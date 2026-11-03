export function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

/** Safe, fixed copy per error code; never echoes ids, emails or other users. */
export function linkErrorCopy(code: string | undefined): { title: string; description: string } | null {
  switch (code) {
    case undefined:
      return null;
    case "LINK_REQUEST_INVALID":
      return {
        title: "This link is not valid",
        description: "Ask Ravi for a new link by running `ravi link` again in the chat.",
      };
    case "LINK_REQUEST_EXPIRED":
      return {
        title: "This link has expired",
        description: "Links last 10 minutes. Ask Ravi for a new one by running `ravi link` again in the chat.",
      };
    case "LINK_REQUEST_USED":
      return {
        title: "This link was already used",
        description: "Each link works once. If you still need to link, ask Ravi for a new one.",
      };
    case "LINK_USER_MISMATCH":
      return {
        title: "This link was sent to someone else",
        description:
          "Sign in with the Console account that uses the same email as your chat account, then open the link again.",
      };
    case "NOT_MEMBER":
      return {
        title: "No access to this organization",
        description: "Ask an organization owner to add your Console account, then ask Ravi for a new link.",
      };
    case "INSTALLATION_REVOKED":
      return {
        title: "This Ravi installation was disconnected",
        description: "Ask the operator to reconnect it with `ravi login`.",
      };
    case "CONFLICT":
      return {
        title: "This chat account is already linked",
        description:
          "It is linked to another Console account. Its owner must unlink it first (`ravi unlink` in the chat, or the Linked chat accounts page).",
      };
    case "NOT_FOUND":
      return {
        title: "Link not found",
        description: "It may have been removed already.",
      };
    default:
      return {
        title: "Something went wrong",
        description: "Nothing was linked. Try again, or ask Ravi for a new link.",
      };
  }
}
