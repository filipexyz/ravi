import { stripVTControlCharacters } from "node:util";
import { CLOUD_AUTH_ERROR_CODES, CloudAuthError, isRetryableCloudAuthError } from "../cloud-auth/errors.js";
import { ContractError, CONTRACT_EXIT_ERROR, CONTRACT_EXIT_USAGE } from "./agent-contract.js";
import { getContext } from "./context.js";
import { payloadInvalidIssues, sanitizePayloadInvalidMessage } from "./payload-error-message.js";

export function commandOperation(group: string, command: string): string {
  if (group === "_root") return command;
  return `${group.replaceAll("_", " ")} ${command}`;
}

/** Map provider/auth failures into the global CLI exit taxonomy without losing their stable code. */
export function cloudErrorToContractError(op: string, error: CloudAuthError): ContractError {
  const issues = error.code === "PAYLOAD_INVALID" ? payloadInvalidIssues(error.message, error.issues) : error.issues;
  return new ContractError(
    op,
    error.code,
    publicMessage(error.code, error.message),
    error.code === "PAYLOAD_INVALID" ? CONTRACT_EXIT_USAGE : CONTRACT_EXIT_ERROR,
    {
      retryable: isRetryableCloudAuthError(error),
      ...(error.status !== undefined ? { status: error.status } : {}),
      ...(issues ? { issues } : {}),
      suggestedAction: suggestedAction(error.code),
    },
  );
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
