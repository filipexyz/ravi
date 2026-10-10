import { stripVTControlCharacters } from "node:util";
import {
  CLOUD_AUTH_ERROR_CODES,
  CloudAuthError,
  isConnectorPolicyCode,
  isRetryableCloudAuthError,
} from "../cloud-auth/errors.js";
import {
  ContractError,
  CONTRACT_EXIT_ERROR,
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  sanitizePublicContractMessage,
  type ContractErrorDetails,
} from "./agent-contract.js";
import { getContext } from "./context.js";
import { payloadInvalidIssues, sanitizePayloadInvalidMessage } from "./payload-error-message.js";

export function commandOperation(group: string, command: string): string {
  if (group === "_root") return command;
  return `${group.replaceAll("_", " ")} ${command}`;
}

/** Map provider/auth failures into the global CLI exit taxonomy without losing their stable code. */
export function cloudErrorToContractError(op: string, error: CloudAuthError): ContractError {
  const issues = error.code === "PAYLOAD_INVALID" ? payloadInvalidIssues(error.message, error.issues) : error.issues;
  const connectorTurn = connectorTurnCopy(error);
  return new ContractError(
    op,
    error.code,
    connectorTurn?.message ?? publicMessage(error.code, error.message),
    error.code === "PAYLOAD_INVALID"
      ? CONTRACT_EXIT_USAGE
      : isConnectorPolicyCode(error.code)
        ? CONTRACT_EXIT_POLICY
        : CONTRACT_EXIT_ERROR,
    {
      retryable: isRetryableCloudAuthError(error),
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(issues ? { issues } : {}),
      suggestedAction: suggestedAction(error.code),
      ...(connectorTurn?.details ?? {}),
    },
  );
}

/** Details a locally built connector-turn error may carry into the public envelope. */
const CONNECTOR_TURN_DETAIL_KEYS = [
  "chatLine",
  "chatLinePt",
  "replyTo",
  "reconnectLink",
  "approvalId",
  "approvalLink",
  "expiresAt",
  "retryWith",
] as const;

/**
 * Connector errors built by the local turn classification (`src/link`) carry
 * their own agent-facing text: what to say in the chat and where. Errors from
 * Link or Console keep the fixed catalog copy, because their text is remote.
 */
function connectorTurnCopy(error: CloudAuthError): { message: string; details: ContractErrorDetails } | null {
  if (!error.code.startsWith("CONNECTOR_") || error.details?.source !== "connector-turn") return null;
  const message = sanitizePublicContractMessage(error.message);
  if (!message) return null;
  const details: ContractErrorDetails = {};
  for (const key of CONNECTOR_TURN_DETAIL_KEYS) {
    const value = error.details[key];
    if (typeof value === "string" && value.trim()) details[key] = value;
  }
  return { message, details };
}

