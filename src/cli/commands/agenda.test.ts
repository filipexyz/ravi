import { describe, expect, it } from "bun:test";
import type { ConsoleApiClient } from "../../cloud-auth/client.js";
import { CloudAuthError } from "../../cloud-auth/errors.js";
import type { CloudCredentials } from "../../cloud-auth/types.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import { getCliOnlyMetadata } from "../decorators.js";
import { AgendaCommands } from "./agenda.js";

const EVENT_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

function credentials(): CloudCredentials {
  return {
    consoleUrl: "https://console.ravi.bot",
    accessToken: "access",
    refreshToken: "refresh",
    user: { id: "user-1" },
    organization: { id: "org-1" },
  } as unknown as CloudCredentials;
}

const overview = {
  connections: [
    {
      connectionId: "conn-1",
      email: "luis@example.com",
      displayName: null,
      hasCalendarScope: true,
      settings: {
        syncEnabled: true,
        recordMode: "ask",
        projectId: "proj-1",
        briefingEnabled: null,
        briefingMinutes: 30,
        followupEnabled: null,
      },
      lastSyncedAt: null,
      lastSyncError: null,
    },
  ],
  policy: { autoRecordAllowed: true, canManage: false },
  meetingsEnabled: true,
  projects: [{ id: "proj-1", slug: "ops", name: "Ops" }],
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT_ID,
    connectionId: "conn-1",
    title: "Weekly",
    startAt: "2026-10-21T12:00:00.000Z",
    endAt: "2026-10-21T13:00:00.000Z",
    allDay: false,
    status: "confirmed",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetingCode: "abc-defg-hij",
    attendees: [],
    externalAttendees: false,
    recordDecision: null,
    effectiveRecordMode: "ask",
    recording: null,
    briefing: null,
    ...overrides,
  };
}

function setup(
  operatorTurn: boolean,
  handler: (method: string, path: string, body: unknown) => unknown = (_method, path) =>
    path === "/api/cli/calendar" ? overview : { event: event() },
) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const client = {
    requestJson: async (method: string, path: string, body: unknown) => {
      calls.push({ method, path, body });
      return handler(method, path, body);
    },
  } as unknown as ConsoleApiClient;
  const commands = new AgendaCommands({ calendar: { client, readCredentials: () => credentials(), operatorTurn } });
  return { calls, commands };
}

