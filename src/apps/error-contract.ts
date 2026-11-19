import { errorDiagnostic } from "../utils/error-diagnostic.js";
import {
  ContractError,
  CONTRACT_EXIT_ERROR,
  contractDryRun,
  contractFail,
  renderContractError,
} from "../cli/agent-contract.js";
import { describeUnavailableDependency } from "./composition.js";
import { RaviAppError, type RaviAppRunResult } from "./types.js";

const APP_OPERATION_FAILED_MESSAGE = "Ravi app operation failed.";
/** Ravi's next step when the CLI reported a cause. The app's own next step never takes its place. */
const REPORTED_CAUSE_ACTION = "Resolve the reported cause and retry";
/** Ravi's next step when the CLI said nothing, so there is no reported cause to resolve. */
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

  // Composition (spec apps/router): both refusals happen before any process starts. What they name is validated
  // identifiers and versions from manifests, never an app's own text. The public envelope carries the cause and the
  // next step; the structured list of what is missing stays on the run result (`unavailableDependencies`).
  if (result.errorCode === "APP_DEPENDENCY_UNAVAILABLE") {
    const unavailable = result.unavailableDependencies ?? [];
    contractFail("apps run", "APP_DEPENDENCY_UNAVAILABLE", "Ravi app dependency is unavailable.", {
      ...{
        asJson,
        details: { suggestedAction: "Install or repair the required app, then retry" },
      },
      diagnostic: errorDiagnostic(
        unavailable.length > 0
          ? unavailable.map(describeUnavailableDependency).join(" ")
          : "A service this app requires is unavailable.",
        { operation: "apps run" },
      ),
    });
  }

  if (result.errorCode === "APP_OPERATION_NOT_PROVIDED") {
    contractFail("apps run", "APP_OPERATION_NOT_PROVIDED", "Ravi app operation is not offered to this caller.", {
      ...{
        asJson,
        details: {
          suggestedAction:
            "Call only operations the provider lists under provides, and declare requires for its service",
        },
      },
      diagnostic: errorDiagnostic("Ravi app operation is not offered to this caller.", { operation: "apps run" }),
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
  // A CLI that ran and failed explains itself through the projection the router kept (never its raw output). What it
  // reported is the app's text, so it stays labeled as the app's: the headline and the next step are Ravi's own and
  // never take it. It travels as `appReported` (its message and its next step), `cause` (the redacted explanation),
  // `context.code` (its own error code) and `appExitCode`. The contract code and exit stay the router's.
  // Spec apps/router, "Failed App Output".
  const appReported = {
    ...(failure?.message ? { message: failure.message } : {}),
    ...(failure?.suggestedAction ? { suggestedAction: failure.suggestedAction } : {}),
  };
  contractFail("apps run", result.errorCode ?? "APP_OPERATION_FAILED", APP_OPERATION_FAILED_MESSAGE, {
    ...{
      asJson,
      details: {
        suggestedAction: failure && failure.source !== "none" ? REPORTED_CAUSE_ACTION : NO_REASON_ACTION,
        ...(failure?.retryable !== undefined ? { retryable: failure.retryable } : {}),
        ...(failure && failure.exitCode !== null ? { appExitCode: failure.exitCode } : {}),
        ...(Object.keys(appReported).length > 0 ? { appReported } : {}),
      },
    },
    diagnostic: errorDiagnostic(failure?.cause ?? APP_OPERATION_FAILED_MESSAGE, {
      operation: "apps run",
      ...(failure?.code ? { code: failure.code } : {}),
    }),
  });
}
