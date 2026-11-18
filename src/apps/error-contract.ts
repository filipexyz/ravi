import { errorDiagnostic } from "../utils/error-diagnostic.js";
import {
  ContractError,
  CONTRACT_EXIT_ERROR,
  contractDryRun,
  contractFail,
  renderContractError,
} from "../cli/agent-contract.js";
import { RaviAppError, type RaviAppRunResult } from "./types.js";

const APP_OPERATION_FAILED_HEADLINE = "Ravi app operation failed";
const APP_OPERATION_FAILED_MESSAGE = `${APP_OPERATION_FAILED_HEADLINE}.`;
/** The next step when the CLI named a reason and gave none of its own. */
const REPORTED_CAUSE_ACTION = "Resolve the reported cause and retry";
/** The next step when the CLI said nothing, so there is no reported cause to resolve. */
const NO_REASON_ACTION = "Inspect redacted runtime logs and retry";

export function raviAppErrorToContractError(op: string, error: RaviAppError): ContractError {
  const message = error.code === "not_found" ? "Ravi app was not found." : "Ravi app already exists.";
  const suggestedAction =
    error.code === "not_found"
      ? "Verify the app identifier and retry"
      : "Inspect the existing app before retrying with a different identifier";
  return new ContractError(op, error.code, message, CONTRACT_EXIT_ERROR, {
    ...errorDiagnostic(error, { operation: op }),
    ...{ suggestedAction },
  });
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
      ...{
        asJson,
        details: { suggestedAction: "Verify the app identifier and retry" },
      },
      diagnostic: errorDiagnostic("Ravi app was not found.", { operation: "apps run" }),
    });
  }

  if (result.errorCode === "PERMISSION_DENIED") {
    contractFail("apps run", "PERMISSION_DENIED", "Ravi app operation was denied.", {
      ...{
        asJson,
        details: { suggestedAction: "Request the required app permission and retry" },
      },
      diagnostic: errorDiagnostic("Ravi app operation was denied.", { operation: "apps run" }),
    });
  }

  if (result.errorCode === "APP_PERMISSION_PROVIDER_FAILED") {
    contractFail("apps run", "APP_PERMISSION_PROVIDER_FAILED", "Ravi app permission provider failed.", {
      ...{
        asJson,
        details: { retryable: true, suggestedAction: "Inspect provider health and retry" },
      },
      diagnostic: errorDiagnostic("Ravi app permission provider failed.", { operation: "apps run" }),
    });
  }

  const failure = result.failure;
  // A CLI that ran and failed explains itself through the projection the router kept (never its raw output):
  // the headline names the app's message, the cause carries the redacted explanation, `context.code` the app's
  // own error code, and `appExitCode` its exit status. The contract code and exit stay the router's.
  contractFail(
    "apps run",
    result.errorCode ?? "APP_OPERATION_FAILED",
    failure?.message ? `${APP_OPERATION_FAILED_HEADLINE}: ${failure.message}` : APP_OPERATION_FAILED_MESSAGE,
    {
      ...{
        asJson,
        details: {
          suggestedAction:
            failure?.suggestedAction ??
            (failure && failure.source !== "none" ? REPORTED_CAUSE_ACTION : NO_REASON_ACTION),
          ...(failure?.retryable !== undefined ? { retryable: failure.retryable } : {}),
          ...(failure && failure.exitCode !== null ? { appExitCode: failure.exitCode } : {}),
        },
      },
      diagnostic: errorDiagnostic(failure?.cause ?? APP_OPERATION_FAILED_MESSAGE, {
        operation: "apps run",
        ...(failure?.code ? { code: failure.code } : {}),
      }),
    },
  );
}
