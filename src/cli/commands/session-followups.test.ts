import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { runWithContext } from "../context.js";
import { SessionFollowupCommands } from "./session-followups.js";

let stateDir: string | null = null;

beforeEach(async () => {
  stateDir = await createIsolatedRaviState("ravi-session-followups-cli-");
});

afterEach(async () => {
  await cleanupIsolatedRaviState(stateDir);
  stateDir = null;
});

describe("sessions followups cli", () => {
  it("creates and lists followups as JSON", () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    try {
      const commands = new SessionFollowupCommands();
      const created = commands.add(
        "CLI check",
        "main",
        undefined,
        undefined,
        "30m",
        undefined,
        undefined,
        undefined,
        undefined,
        "Review this session.",
        undefined,
        "system:test",
        undefined,
        undefined,
        true,
      ) as {
        followup: {
          id: string;
          targetType: string;
          schedule: { type: string; steps: Array<{ afterMs: number; messageTemplate: string }> };
        };
      };
      expect(created.followup.targetType).toBe("session");
      expect(created.followup.schedule.type).toBe("every");
      expect(created.followup.schedule.steps).toEqual([
        { afterMs: 30 * 60 * 1000, messageTemplate: "Review this session." },
      ]);

      logs.length = 0;
      const listed = commands.list(undefined, undefined, undefined, undefined, true) as unknown as {
        total: number;
        items: Array<{ id: string; name: string }>;
      };
      expect(listed.total).toBe(1);
      expect(listed.items[0]?.id).toBe(created.followup.id);
      const parsed = JSON.parse(logs.join("\n")) as { total: number; items: Array<{ name: string }> };
      expect(parsed.total).toBe(1);
      expect(parsed.items[0]?.name).toBe("CLI check");
    } finally {
      log.mockRestore();
    }
  });

  it("creates progressive idle steps from --step specs", () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    try {
      const commands = new SessionFollowupCommands();
      const created = commands.add(
        "CLI progressive",
        "main",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["2h=Primeiro followup.", "3h=Segundo followup."],
        undefined,
        undefined,
        "system:test",
        undefined,
        undefined,
        true,
      ) as { followup: { schedule: { steps: Array<{ afterMs: number; messageTemplate: string }> } } };

      expect(created.followup.schedule.steps).toEqual([
        { afterMs: 2 * 60 * 60 * 1000, messageTemplate: "Primeiro followup." },
        { afterMs: 3 * 60 * 60 * 1000, messageTemplate: "Segundo followup." },
      ]);
      const parsed = JSON.parse(logs.join("\n")) as { followup: { steps: unknown[] } };
      expect(parsed.followup.steps).toHaveLength(2);
    } finally {
      log.mockRestore();
    }
  });

  it("updates followup steps in place", () => {
    const logs: string[] = [];
    const log = spyOn(console, "log").mockImplementation((value: unknown) => {
      logs.push(String(value));
    });
    try {
      const commands = new SessionFollowupCommands();
      const created = commands.add(
        "CLI editable",
        "main",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["15m=Primeiro."],
        undefined,
        undefined,
        "system:test",
        undefined,
        undefined,
        true,
      ) as {
        followup: {
          id: string;
          createdAt: number;
          nextRunAt: number;
          schedule: { steps: Array<{ afterMs: number; messageTemplate: string }> };
        };
      };

      logs.length = 0;
      const updated = commands.update(
        created.followup.id,
        undefined,
        undefined,
        undefined,
        undefined,
        ["15m=Primeiro.", "30m=Estude o próximo passo relevante."],
        undefined,
        true,
      ) as {
        followup: {
          id: string;
          createdAt: number;
          nextRunAt: number;
          schedule: { steps: Array<{ afterMs: number; messageTemplate: string }> };
        };
      };

      expect(updated.followup.id).toBe(created.followup.id);
      expect(updated.followup.createdAt).toBe(created.followup.createdAt);
      expect(updated.followup.nextRunAt).toBe(created.followup.nextRunAt);
      expect(updated.followup.schedule.steps).toEqual([
        { afterMs: 15 * 60 * 1000, messageTemplate: "Primeiro." },
        { afterMs: 30 * 60 * 1000, messageTemplate: "Estude o próximo passo relevante." },
      ]);
      const parsed = JSON.parse(logs.join("\n")) as { followup: { id: string; steps: unknown[] } };
      expect(parsed.followup.id).toBe(created.followup.id);
      expect(parsed.followup.steps).toHaveLength(2);
    } finally {
      log.mockRestore();
    }
  });

  it("updates a single-step followup message in place", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const commands = new SessionFollowupCommands();
      const created = commands.add(
        "CLI single editable",
        "main",
        undefined,
        undefined,
        "15m",
        undefined,
        undefined,
        undefined,
        undefined,
        "Mensagem antiga.",
        undefined,
        "system:test",
        undefined,
        undefined,
        true,
      ) as {
        followup: {
          id: string;
          nextRunAt: number;
        };
      };

      const updated = commands.update(
        created.followup.id,
        undefined,
        undefined,
        "Mensagem nova.",
        undefined,
        undefined,
        undefined,
        true,
      ) as {
        followup: {
          id: string;
          messageTemplate: string;
          nextRunAt: number;
          schedule: { steps: Array<{ afterMs: number; messageTemplate: string }> };
        };
      };

      expect(updated.followup.id).toBe(created.followup.id);
      expect(updated.followup.nextRunAt).toBe(created.followup.nextRunAt);
      expect(updated.followup.messageTemplate).toBe("Mensagem nova.");
      expect(updated.followup.schedule.steps).toEqual([{ afterMs: 15 * 60 * 1000, messageTemplate: "Mensagem nova." }]);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects --message-only updates for progressive followups", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const commands = new SessionFollowupCommands();
      const created = commands.add(
        "CLI progressive guarded",
        "main",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ["15m=Primeiro.", "30m=Segundo."],
        undefined,
        undefined,
        "system:test",
        undefined,
        undefined,
        true,
      ) as { followup: { id: string } };

      expect(() =>
        runWithContext({ sessionName: "test" }, () =>
          commands.update(
            created.followup.id,
            undefined,
            undefined,
            "Nova mensagem ambigua.",
            undefined,
            undefined,
            undefined,
            true,
          ),
        ),
      ).toThrow("Use --step to replace progressive followup messages.");
    } finally {
      log.mockRestore();
    }
  });
});
