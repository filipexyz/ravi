import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SlackCommands } from "../../cli/commands/slack.js";
import { remoteGatewayErrorToContractError } from "../../cli/remote-gateway.js";
import { buildRegistry } from "../../cli/registry-snapshot.js";
import type { ContextCapability, ContextRecord } from "../../router/router-db.js";
import { dispatch } from "./dispatcher.js";

const registry = buildRegistry([SlackCommands]);

function slackCommand(fullName: string) {
  const command = registry.commands.find((candidate) => candidate.fullName === fullName);
  if (!command) throw new Error(`${fullName} is missing from the registry`);
  return command;
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function slackContext(): ContextRecord {
  const capabilities: ContextCapability[] = [
    { permission: "execute", objectType: "group", objectId: "slack", source: "test" },
  ];
  return {
    contextId: "ctx_slack_blocks",
    contextKey: "rctx_slack_blocks",
    kind: "test-runtime",
    agentId: "slack-agent",
    capabilities,
    metadata: { authorityMode: "delegated" },
    createdAt: Date.now(),
  };
}

async function remoteError(fullName: string, op: string, body: Record<string, unknown>, cwd: string) {
  const result = await dispatch(slackCommand(fullName), body, {}, { contextRecord: slackContext(), cwd });
  const status = result.response.status;
  const error = remoteGatewayErrorToContractError(op, {
    status,
    ok: false,
    body: await result.response.text(),
    contentType: result.response.headers.get("content-type"),
  });
  return { status, error };
}

describe("remote slack Block Kit payload files", () => {
  it("reports a missing relative payload as a usage error, not an opaque HTTP 500", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ravi-slack-blocks-missing-"));
    tempDirs.push(cwd);

    for (const [fullName, op, body] of [
      ["slack.blocks-validate", "slack blocks-validate", { file: "./message.json" }],
      ["slack.blocks-send", "slack blocks-send", { channel: "C123", file: "./message.json", execute: true }],
    ] as const) {
      const { status, error } = await remoteError(fullName, op, { ...body }, cwd);
      expect(status).toBe(400);
      expect(error).toMatchObject({ code: "PAYLOAD_INVALID", exitCode: 2 });
      expect(error?.message).toContain("Invalid payload file: could not read ./message.json");
    }
  });

  it("reads the payload relative to the caller cwd and reports malformed JSON as a usage error", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ravi-slack-blocks-malformed-"));
    tempDirs.push(cwd);
    await writeFile(join(cwd, "message.json"), "{ not json");

    const { status, error } = await remoteError(
      "slack.blocks-validate",
      "slack blocks-validate",
      { file: "./message.json" },
      cwd,
    );
    expect(status).toBe(400);
    expect(error).toMatchObject({ code: "PAYLOAD_INVALID", exitCode: 2 });
    expect(error?.message).toContain("Invalid Block Kit JSON");
  });
});
