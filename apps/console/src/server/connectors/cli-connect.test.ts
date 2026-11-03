import { describe, expect, test } from "bun:test";

import type { CliAuthContext } from "@/server/cli/auth";
import { CliApiError } from "@/server/cli/errors";

import { cliErrorFromConnector, startCliConnect } from "./cli-connect";
import { ConsoleConnectorClientError } from "./console-client";

function workerError(status: number, code: string) {
  return new ConsoleConnectorClientError(status, code, "worker said no");
}

describe("CLI connect start", () => {
  test("rejects a body without a provider before anything else", async () => {
    const error = await startCliConnect({ auth: {} as CliAuthContext, body: { projectId: "p" } }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CliApiError);
    expect(error).toMatchObject({ code: "PAYLOAD_INVALID", status: 400 });
  });

  test("a name over the Worker's 120 characters is refused before anything else", async () => {
    const error = await startCliConnect({
      auth: {} as CliAuthContext,
      body: { displayName: "x".repeat(121), provider: "google" },
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PAYLOAD_INVALID", status: 400 });
  });

  test("a Worker that refuses the Console's signature is unavailable to the CLI", () => {
    expect(cliErrorFromConnector(workerError(401, "connector_unauthorized"))).toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 503,
    });
  });

  test("maps Worker codes to CLI codes with fixed messages", () => {
    expect(cliErrorFromConnector(workerError(403, "connector_disabled_by_org"))).toMatchObject({
      code: "CONNECTOR_DISABLED_BY_ORG",
      status: 403,
    });
    expect(cliErrorFromConnector(workerError(503, "server_not_configured"))).toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 503,
    });
    expect(cliErrorFromConnector(workerError(400, "payload_invalid"))).toMatchObject({ code: "PAYLOAD_INVALID" });
    expect(cliErrorFromConnector(workerError(404, "connector_unavailable"))).toMatchObject({ code: "NOT_FOUND" });
    expect(cliErrorFromConnector(workerError(403, "connector_forbidden"))).toMatchObject({ code: "ORG_ACCESS_DENIED" });
    expect(cliErrorFromConnector(workerError(429, "connector_rate_limited"))).toMatchObject({ code: "RATE_LIMITED" });
    expect(cliErrorFromConnector(workerError(502, "internal_error"))).toMatchObject({ code: "SERVER_UNAVAILABLE" });
    for (const status of [400, 403, 404, 502]) {
      expect((cliErrorFromConnector(workerError(status, "x")) as CliApiError).message).not.toContain("worker said no");
    }
    const other = new Error("boom");
    expect(cliErrorFromConnector(other)).toBe(other);
  });
});
