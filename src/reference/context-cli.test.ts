import { describe, expect, it } from "bun:test";
import { createReferenceContextCli, extractJsonObject, type ReferenceCliRunner } from "./context-cli.js";

describe("reference context cli", () => {
  it("extracts the first balanced JSON object from mixed ravi output", () => {
    const parsed = extractJsonObject(
      [
        "\u001b[32mINFO\u001b[0m connecting",
        "{",
        '  "contextId": "ctx_123",',
        '  "allowed": true',
        "}",
        "INFO closed",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      contextId: "ctx_123",
      allowed: true,
    });
  });

  it("probes daemon status through whoami + authorize + action", () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const cli = createReferenceContextCli({
      env: { RAVI_CONTEXT_KEY: "rctx_child_123" },
      raviBin: "bun",
      raviArgs: ["src/cli/index.ts"],
      run: ((cmd: string, args: string[]) => {
        calls.push({ cmd, args });

        if (args.join(" ") === "src/cli/index.ts context whoami") {
          return {
            status: 0,
            stdout: JSON.stringify({
              contextId: "ctx_child_123",
              kind: "cli-runtime",
              sessionName: "dev",
              createdAt: 1,
              capabilitiesCount: 0,
            }),
            stderr: "",
          };
        }

        if (args.join(" ") === "src/cli/index.ts context authorize execute group daemon") {
          return {
            status: 0,
            stdout: JSON.stringify({
              contextId: "ctx_child_123",
              permission: "execute",
              objectType: "group",
              objectId: "daemon",
              allowed: true,
              approved: false,
              inherited: true,
              capabilitiesCount: 1,
            }),
            stderr: "",
          };
        }

        if (args.join(" ") === "src/cli/index.ts daemon status") {
          return {
            status: 0,
            stdout: "Ravi Daemon Status\n  ravi: online",
            stderr: "",
          };
        }

        return {
          status: 1,
          stdout: "",
          stderr: `unexpected args: ${args.join(" ")}`,
        };
      }) as ReferenceCliRunner,
    });

    expect(cli.probeDaemon()).toEqual({
      context: {
        contextId: "ctx_child_123",
        kind: "cli-runtime",
        sessionName: "dev",
        createdAt: 1,
        capabilitiesCount: 0,
      },
      authorization: {
        contextId: "ctx_child_123",
        permission: "execute",
        objectType: "group",
        objectId: "daemon",
        allowed: true,
        approved: false,
        inherited: true,
        capabilitiesCount: 1,
      },
      daemonStatus: "Ravi Daemon Status\n  ravi: online",
    });

    expect(calls.map((call) => `${call.cmd} ${call.args.join(" ")}`)).toEqual([
      "bun src/cli/index.ts context whoami",
      "bun src/cli/index.ts context authorize execute group daemon",
      "bun src/cli/index.ts daemon status",
    ]);
  });

  it("fails fast when the context key is missing", () => {
    const cli = createReferenceContextCli({
      env: {},
    });

    expect(() => cli.whoami()).toThrow("Missing RAVI_CONTEXT_KEY");
  });
});