async function quiet<T>(run: () => Promise<T>): Promise<{ result?: T; error?: ContractError; output: string }> {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { result: await run(), output: lines.join("\n") };
  } catch (error) {
    if (!(error instanceof ContractError)) throw error;
    return { error, output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

describe("agenda", () => {
  it("exposes every command to sessions (all have return schemas)", () => {
    expect([...getCliOnlyMetadata(AgendaCommands)]).toEqual([]);
  });

  it("refuses a turn that is not the operator's own before any Console call", async () => {
    const { calls, commands } = setup(false);
    const { error } = await quiet(() => commands.list(undefined, undefined, undefined, true));
    expect(error?.code).toBe("CALENDAR_ACCESS_DENIED");
    expect(error?.exitCode).toBe(3);
    expect(calls).toEqual([]);
  });

  it("pages the listing", async () => {
    const events = Array.from({ length: 3 }, (_, index) => event({ id: `evt-${index}` }));
    const { commands } = setup(true, () => ({ events, truncated: false }));
    const { result } = await quiet(() => commands.list("7", "2", "1", true));
    expect(result?.events.map((entry) => entry.id)).toEqual(["evt-1", "evt-2"]);
    expect(result?.total).toBe(3);
  });

  it("dry-runs record without --execute and records with it", async () => {
    const { calls, commands } = setup(true);
    const dry = await quiet(() => commands.record(EVENT_ID, undefined, true, false));
    expect(dry.error?.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(dry.error?.exitCode).toBe(3);
    expect(calls.map((call) => call.method)).toEqual(["GET"]);

    const done = await quiet(() => commands.record(EVENT_ID, "ops", true, true));
    expect(done.error).toBeUndefined();
    expect(calls.at(-1)).toEqual({
      method: "POST",
      path: `/api/cli/calendar/events/${EVENT_ID}/decision`,
      body: { decision: "record", projectId: "proj-1" },
    });
  });

  it("skips at once and brakes undoing a skip under automatic recording", async () => {
    const skipped = setup(true);
    await quiet(() => skipped.commands.skip(EVENT_ID, true));
    expect(skipped.calls[0]?.body).toEqual({ decision: "skip" });

    const auto = setup(true, (method) =>
      method === "GET" ? { event: event({ recordDecision: "skip", effectiveRecordMode: "auto" }) } : { event: event() },
    );
    const dry = await quiet(() => auto.commands.undo(EVENT_ID, true, false));
    expect(dry.error?.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(auto.calls.every((call) => call.method === "GET")).toBe(true);

    const ask = setup(true, (method) =>
      method === "GET" ? { event: event({ recordDecision: "skip" }) } : { event: event() },
    );
    await quiet(() => ask.commands.undo(EVENT_ID, true, false));
    expect(ask.calls.at(-1)?.body).toEqual({ decision: null });
  });

  it("brakes --record auto, refuses it while the organization rule is off, and applies other settings at once", async () => {
    const braked = setup(true, () => overview);
    const dry = await quiet(() =>
      braked.commands.settings(undefined, undefined, "auto", undefined, undefined, undefined, undefined, true, false),
    );
    expect(dry.error?.code).toBe("WRITE_REQUIRES_EXECUTE");

    const off = setup(true, () => ({ ...overview, policy: { autoRecordAllowed: false, canManage: false } }));
    const refused = await quiet(() =>
      off.commands.settings(undefined, undefined, "auto", undefined, undefined, undefined, undefined, true, true),
    );
    expect(refused.error?.code).toBe("POLICY_DISABLED");
    expect(refused.error?.exitCode).toBe(3);

    const applied = setup(true, (method) => (method === "GET" ? overview : { connection: overview.connections[0] }));
    await quiet(() =>
      applied.commands.settings("conn-1", undefined, undefined, undefined, "on", "45", "on", true, false),
    );
    expect(applied.calls.at(-1)).toEqual({
      method: "POST",
      path: "/api/cli/calendar/settings",
      body: { connectionId: "conn-1", briefingEnabled: true, briefingMinutes: 45, followupEnabled: true },
    });
  });

  it("names a missing connection with a stable code and at most three suggestions", async () => {
    const many = {
      ...overview,
      connections: Array.from({ length: 5 }, (_, index) => ({
        ...overview.connections[0],
        connectionId: `conn-${index}`,
      })),
    };
    const { commands } = setup(true, () => many);
    const { error } = await quiet(() =>
      commands.settings("nope", "on", undefined, undefined, undefined, undefined, undefined, true, false),
    );
    expect(error?.code).toBe("CALENDAR_CONNECTION_NOT_FOUND");
    expect(error?.exitCode).toBe(1);
    expect((error?.details as { suggestions?: string[] } | undefined)?.suggestions).toEqual([
      "conn-0",
      "conn-1",
      "conn-2",
    ]);
  });

  it("maps the Console's policy refusal to exit 3", async () => {
    const { commands } = setup(true, () => {
      throw new CloudAuthError("ORG_ACCESS_DENIED", "denied", { status: 403, consoleCode: "POLICY_DISABLED" });
    });
    const { error } = await quiet(() => commands.status(true));
    expect(error?.code).toBe("POLICY_DISABLED");
    expect(error?.exitCode).toBe(3);
  });

  it("stores a briefing and refuses an empty one", async () => {
    const { calls, commands } = setup(true);
    await quiet(() => commands.briefing(EVENT_ID, "## Goal\\nClose the deal", undefined, undefined, true));
    expect(calls[0]?.body).toEqual({ markdown: "## Goal\nClose the deal" });

    const empty = await quiet(() => commands.briefing(EVENT_ID, "  ", undefined, undefined, true));
    expect(empty.error?.exitCode).toBe(2);

    const remote = await quiet(() =>
      runWithContext({ transport: "gateway" }, () =>
        commands.briefing(EVENT_ID, undefined, "/etc/hostname", undefined, true),
      ),
    );
    expect(remote.error?.exitCode).toBe(2);
    expect(calls).toHaveLength(1);
  });
});
