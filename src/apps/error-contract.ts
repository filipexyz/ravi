import {
  ContractError,
  CONTRACT_EXIT_ERROR,
  contractDryRun,
  contractFail,
  renderContractError,
} from "../cli/agent-contract.js";
import { RaviAppError, type RaviAppRunResult } from "./types.js";

export function raviAppErrorToContractError(op: string, error: RaviAppError): ContractError {
  const message = error.code === "not_found" ? "Ravi app was not found." : "Ravi app already exists.";
  const suggestedAction =
    error.code === "not_found"
      ? "Verify the app identifier and retry"
      : "Inspect the existing app before retrying with a different identifier";
  return new ContractError(op, error.code, message, CONTRACT_EXIT_ERROR, { suggestedAction });
}

export function throwRaviAppContractError(op: string, error: RaviAppError, asJson: boolean | undefined): never {
  const contractError = raviAppErrorToContractError(op, error);
  renderContractError(contractError, asJson);
  throw contractError;
}

export function enforceRaviAppRunResult(result: RaviAppRunResult, asJson: boolean | undefined): RaviAppRunResult {
  if (result.ok) return result;

  if (result.status === "blocked" && result.plan) {
    contractDryRun("apps run", result.plan, { asJson });
  }

  if (result.errorCode === "not_found") {
    contractFail("apps run", "not_found", "Ravi app was not found.", {
      asJson,
      details: { suggestedAction: "Verify the app identifier and retry" },
    });
  }

  if (result.errorCode === "PERMISSION_DENIED") {
    contractFail("apps run", "PERMISSION_DENIED", "Ravi app operation was denied.", {
      asJson,
      details: { suggestedAction: "Request the required app permission and retry" },
    });
  }

  if (result.errorCode === "APP_PERMISSION_PROVIDER_FAILED") {
    contractFail("apps run", "APP_PERMISSION_PROVIDER_FAILED", "Ravi app permission provider failed.", {
      asJson,
      details: { retryable: true, suggestedAction: "Inspect provider health and retry" },
    });
  }

  contractFail("apps run", result.errorCode ?? "APP_OPERATION_FAILED", "Ravi app operation failed.", {
    asJson,
    details: { suggestedAction: "Inspect redacted runtime logs and retry" },
  });
}