function publicMessage(code: CloudAuthError["code"], sourceMessage: string): string {
  switch (code) {
    case "AUTH_REQUIRED":
      return "Console authentication is required.";
    case "AUTH_PENDING":
      return "Console authentication is still pending.";
    case "AUTH_EXPIRED":
      return "Console authentication expired.";
    case "INSTALLATION_REVOKED":
      return "Console installation access was revoked.";
    case "ORG_ACCESS_DENIED":
      return "Console organization access was denied.";
    case "PROJECT_ACCESS_DENIED":
      return "Console project access was denied.";
    case "PUBLISH_NOT_ALLOWED":
      return "Console publishing is not allowed.";
    case "DOMAIN_SETUP_REQUIRED":
      return safeDomainSetupMessage(sourceMessage);
    case "PAYLOAD_INVALID":
      return sanitizePayloadInvalidMessage(sourceMessage) ?? "Console request input was invalid.";
    case "RATE_LIMITED":
      return "Console request was rate limited.";
    case "SERVER_UNAVAILABLE":
      return "Console service is unavailable.";
    case "HOST_UNREACHABLE":
      return "Console is unreachable from this provider sandbox. The host CLI can reach Console.";
    case "CREDENTIALS_INVALID":
      return "Console credentials are invalid.";
    case "CLOUD_PUBLISH_NOT_IMPLEMENTED":
      return "Console publishing is unavailable for this command.";
    case "CONTACT_REQUIRED":
      return "ravi link needs the current chat message to come from a known person (a resolved contact).";
    case "ACTOR_BINDING_CONFLICT":
      return "This contact is already linked to a different Console user.";
    case "LOCAL_INSTALLATION_MISSING":
      return "Console does not know this local Ravi installation.";
    case "INSTALLATION_MISMATCH":
      return "The request named a different installation than the current Console session.";
    case "LINK_APPROVAL_REQUIRED":
      return "Linking requires the person's approval in the browser; the direct link call is closed.";
    case "LINK_REQUESTS_UNAVAILABLE":
      return "This Console does not support link approval requests yet.";
    case "LINK_DM_UNSUPPORTED":
      return "Ravi cannot send a private message to this person on this channel.";
    case "LINK_DM_FAILED":
      return "Ravi could not send the private message to the person who asked.";
    case "NOT_FOUND":
      return "Console resource was not found.";
    case "CONFLICT":
      return "Console rejected the request because it conflicts with the current state.";
    case "VERSION_CONFLICT":
      return "Console resource changed since it was read.";
    case "CONNECTOR_GROUP_BLOCKED":
      return "Personal connections are not used in group chats.";
    case "CONNECTOR_SPEAKER_NOT_OWNER":
      return "This connection only serves its owner's own requests.";
    case "CONNECTOR_DISABLED_BY_ORG":
      return "The organization turned this connector off.";
    case "CONNECTOR_TOOL_BLOCKED":
      return "The account owner or the organization blocked this tool.";
    case "CONNECTOR_APPROVAL_REQUIRED":
      return "The account owner must approve this action first.";
    case "CONNECTOR_APPROVAL_PENDING":
      return "The approval for this action is still waiting for the account owner.";
    case "CONNECTOR_APPROVAL_DENIED":
      return "The account owner denied this action.";
    case "CONNECTOR_APPROVAL_INVALID":
      return "The approval does not match this action.";
    case "CONNECTOR_CONSENT_REQUIRED":
      return "The person asking must allow this agent to use their account first.";
    case "CONNECTOR_NOT_LINKED":
      return "The person asking is not linked to a Console user.";
    case "CONNECTOR_CONNECTION_REQUIRED":
      return "The person asking has no connected account for this service.";
    case "CONNECTOR_REAUTH_REQUIRED":
      return "The connection expired and must be reconnected.";
    case "CONNECTOR_PERMISSION_REQUIRED":
      return "The connection does not allow this action: it is read only or misses a permission.";
    case "CONNECTOR_POLICY_ABOVE_CEILING":
      return "The organization's limit for this tool does not allow that policy.";
    case "CONNECTOR_FORBIDDEN":
      return "Only the owner of this connection can do that.";
  }
}

/**
 * Local copy for a cloud code, for transports that must not trust remote text.
 * Codes whose copy depends on the source message return undefined.
 */
export function cloudContractCatalogCopy(code: string): { message: string; suggestedAction: string } | undefined {
  if (!isCloudAuthErrorCode(code) || code === "PAYLOAD_INVALID" || code === "DOMAIN_SETUP_REQUIRED") return undefined;
  return { message: publicMessage(code, ""), suggestedAction: suggestedAction(code) };
}

/** Render once for the local CLI. Tools and gateway serialize the returned ContractError themselves. */
export function renderCloudContractError(error: ContractError, asJson: boolean | undefined): void {
  if (getContext({ localOnly: true })?.suppressCliOutput === true) return;
  if (asJson) {
    console.log(JSON.stringify(error.envelope(), null, 2));
    return;
  }
  console.error(`${error.code}: ${error.message}`);
  // A connector line the message refers to without quoting it (one with a link).
  const chatLine = error.details.chatLine;
  if (typeof chatLine === "string" && chatLine.length > 0 && !error.message.includes(chatLine)) {
    const replyTo = error.details.replyTo === "owner_privately" ? " (to the owner, privately)" : "";
    console.error(`Chat line${replyTo}: ${chatLine}`);
  }
  const next = error.details.suggestedAction;
  if (typeof next === "string" && next.length > 0) console.error(`Next: ${next}.`);
}

