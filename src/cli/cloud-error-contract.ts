import { CloudAuthError } from "../cloud-auth/errors.js";
import { ContractError, CONTRACT_EXIT_ERROR, CONTRACT_EXIT_USAGE } from "./agent-contract.js";
import { getContext } from "./context.js";

const RETRYABLE_CODES = new Set(["AUTH_PENDING", "RATE_LIMITED", "SERVER_UNAVAILABLE"]);

export function commandOperation(group: string, command: string): string {
  if (group === "_root") return command;
  return `${group.replaceAll("_", " ")} ${command}`;
}

/** Map provider/auth failures into the global CLI exit taxonomy without losing their stable code. */
export function cloudErrorToContractError(op: string, error: CloudAuthError): ContractError {
  return new ContractError(
    op,
    error.code,
    error.message,
    error.code === "PAYLOAD_INVALID" ? CONTRACT_EXIT_USAGE : CONTRACT_EXIT_ERROR,
    {
      retryable: RETRYABLE_CODES.has(error.code),
      ...(error.status !== undefined ? { status: error.status } : {}),
      suggestedAction: suggestedAction(error.code),
    },
  );
}

/** Render once for the local CLI. Tools and gateway serialize the returned ContractError themselves. */
export function renderCloudContractError(error: ContractError, asJson: boolean | undefined): void {
  if (getContext()?.suppressCliOutput === true) return;
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
    case "PAYLOAD_INVALID":
      return "correct the command input and retry";
    case "RATE_LIMITED":
      return "wait for the provider rate limit to reset, then retry";
    case "SERVER_UNAVAILABLE":
      return "retry when the provider is available";
    case "CLOUD_PUBLISH_NOT_IMPLEMENTED":
      return "use a supported publish path";
  }
}
