export type CliErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_PENDING"
  | "AUTH_EXPIRED"
  | "INSTALLATION_REVOKED"
  | "ORG_ACCESS_DENIED"
  | "PROJECT_ACCESS_DENIED"
  | "PUBLISH_NOT_ALLOWED"
  | "PUBLISH_COMMENTS_UNREAD"
  | "DOMAIN_SETUP_REQUIRED"
  | "PAYLOAD_INVALID"
  | "RATE_LIMITED"
  | "SERVER_UNAVAILABLE"
  | "WATCH_CAPABILITY_UNAVAILABLE"
  | "INSTALLATION_MISSING"
  | "REPO_NOT_SELECTED"
  | "PROVIDER_PERMISSION_MISSING"
  | "PROVIDER_CONNECTION_UNAVAILABLE"
  | "PROVIDER_RESOURCE_UNAVAILABLE"
  | "WATCH_UNSUPPORTED_EVENT"
  | "WATCH_ALREADY_EXISTS"
  | "WEBHOOK_UNHEALTHY"
  | "INBOX_SUBSCRIPTION_MISSING"
  | "LOCAL_INSTALLATION_REVOKED"
  | "CONFLICT"
  | "NOT_MEMBER"
  | "INSTALLATION_ORG_MISMATCH"
  | "CONTACT_REQUIRED"
  | "NOT_FOUND"
  | "VERSION_CONFLICT"
  | "LOCAL_INSTALLATION_MISSING"
  | "INSTALLATION_MISMATCH"
  | "BOOTSTRAP_TOKEN_INVALID"
  | "BOOTSTRAP_TOKEN_EXPIRED"
  | "BOOTSTRAP_TOKEN_USED"
  | "BOOTSTRAP_TOKEN_REVOKED"
  | "LINK_APPROVAL_REQUIRED"
  | "LINK_REQUEST_INVALID"
  | "LINK_REQUEST_EXPIRED"
  | "LINK_REQUEST_USED"
  | "LINK_USER_MISMATCH"
  | "CONNECTOR_DISABLED_BY_ORG"
  | "PAGE_ACCESS_DENIED"
  | "PAGE_CONTENT_UNSUPPORTED"
  | "ACTOR_NOT_LINKED"
  | "KIT_INVALID"
  | "LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN"
  | "KNOWLEDGE_TURN_NOT_OPERATOR"
  | "KNOWLEDGE_DISABLED"
  | "POLICY_DISABLED"
  | "CALENDAR_SCOPE_MISSING"
  // Cloud agents (spec console/managed-runtime/claude-managed-agents) use lowercase codes.
  | "cloud_agents_unconfigured"
  | "cloud_agents_not_enabled"
  | "cloud_credential_missing"
  | "cloud_credential_invalid"
  | "cloud_agent_definition_invalid"
  | "cloud_agent_provider_unsupported"
  | "cloud_agent_repository_unavailable"
  | "cloud_run_not_active"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "idempotency_conflict"
  | "provider_error";

export type CliErrorPayload = {
  error: {
    code: CliErrorCode;
    message: string;
    requestId: string;
    /** Structured detail for features that need it (Bases: field errors, conflict row). */
    details?: Record<string, unknown>;
  };
};

