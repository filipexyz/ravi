import { describe, expect, it } from "bun:test";
import {
  ContractError,
  GENERIC_COMMAND_FAILED_MESSAGE,
  expectedErrorToContractError,
  mapExecutionErrorToContractError,
  publicContractMessage,
  sanitizePublicContractMessage,
} from "./agent-contract.js";
import { CliExpectedError } from "./expected-error.js";

describe("publicContractMessage", () => {
  it("preserves a sanitized COMMAND_FAILED cause instead of replacing it", () => {
    const cause = "CLI/runtime mismatch detected. Pass --allow-runtime-mismatch if you really mean it.";
    expect(publicContractMessage("COMMAND_FAILED", cause)).toBe(cause);
    expect(
      new ContractError("instances routes add", "COMMAND_FAILED", cause, 1).envelope().error.message,
    ).toBe(cause);
  });

  it("uses the generic headline only when the cause is empty", () => {
    expect(publicContractMessage("COMMAND_FAILED", "")).toBe(GENERIC_COMMAND_FAILED_MESSAGE);
    expect(publicContractMessage("COMMAND_FAILED", "   \n")).toBe(GENERIC_COMMAND_FAILED_MESSAGE);
    expect(sanitizePublicContractMessage("")).toBeUndefined();
    expect(sanitizePublicContractMessage("   ")).toBeUndefined();
  });

  it("uses the generic headline only when the cause is unsafe", () => {
    expect(publicContractMessage("COMMAND_FAILED", "PRIVATE_EXPECTED_MESSAGE_7M4Q")).toBe(
      GENERIC_COMMAND_FAILED_MESSAGE,
    );
    expect(publicContractMessage("COMMAND_FAILED", "leak sk-ant-abcdefghijklmnopqrstuv")).toBe(
      GENERIC_COMMAND_FAILED_MESSAGE,
    );
    expect(publicContractMessage("COMMAND_FAILED", "/tmp/secret-config.json")).toBe(
      GENERIC_COMMAND_FAILED_MESSAGE,
    );
    expect(sanitizePublicContractMessage("SENTINEL_SECRET_7M4Q")).toBeUndefined();
  });

  it("redacts an embedded absolute path but keeps the surrounding cause", () => {
    expect(publicContractMessage("COMMAND_FAILED", "Cannot read file /tmp/secret-config.json")).toBe(
      "Cannot read file [REDACTED:path]",
    );
  });

  it("does not rewrite non-COMMAND_FAILED codes", () => {
    expect(publicContractMessage("USAGE_ERROR", "Provide text or --text-file.")).toBe(
      "Provide text or --text-file.",
    );
    expect(publicContractMessage("SESSION_NOT_FOUND", "Session not found: main")).toBe(
      "Session not found: main",
    );
  });
});

describe("expectedErrorToContractError", () => {
  it("preserves the default COMMAND_FAILED code and the expected message", () => {
    const error = new CliExpectedError(
      "--text-file must not contain '..' path segments.",
    );
    expect(error.code).toBe("COMMAND_FAILED");

    const contract = expectedErrorToContractError("audio generate", error);
    expect(contract).toMatchObject({
      op: "audio generate",
      code: "COMMAND_FAILED",
      message: "--text-file must not contain '..' path segments.",
      exitCode: 1,
    });
    expect(contract?.envelope().error).toMatchObject({
      code: "COMMAND_FAILED",
      message: "--text-file must not contain '..' path segments.",
      suggestedAction: "Inspect the command input and retry 'audio generate'",
    });
  });

  it("preserves an explicit code without renaming it to COMMAND_FAILED", () => {
    const contract = expectedErrorToContractError(
      "cloud fixture custom",
      new CliExpectedError("Watch provider request failed.", "WATCH_PROVIDER_FAILED", 1),
    );
    expect(contract).toMatchObject({
      code: "WATCH_PROVIDER_FAILED",
      message: "Watch provider request failed.",
      exitCode: 1,
    });
    expect(contract?.envelope().error.message).toBe("Watch provider request failed.");
  });

  it("preserves a throw-site suggestedAction such as --allow-runtime-mismatch", () => {
    const suggestedAction =
      "Re-run with the repo CLI/runtime or pass --allow-runtime-mismatch if you really mean it.";
    const contract = expectedErrorToContractError(
      "instances routes add",
      new CliExpectedError(
        `CLI/runtime mismatch detected.\nTarget instance: main\n${suggestedAction}`,
        "COMMAND_FAILED",
        1,
        suggestedAction,
      ),
    );

    expect(contract?.code).toBe("COMMAND_FAILED");
    expect(contract?.envelope().error.message).toContain("CLI/runtime mismatch detected.");
    expect(contract?.envelope().error.message).toContain("--allow-runtime-mismatch");
    expect(contract?.envelope().error.suggestedAction).toBe(suggestedAction);
  });

  it("uses the generic message and action only when the expected copy is empty or unsafe", () => {
    const empty = expectedErrorToContractError("sessions runtime list", new CliExpectedError(""));
    const unsafe = expectedErrorToContractError(
      "sessions runtime list",
      new CliExpectedError("PRIVATE_DAEMON_BODY_8K2R", "COMMAND_FAILED", 1, "PRIVATE_NEXT_STEP_8K2R"),
    );

    expect(empty?.envelope().error).toMatchObject({
      code: "COMMAND_FAILED",
      message: GENERIC_COMMAND_FAILED_MESSAGE,
      suggestedAction: "Inspect the command input and retry 'sessions runtime list'",
    });
    expect(unsafe?.envelope().error).toMatchObject({
      code: "COMMAND_FAILED",
      message: GENERIC_COMMAND_FAILED_MESSAGE,
      suggestedAction: "Inspect the command input and retry 'sessions runtime list'",
    });
    expect(JSON.stringify(unsafe?.envelope())).not.toContain("PRIVATE_DAEMON_BODY_8K2R");
    expect(JSON.stringify(unsafe?.envelope())).not.toContain("PRIVATE_NEXT_STEP_8K2R");
  });
});

describe("CliExpectedError default code", () => {
  it("defaults to COMMAND_FAILED and still surfaces a safe fail() message", () => {
    const error = new CliExpectedError("Agent not found: ghost. Pass --create-agent to create it.");
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.suggestedAction).toBeUndefined();

    const contract = mapExecutionErrorToContractError("whatsapp group create", error);
    expect(contract.code).toBe("COMMAND_FAILED");
    expect(contract.envelope().error.message).toBe(
      "Agent not found: ghost. Pass --create-agent to create it.",
    );
  });
});
