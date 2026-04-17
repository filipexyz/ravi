import { describe, expect, it } from "bun:test";
import { buildCronShowOutput } from "./cron-show-output.js";

describe("buildCronShowOutput", () => {
  it("labels persisted config, runtime snapshot, and derived routing sections", () => {
    const output = buildCronShowOutput(
      {
        id: "cron-1",
        name: "Follow up leads",
        enabled: true,
        schedule: { type: "every", every: 1_800_000 },
        sessionTarget: "main",
        replySession: "agent:main:whatsapp:main:group:123456",
        description: "Reconnect with warm leads",
        deleteAfterRun: false,
        message: "Ping the queue\nShare status",
        nextRunAt: Date.UTC(2026, 3, 11, 15, 0, 0),
        lastRunAt: Date.UTC(2026, 3, 11, 14, 30, 0),
        lastStatus: "ok",
        lastDurationMs: 2500,
        createdAt: Date.UTC(2026, 3, 10, 12, 0, 0),
        updatedAt: Date.UTC(2026, 3, 11, 14, 30, 0),
        accountId: "main",
        agentId: "main",
      },
      "every 30m",
      "main",
      {
        kind: "resolved-session",
        replySession: "agent:main:whatsapp:main:group:123456",
        sessionName: "sales-group",
        source: {
          channel: "whatsapp",
          accountId: "main",
          chatId: "group:123456",
        },
      },
    ).join("\n");

    expect(output).toContain("Schedule:       every 30m  [source=derived freshness=derived-now via=cron-db]");
    expect(output).toContain("Execution: [source=derived freshness=derived-now via=cron-db]");
    expect(output).toContain("Routing: [source=resolver freshness=derived-now via=reply-session]");
    expect(output).toContain("[source=runtime-snapshot freshness=persisted via=cron-runner]");
  });
});
