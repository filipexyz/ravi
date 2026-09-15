import "reflect-metadata";
import { describe, expect, it, spyOn } from "bun:test";
import { Command as CommanderCommand } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nats } from "../nats.js";
import type { ContextRecord } from "../router/router-db.js";
import { dispatch } from "../sdk/gateway/dispatcher.js";
import { MediaCommands } from "./commands/media.js";
import { runWithContext } from "./context.js";
import { registerCommands } from "./registry.js";
import { buildRegistry } from "./registry-snapshot.js";
import { extractTools } from "./tools-export.js";

const mediaContext: ContextRecord = {
  contextId: "ctx_transport_media_test",
  contextKey: "rctx_transport_media_test",
  kind: "test-runtime",
  agentId: "transport-media-test",
  capabilities: [{ permission: "mutate", objectType: "media", objectId: "send", source: "test" }],
  createdAt: Date.now(),
};

describe("media send audit contract", () => {
  it("redacts media send inputs in the complete CLI, tool and gateway audit payloads", async () => {
    const fileSentinel = "PRIVATE_PATH_MEDIA_5K8R";
    const captionSentinel = "PRIVATE_MESSAGE_MEDIA_8K2R";
    const targetSentinel = "PRIVATE_TARGET_MEDIA_9P3X";
    const accountSentinel = "PRIVATE_ACCOUNT_MEDIA_6F4Q";
    const threadSentinel = "PRIVATE_THREAD_MEDIA_2J7N";
    const dir = mkdtempSync(join(tmpdir(), `${fileSentinel}-`));
    const filePath = join(dir, "sample.png");
    writeFileSync(filePath, "png");

    const emitted: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const emitSpy = spyOn(nats, "emit").mockImplementation(async (topic, payload) => {
      emitted.push({ topic, payload: payload as Record<string, unknown> });
    });
    const closeSpy = spyOn(nats, "close").mockImplementation(async () => {});
    const previousContextKey = process.env.RAVI_CONTEXT_KEY;
    const originalExit = process.exit;
    const originalLog = console.log;
    const originalError = console.error;
    process.env.RAVI_CONTEXT_KEY = mediaContext.contextKey;
    process.exit = ((code?: number) => {
      throw new Error(`__media_audit_exit_${code}__`);
    }) as typeof process.exit;
    console.log = () => {};
    console.error = () => {};

    try {
      const program = new CommanderCommand();
      program.exitOverride();
      registerCommands(program, [MediaCommands]);
      await expect(
        runWithContext({ agentId: mediaContext.agentId, context: mediaContext }, () =>
          program.parseAsync([
            "node",
            "test",
            "media",
            "send",
            filePath,
            "--caption",
            captionSentinel,
            "--channel",
            "whatsapp",
            "--to",
            targetSentinel,
            "--account",
            accountSentinel,
            "--thread-id",
            threadSentinel,
            "--json",
          ]),
        ),
      ).rejects.toThrow("__media_audit_exit_3__");

      const tool = extractTools([MediaCommands]).find((candidate) => candidate.name === "media_send");
      expect(tool).toBeDefined();
      const toolResult = await runWithContext({ agentId: mediaContext.agentId, context: mediaContext }, () =>
        tool!.handler({
          filePath,
          caption: captionSentinel,
          channel: "whatsapp",
          to: targetSentinel,
          account: accountSentinel,
          threadId: threadSentinel,
          json: true,
        }),
      );
      expect(toolResult).toMatchObject({ isError: false, outcome: "blocked", exitCode: 3 });

      const mediaRegistry = buildRegistry([MediaCommands]);
      const command = mediaRegistry.commands.find((candidate) => candidate.fullName === "media.send");
      expect(command).toBeDefined();
      const gatewayAudits: Array<Record<string, unknown>> = [];
      const gatewayResult = await dispatch(
        command!,
        {
          filePath,
          caption: captionSentinel,
          channel: "whatsapp",
          to: targetSentinel,
          account: accountSentinel,
          threadId: threadSentinel,
        },
        {},
        {
          contextRecord: mediaContext,
          emitAudit: (event) => {
            gatewayAudits.push(event as unknown as Record<string, unknown>);
          },
        },
      );
      expect(gatewayResult.response.status).toBe(409);

      const mediaAudits = emitted.filter((event) => event.topic === "ravi._cli.cli.media.send");
      expect(mediaAudits).toHaveLength(2);
      const cliAudit = mediaAudits[0]?.payload;
      const toolAudit = mediaAudits[1]?.payload;
      expect(cliAudit).toBeDefined();
      expect(toolAudit).toBeDefined();
      expect(gatewayAudits).toHaveLength(1);

      for (const audit of [cliAudit!, toolAudit!, gatewayAudits[0]!]) {
        expect(audit.input).toMatchObject({
          filePath: "[REDACTED]",
          caption: `[REDACTED:content length=${captionSentinel.length}]`,
          channel: "whatsapp",
          to: "[REDACTED]",
          account: "[REDACTED]",
          threadId: "[REDACTED]",
        });
        const serialized = JSON.stringify(audit);
        expect(serialized).not.toContain(fileSentinel);
        expect(serialized).not.toContain(captionSentinel);
        expect(serialized).not.toContain(targetSentinel);
        expect(serialized).not.toContain(accountSentinel);
        expect(serialized).not.toContain(threadSentinel);
      }
    } finally {
      process.exit = originalExit;
      console.log = originalLog;
      console.error = originalError;
      if (previousContextKey === undefined) delete process.env.RAVI_CONTEXT_KEY;
      else process.env.RAVI_CONTEXT_KEY = previousContextKey;
      emitSpy.mockRestore();
      closeSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
