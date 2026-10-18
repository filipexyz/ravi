import { describe, expect, it } from "bun:test";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { toKnowledgeContractError } from "./errors.js";

describe("knowledge contract errors", () => {
  it("TURN_NOT_OPERATOR and DISABLED exit 3 with one issue line", () => {
    for (const code of ["KNOWLEDGE_TURN_NOT_OPERATOR", "KNOWLEDGE_DISABLED"] as const) {
      const error = toKnowledgeContractError("knowledge.search", new CloudAuthError(code, "denied", { status: 403 }));
      expect(error.code).toBe(code);
      expect(error.exitCode).toBe(3);
      expect(error.envelope().error.issues).toHaveLength(1);
    }
  });

  it("PAYLOAD_INVALID exits 2", () => {
    const error = toKnowledgeContractError("knowledge.read", new CloudAuthError("PAYLOAD_INVALID", "bad ref"));
    expect(error.code).toBe("PAYLOAD_INVALID");
    expect(error.exitCode).toBe(2);
  });

  it("NOT_FOUND exits 1 as KNOWLEDGE_NOT_FOUND", () => {
    const error = toKnowledgeContractError(
      "knowledge.read",
      new CloudAuthError("NOT_FOUND", "missing", { status: 404 }),
    );
    expect(error.code).toBe("KNOWLEDGE_NOT_FOUND");
    expect(error.exitCode).toBe(1);
  });

  it("unavailable codes exit 1 as KNOWLEDGE_CONSOLE_UNAVAILABLE", () => {
    for (const code of ["KNOWLEDGE_UNAVAILABLE", "SERVER_UNAVAILABLE", "HOST_UNREACHABLE"] as const) {
      const error = toKnowledgeContractError("knowledge.sources", new CloudAuthError(code, "down"));
      expect(error.code).toBe("KNOWLEDGE_CONSOLE_UNAVAILABLE");
      expect(error.exitCode).toBe(1);
      expect(error.details.cause).toBe(code);
    }
  });

  it("other cloud errors keep the cloud mapping", () => {
    const error = toKnowledgeContractError("knowledge.search", new CloudAuthError("AUTH_REQUIRED", "login"));
    expect(error.code).toBe("AUTH_REQUIRED");
    expect(error.exitCode).toBe(1);
  });
});