export class CliApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: CliErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function cliErrorPayload(error: CliApiError, requestId: string): CliErrorPayload {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function cliApiError(
  status: number,
  code: CliErrorCode,
  message = defaultCliErrorMessage(code),
  details?: Record<string, unknown>,
) {
  return new CliApiError(status, code, message, details);
}

function defaultCliErrorMessage(code: CliErrorCode) {
  switch (code) {
    case "AUTH_REQUIRED":
      return "CLI authentication is required.";
    case "AUTH_PENDING":
      return "CLI authentication is still pending.";
    case "AUTH_EXPIRED":
      return "CLI authentication has expired.";
    case "INSTALLATION_REVOKED":
      return "This local Ravi installation has been revoked.";
    case "ORG_ACCESS_DENIED":
      return "Organization access was denied.";
    case "PROJECT_ACCESS_DENIED":
      return "Project access was denied.";
    case "PUBLISH_NOT_ALLOWED":
      return "Artifact publish is not allowed.";
    case "PUBLISH_COMMENTS_UNREAD":
      return "Read unread Ravi Pages comments before publishing.";
    case "DOMAIN_SETUP_REQUIRED":
      return "Ravi Pages domain setup requires an external action.";
    case "PAYLOAD_INVALID":
      return "The request payload is invalid.";
    case "RATE_LIMITED":
      return "Too many requests.";
    case "SERVER_UNAVAILABLE":
      return "CLI authentication is temporarily unavailable.";
    case "WATCH_CAPABILITY_UNAVAILABLE":
      return "This watch capability is not available.";
    case "INSTALLATION_MISSING":
      return "No GitHub account is linked to this organization. Link one in the Console, under Settings, GitHub.";
    case "REPO_NOT_SELECTED":
      return "The repository is not selected for this provider installation.";
    case "PROVIDER_PERMISSION_MISSING":
      return "The provider installation is missing required permissions.";
    case "PROVIDER_CONNECTION_UNAVAILABLE":
      return "The provider connection is unavailable.";
    case "PROVIDER_RESOURCE_UNAVAILABLE":
      return "The provider resource is unavailable.";
    case "WATCH_UNSUPPORTED_EVENT":
      return "This watch event is not supported.";
    case "WATCH_ALREADY_EXISTS":
      return "This watch already exists.";
    case "WEBHOOK_UNHEALTHY":
      return "The provider webhook is unhealthy.";
    case "INBOX_SUBSCRIPTION_MISSING":
      return "A local inbox subscription is required before creating this watch.";
    case "LOCAL_INSTALLATION_REVOKED":
      return "This local Ravi installation has been revoked.";
    case "CONFLICT":
      return "This local contact is already linked to another Console user on this installation.";
    case "NOT_MEMBER":
      return "Organization membership is required for this installation, or the request is not self-only.";
    case "INSTALLATION_ORG_MISMATCH":
      return "The installation does not belong to the supplied organization.";
    case "CONTACT_REQUIRED":
      return "A local contact id is required.";
    case "NOT_FOUND":
      return "The requested resource was not found.";
    case "VERSION_CONFLICT":
      return "The resource changed since it was read.";
    case "LOCAL_INSTALLATION_MISSING":
      return "This local Ravi installation is not registered. Run `ravi login` again.";
    case "INSTALLATION_MISMATCH":
      return "The request targets a different local Ravi installation than this CLI session.";
    case "BOOTSTRAP_TOKEN_INVALID":
      return "This bootstrap token is not valid.";
    case "BOOTSTRAP_TOKEN_EXPIRED":
      return "This bootstrap token has expired. Create a new installation token in the Console.";
    case "BOOTSTRAP_TOKEN_USED":
      return "This bootstrap token was already used. Create a new installation token in the Console.";
    case "BOOTSTRAP_TOKEN_REVOKED":
      return "This bootstrap token was revoked.";
    case "LINK_APPROVAL_REQUIRED":
      return "Linking needs the person's approval. Create a link request; the person approves it in the browser.";
    case "LINK_REQUEST_INVALID":
      return "This link is not valid.";
    case "LINK_REQUEST_EXPIRED":
      return "This link has expired. Ask Ravi for a new one.";
    case "LINK_REQUEST_USED":
      return "This link was already used.";
    case "LINK_USER_MISMATCH":
      return "This link was sent to someone else. Sign in with the account that received it.";
    case "CONNECTOR_DISABLED_BY_ORG":
      return "This connector is turned off for the organization. Ask an owner or admin to turn it on.";
    case "PAGE_ACCESS_DENIED":
      return "This Ravi Page is not readable by this CLI session.";
    case "PAGE_CONTENT_UNSUPPORTED":
      return "This Ravi Page route does not serve readable text.";
    case "ACTOR_NOT_LINKED":
      return "The person asking has not linked their Ravi account here. Send them `ravi link`.";
    case "KIT_INVALID":
      return "The page kit found errors in the page's ravi-* tags or its theme.";
    case "LIBRARY_SCRIPT_REQUIRES_ORG_ADMIN":
      return "Only organization owners and admins publish widgets with widget.js.";
    case "KNOWLEDGE_TURN_NOT_OPERATOR":
      return "Knowledge answers only the operator's own turns: the terminal, the operator's direct chat and the operator's routines.";
    case "KNOWLEDGE_DISABLED":
      return "Knowledge is not enabled for this organization.";
    case "POLICY_DISABLED":
      return "The organization's policy does not allow this.";
    case "CALENDAR_SCOPE_MISSING":
      return "This Google connection cannot read the calendar. Reconnect it with calendar access.";
    case "cloud_agents_unconfigured":
      return "Cloud agents are not configured on this Console.";
    case "cloud_agents_not_enabled":
      return "Cloud agents are not enabled for this organization.";
    case "cloud_credential_missing":
      return "Set the organization's Anthropic API key first (owner or admin).";
    case "cloud_credential_invalid":
      return "The organization's Anthropic API key was rejected. Set a new one.";
    case "cloud_agent_definition_invalid":
      return "The agent definition cannot run in the cloud.";
    case "cloud_agent_provider_unsupported":
      return "The agent's provider or model cannot run on this cloud provider.";
    case "cloud_agent_repository_unavailable":
      return "The repository is not covered by this organization's GitHub installation.";
    case "cloud_run_not_active":
      return "The run is not active.";
    case "forbidden":
      return "This action is not allowed for your role.";
    case "not_found":
      return "The requested resource was not found.";
    case "validation_failed":
      return "The request is invalid.";
    case "idempotency_conflict":
      return "The idempotency key was already used for a different request.";
    case "provider_error":
      return "The cloud provider failed.";
  }
}
