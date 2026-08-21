import { describe, expect, it, spyOn } from "bun:test";
import { expectedErrorToContractError, pickFields, unexpectedErrorToContractError } from "./agent-contract.js";
import { fail } from "./context.js";
import { CliExpectedError } from "./expected-error.js";
import { CliTerminationRequest } from "./process-output.js";

describe("agent-first CLI foundation contract", () => {
  it("preserves explicitly public expected failures with their typed metadata", () => {
    const expected = new CliExpectedError("The requested agent was not found.", "AGENT_NOT_FOUND", 1, {
      publicMessage: true,
      retryable: false,
      suggestedAction: "List agents and retry with an existing id",
      details: { suggestions: ["main"] },
    });

    expect(expectedErrorToContractError("agents show", expected)?.envelope()).toEqual({
      success: false,
      op: "agents show",
      error: {
        code: "AGENT_NOT_FOUND",
        message: "The requested agent was not found.",
        retryable: false,
        suggestedAction: "List agents and retry with an existing id",
        suggestions: ["main"],
      },
    });
  });

  it("keeps legacy expected and unexpected internal messages redacted", () => {
    const legacy = expectedErrorToContractError(
      "agents show",
      new CliExpectedError("PRIVATE_LEGACY_DETAIL", "COMMAND_FAILED", 1),
    );
    const unexpected = unexpectedErrorToContractError("agents show");

    expect(legacy?.envelope().error.message).toBe("Command could not be completed.");
    expect(JSON.stringify(legacy?.envelope())).not.toContain("PRIVATE_LEGACY_DETAIL");
    expect(unexpected.envelope().error).toMatchObject({
      code: "UNHANDLED_ERROR",
      message: "Command failed unexpectedly.",
    });
  });

  it("rejects mixed valid and unknown fields before projecting records", () => {
    let ownKeysCalls = 0;
    const row = new Proxy(
      { id: "main", name: "Main" },
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      },
    );

    let failure: unknown;
    try {
      pickFields([row], "id,unknown", { acceptedFields: ["id", "name"] });
    } catch (error) {
      failure = error;
    }

    expect(ownKeysCalls).toBe(0);
    const contract = expectedErrorToContractError("agents list", failure);
    expect(contract?.exitCode).toBe(2);
    expect(contract?.envelope().error).toMatchObject({
      code: "USAGE_ERROR",
      message: "--fields contains one or more unknown fields.",
      retryable: false,
      acceptedFields: ["id", "name"],
    });
  });

  it("validates fields against the declared set when the result is empty", () => {
    let failure: unknown;
    try {
      pickFields([], "unknown", { acceptedFields: ["id", "name"] });
    } catch (error) {
      failure = error;
    }

    expect(expectedErrorToContractError("agents list", failure)?.envelope().error).toMatchObject({
      code: "USAGE_ERROR",
      acceptedFields: ["id", "name"],
    });
  });

  it("keeps the projection API compatible for callers not migrated yet", () => {
    const rows = pickFields([{ id: "main", name: "Main" }], "id");
    expect(Object.keys(rows[0] ?? {})).toEqual(["id"]);
  });

  it("routes direct legacy fail termination through the top-level flush boundary", () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    let failure: unknown;
    try {
      fail("safe direct failure");
    } catch (error) {
      failure = error;
    } finally {
      consoleError.mockRestore();
    }

    expect(failure).toBeInstanceOf(CliTerminationRequest);
    expect((failure as CliTerminationRequest).exitCode).toBe(1);
  });
});