function suggestedAction(code: CloudAuthError["code"]): string {
  switch (code) {
    case "AUTH_REQUIRED":
    case "AUTH_EXPIRED":
    case "CREDENTIALS_INVALID":
      return "run 'ravi login' and retry";
    case "AUTH_PENDING":
      return "complete authentication, then retry";
    case "INSTALLATION_REVOKED":
      return "reconnect the Console installation, then retry";
    case "ORG_ACCESS_DENIED":
    case "PROJECT_ACCESS_DENIED":
    case "PUBLISH_NOT_ALLOWED":
      return "request the required Console access before retrying";
    case "DOMAIN_SETUP_REQUIRED":
      return "complete the displayed DNS action, wait for propagation, then rerun the same command";
    case "PAYLOAD_INVALID":
      return "correct the command input and retry";
    case "RATE_LIMITED":
      return "wait for the provider rate limit to reset, then retry";
    case "SERVER_UNAVAILABLE":
      return "retry when the provider is available";
    case "HOST_UNREACHABLE":
      return "run the same `ravi pages` command on the host, or retry after the host CLI gateway socket is available";
    case "CLOUD_PUBLISH_NOT_IMPLEMENTED":
      return "use a supported publish path";
    case "CONTACT_REQUIRED":
      return "ask the person to send the request from their own account in a routed chat; ravi link never takes a contact flag";
    case "ACTOR_BINDING_CONFLICT":
      return "run `ravi unlink` from the linked person's chat, or have them revoke it on the Console /link page, then retry";
    case "LOCAL_INSTALLATION_MISSING":
    case "INSTALLATION_MISMATCH":
      return "run 'ravi login' on the daemon host, then retry";
    case "LINK_APPROVAL_REQUIRED":
      return "run `ravi link` from the person's chat turn; Ravi sends them a private approval link";
    case "LINK_REQUESTS_UNAVAILABLE":
      return "update Ravi Console to a version with link approval requests, then retry";
    case "LINK_DM_UNSUPPORTED":
      return "ask the person to run the request on Slack or WhatsApp, where Ravi can message them privately";
    case "LINK_DM_FAILED":
      return "ask the person to open a direct conversation with the bot, then retry";
    case "NOT_FOUND":
      return "check the id or slug against the parent listing, then retry";
    case "CONFLICT":
      return "re-read the resource, resolve the conflict, then retry";
    case "VERSION_CONFLICT":
      return "re-read the resource and retry with its current version";
    case "CONNECTOR_GROUP_BLOCKED":
      return "say in the group that you will answer privately, and ask the owner to repeat the request in their direct chat with you";
    case "CONNECTOR_SPEAKER_NOT_OWNER":
      return "tell the person you cannot use the owner's account for their request; do not retry with another flag or connector";
    case "CONNECTOR_DISABLED_BY_ORG":
      return "ask an organization owner or admin to turn the connector on in Console";
    case "CONNECTOR_TOOL_BLOCKED":
      return "the owner can change this tool's policy on the Console Connectors page; do not retry as is";
    case "CONNECTOR_APPROVAL_REQUIRED":
      return "send the approval link to the account owner privately, never in a group, then re-run the same command with --approval <id> after they approve";
    case "CONNECTOR_APPROVAL_PENDING":
      return "wait for the account owner to decide, then re-run the same command with the same --approval <id>";
    case "CONNECTOR_APPROVAL_DENIED":
      return "do not retry; tell the person the account owner declined, so it was not done";
    case "CONNECTOR_APPROVAL_INVALID":
      return "run the same command again without --approval to ask for a new approval";
    case "CONNECTOR_CONSENT_REQUIRED":
      return "send the consent link to that person privately, then retry after they approve";
    case "CONNECTOR_NOT_LINKED":
      return "run `ravi link` from the person's own chat turn; Ravi sends them a private approval link";
    case "CONNECTOR_CONNECTION_REQUIRED":
      return "ask the person to connect an account on the Console Connectors page";
    case "CONNECTOR_REAUTH_REQUIRED":
      return "tell the account owner privately to reconnect it on the Console Connectors page";
    case "CONNECTOR_PERMISSION_REQUIRED":
      return "tell the account owner privately to allow writing, or reconnect, on the Console Connectors page; do not retry as is";
    case "CONNECTOR_POLICY_ABOVE_CEILING":
      return "pick a stricter policy, or ask an organization owner or admin to raise the limit";
    case "CONNECTOR_FORBIDDEN":
      return "ask the connection's owner to make this change";
  }
}

function safeDomainSetupMessage(message: string): string {
  const sanitized = stripVTControlCharacters(message)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!sanitized) return "Ravi Pages domain setup requires an external DNS action.";
  return sanitized.length > 4096 ? `${sanitized.slice(0, 4093)}...` : sanitized;
}

function isCloudAuthErrorCode(code: string): code is CloudAuthError["code"] {
  return (CLOUD_AUTH_ERROR_CODES as readonly string[]).includes(code);
}
