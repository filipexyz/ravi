import {
  ContractError,
  CONTRACT_EXIT_ERROR,
  renderContractError,
} from "../cli/agent-contract.js";
import { RaviAppError } from "./types.js";

export function raviAppErrorToContractError(op: string, error: RaviAppError): ContractError {
  const message = error.code === "not_found" ? "Ravi app was not found." : "Ravi app already exists.";
  const suggestedAction =
    error.code === "not_found"
      ? "Verify the app identifier and retry"
      : "Inspect the existing app before retrying with a different identifier";
  return new ContractError(op, error.code, message, CONTRACT_EXIT_ERROR, { suggestedAction });
}

export function throwRaviAppContractError(
  op: string,
  error: RaviAppError,
  asJson: boolean | undefined,
): never {
  const contractError = raviAppErrorToContractError(op, error);
  renderContractError(contractError, asJson);
  throw contractError;
}
