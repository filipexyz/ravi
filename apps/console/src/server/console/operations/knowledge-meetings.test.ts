import { describe, expect, test } from "bun:test";

import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import type { MeetingBotView } from "@/server/console/meetings/service";

import {
  KNOWLEDGE_MEETINGS_OPERATIONS,
  knowledgeMeetingsOperations,
  MEETING_TRANSCRIPT_PAGE_CHARS,
  transcriptPage,
  type KnowledgeMeetingsOperationDeps,
} from "./knowledge-meetings";
import type { OperationActor, OperationHandler } from "./types";

const PROJECT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const MEETING = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const EVENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

function actor(overrides: Partial<OperationActor> = {}): OperationActor {
  return {
    kind: "member",
    organizationId: "org-1",
    userId: "user-1",
    email: "ana@acme.test",
    orgRole: "developer",
    surface: "mcp",
    requestId: "req-1",
    site: null,
    pagesSessionId: null,
    ...overrides,
  };
}

const PERSON = { user: { id: "user-1" }, organization: { id: "org-1" }, membership: { role: "developer" } };

function meeting(overrides: Partial<MeetingBotView> = {}): MeetingBotView {
  return {
    id: MEETING,
    projectId: PROJECT,
    platform: "google_meet",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetingCode: "abc-defg-hij",
    botName: "Ravi",
    title: "Weekly",
    language: "pt",
    clientRef: null,
    status: "done",
    statusSubCode: null,
    transcriptStatus: "done",
    ready: true,
    joinAt: null,
    recordingStartedAt: "2026-10-01T10:00:00.000Z",
    endedAt: "2026-10-01T11:00:00.000Z",
    doneAt: "2026-10-01T11:05:00.000Z",
    recordingSeconds: 3600,
    maxRecordingSeconds: 7200,
    failureReason: null,
    createdAt: "2026-10-01T09:55:00.000Z",
    updatedAt: "2026-10-01T11:05:00.000Z",
    ...overrides,
  };
}

function calendarEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: EVENT,
    connectionId: "conn-1",
    title: "Planning",
    startAt: "2026-10-21T13:00:00.000Z",
    endAt: "2026-10-21T14:00:00.000Z",
    allDay: false,
    status: "confirmed",
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    meetingCode: "abc-defg-hij",
    organizerEmail: "bia@acme.test",
    selfResponse: "accepted",
    attendees: [{ email: "ana@acme.test", name: "Ana", response: "accepted", organizer: false, self: true }],
    externalAttendees: false,
    recurringEventId: null,
    recordDecision: null,
    recordDecisionProjectId: null,
    recordError: null,
    effectiveRecordMode: "ask",
    briefingEnabled: null,
    briefingMinutes: 30,
    followupEnabled: null,
    recording: null,
    hasBriefing: true,
    updatedAt: "2026-10-20T10:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

type Calls = Record<string, unknown[]>;

function setup(overrides: Partial<KnowledgeMeetingsOperationDeps> = {}) {
  const calls: Calls = {};
  const record = (name: string, value: unknown) => {
    (calls[name] ??= []).push(value);
  };
  const deps: KnowledgeMeetingsOperationDeps = {
    findProject: (async (workspace: unknown, ref: string, access: string) => {
      record("findProject", { workspace, ref, access });
      return { id: PROJECT, slug: "prs", status: "active" };
    }) as unknown as KnowledgeMeetingsOperationDeps["findProject"],
    featureEnabled: async (_actor, key) => {
      record("feature", key);
      return true;
    },
    consoleOrigin: () => "https://console.test",
    retrieve: (async (input: unknown) => {
      record("retrieve", input);
      return {
        run: { id: "run-1", projectId: PROJECT, status: "completed", queryHash: null, candidateCount: 3, returnedChunkCount: 2, deniedReason: null, durationMs: 5, createdAt: 1 },
        citations: [
          {
            runId: "run-1",
            rank: 1,
            score: 0.9,
            sourceId: "src-1",
            documentId: "doc-1",
            chunkId: "chunk-1",
            sourceTitle: "Weekly",
            documentTitle: "Weekly transcript",
            sensitivity: "standard",
            excerpt: "Ana: we ship on Friday",
            location: { meetingId: MEETING, startSeconds: 62 },
            metadata: { secret: "x" },
            textHash: "h",
          },
          {
            runId: "run-1",
            rank: 2,
            score: 0.5,
            sourceId: "src-2",
            documentId: "doc-2",
            chunkId: "chunk-2",
            sourceTitle: "Docs",
            documentTitle: "Docs /faq",
            sensitivity: "standard",
            excerpt: "FAQ text",
            location: { host: "acme-prs.ravi.page", path: "/faq" },
            metadata: {},
            textHash: "h2",
          },
        ],
      };
    }) as unknown as KnowledgeMeetingsOperationDeps["retrieve"],
    listSources: (async (input: unknown) => {
      record("listSources", input);
      return [
        {
          id: "src-1",
          projectId: PROJECT,
          sourceType: "ravi_page",
          title: "FAQ",
          description: null,
          status: "active",
          sensitivity: "standard",
          sourceRef: { url: "https://acme-prs.ravi.page/faq" },
          metadata: {},
          raw: {},
          access: { scope: "project", allowedConsumers: [] },
          documentCount: 0,
          chunkCount: 0,
          revokedAt: null,
          createdAt: Date.parse("2026-10-01T00:00:00Z"),
          updatedAt: Date.parse("2026-10-02T00:00:00Z"),
        },
      ];
    }) as unknown as KnowledgeMeetingsOperationDeps["listSources"],
    listMeetings: (async (input: unknown) => {
      record("listMeetings", input);
      return { meetings: [meeting()] };
    }) as unknown as KnowledgeMeetingsOperationDeps["listMeetings"],
    showMeeting: (async (input: unknown) => {
      record("showMeeting", input);
      return { meeting: meeting() };
    }) as unknown as KnowledgeMeetingsOperationDeps["showMeeting"],
    getRecording: (async (input: unknown) => {
      record("getRecording", input);
      return {
        meeting: meeting(),
        transcript: {
          status: "done",
          segments: [
            { speaker: "Ana", speakerId: "1", isHost: true, startSeconds: 62, endSeconds: 64, startedAt: null, text: "We ship on Friday." },
          ],
        },
        participants: [{ id: "1", name: "Ana", isHost: true }],
        chat: [{ sender: "Bia", senderId: "2", atSeconds: 70, sentAt: null, to: null, text: "ok" }],
        media: [{ kind: "audio", format: "mp3", path: "/x", part: 0, expiresAt: null }],
        recordings: [],
      };
    }) as unknown as KnowledgeMeetingsOperationDeps["getRecording"],
    getStoredTranscript: (async (input: unknown) => {
      record("getStoredTranscript", input);
      return { segments: [{ speaker: "Ana", speakerId: null, t: 5, text: "stored line" }], documentVersion: 1, retainUntil: null };
    }) as unknown as KnowledgeMeetingsOperationDeps["getStoredTranscript"],
    listEvents: (async (input: { searchParams: URLSearchParams; workspace: unknown }) => {
      record("listEvents", { params: Object.fromEntries(input.searchParams), workspace: input.workspace });
      return { from: "2026-10-20T00:00:00.000Z", to: "2026-10-27T00:00:00.000Z", events: [calendarEvent()], truncated: false };
    }) as unknown as KnowledgeMeetingsOperationDeps["listEvents"],
    getEvent: (async (input: unknown) => {
      record("getEvent", input);
      return { event: { ...calendarEvent(), briefing: "## Briefing" } };
    }) as unknown as KnowledgeMeetingsOperationDeps["getEvent"],
    ...overrides,
  };
  const handlers = knowledgeMeetingsOperations(deps);
  const handler = (id: string) => handlers.find((candidate) => candidate.definition.id === id) as OperationHandler;
  return { calls, handler };
}

async function refused(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error instanceof ConsoleApiError || error instanceof CliApiError).toBe(true);
  expect((error as { status: number }).status).toBe(status);
  return error;
}

describe("knowledge-meetings operations", () => {
  test("definitions are MCP reads, and only the calendar ones are not project-bound", () => {
    const ids = KNOWLEDGE_MEETINGS_OPERATIONS.map((handler) => handler.definition.id);
    expect(ids).toEqual([
      "ravi.knowledge.retrieve",
      "ravi.knowledge.sources.list",
      "ravi.meetings.list",
      "ravi.meetings.get",
      "ravi.meetings.transcript",
      "ravi.calendar.events.list",
      "ravi.calendar.events.get",
    ]);
    for (const handler of KNOWLEDGE_MEETINGS_OPERATIONS) {
      const { definition } = handler;
      expect(definition.class).toBe("read");
      expect(definition.needsConfirmation).toBe(false);
      expect(definition.surfaces).toEqual(["mcp"]);
      expect(definition.guests).toBe(false);
      expect(handler.describeChange).toBeUndefined();
      const schema = definition.inputSchema("mcp");
      expect(schema.additionalProperties).toBe(false);
      expect(handler.projectBound).toBe(!definition.id.startsWith("ravi.calendar."));
      if (handler.projectBound) expect(schema.required).toContain("project");
    }
  });

  test("knowledge.retrieve searches the project as the person and returns sourced excerpts, untrusted", async () => {
    const { calls, handler } = setup();
    const output = (await handler("ravi.knowledge.retrieve").run({
      actor: actor(),
      input: { project: "prs", query: "when do we ship", limit: 5 },
    })) as Record<string, unknown>;
    expect(calls.feature).toEqual(["console.knowledge"]);
    expect(calls.findProject).toEqual([{ workspace: PERSON, ref: "prs", access: "read" }]);
    expect(calls.retrieve).toEqual([
      {
        body: { query: "when do we ship", limit: 5 },
        projectRef: PROJECT,
        requestId: "req-1",
        surface: "cli",
        workspace: { mode: "workos", ...PERSON },
      },
    ]);
    expect(output.contentTrust).toBe("untrusted");
    const results = output.results as Array<Record<string, unknown>>;
    expect(results.map((result) => result.url)).toEqual([
      `https://console.test/p/${PROJECT}/meetings/${MEETING}?t=62`,
      "https://acme-prs.ravi.page/faq",
    ]);
    expect(results[0]).toMatchObject({ sourceId: "src-1", sourceTitle: "Weekly", excerpt: "Ana: we ship on Friday" });
    expect(results[0]).not.toHaveProperty("metadata");
  });

  test("knowledge.retrieve is refused when Knowledge is off, or for a cloud run naming another project", async () => {
    const off = setup({ featureEnabled: async () => false });
    await refused(off.handler("ravi.knowledge.retrieve").run({ actor: actor(), input: { project: "prs", query: "x" } }), 403);
    expect(off.calls.retrieve).toBeUndefined();

    const bound = setup();
    await refused(
      bound.handler("ravi.knowledge.retrieve").run({ actor: actor({ boundProjectId: OTHER }), input: { project: "prs", query: "x" } }),
      403,
    );
    expect(bound.calls.retrieve).toBeUndefined();
  });

  test("knowledge.retrieve turns the service's validation error into payload_invalid", async () => {
    const { handler } = setup({
      retrieve: async () => {
        throw new ConsoleApiError(400, { error: "validation_failed", fieldErrors: { query: "query has no searchable terms" } });
      },
    });
    const error = (await refused(handler("ravi.knowledge.retrieve").run({ actor: actor(), input: { project: "prs", query: "the" } }), 400)) as ConsoleApiError;
    expect(error.payload).toEqual({ error: "payload_invalid", fieldErrors: { query: "query has no searchable terms" } });
  });

  test("knowledge.sources.list lists the project's sources as the person", async () => {
    const { calls, handler } = setup();
    const output = (await handler("ravi.knowledge.sources.list").run({ actor: actor(), input: { project: "prs" } })) as Record<string, unknown>;
    expect(calls.listSources).toEqual([{ projectRef: PROJECT, workspace: { mode: "workos", ...PERSON } }]);
    expect(output.sources).toEqual([
      {
        id: "src-1",
        sourceType: "ravi_page",
        title: "FAQ",
        description: null,
        status: "active",
        sensitivity: "standard",
        url: "https://acme-prs.ravi.page/faq",
        revokedAt: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
    expect(output.truncated).toBe(false);
    expect(output.contentTrust).toBe("untrusted");

    const bound = setup();
    await refused(bound.handler("ravi.knowledge.sources.list").run({ actor: actor({ boundProjectId: OTHER }), input: { project: "prs" } }), 403);
    expect(bound.calls.listSources).toBeUndefined();
  });

  test("meetings.list lists the project's meetings as the person", async () => {
    const { calls, handler } = setup();
    const output = (await handler("ravi.meetings.list").run({ actor: actor(), input: { project: "prs", limit: 10 } })) as {
      meetings: Array<Record<string, unknown>>;
    };
    expect(calls.feature).toEqual(["console.meetings"]);
    expect(calls.listMeetings).toEqual([{ projectRef: PROJECT, limit: 10, workspace: PERSON }]);
    expect(output.meetings[0]).toMatchObject({ id: MEETING, projectId: PROJECT, status: "done", ready: true });
    expect(output.meetings[0]).not.toHaveProperty("clientRef");

    const bound = setup();
    await refused(bound.handler("ravi.meetings.list").run({ actor: actor({ boundProjectId: OTHER }), input: { project: "prs" } }), 403);
    expect(bound.calls.listMeetings).toBeUndefined();
  });

  test("meetings.get returns one meeting of the project and refuses one from elsewhere", async () => {
    const { calls, handler } = setup();
    const output = (await handler("ravi.meetings.get").run({ actor: actor(), input: { project: "prs", meeting: MEETING } })) as {
      meeting: Record<string, unknown>;
    };
    expect(calls.showMeeting).toEqual([{ projectRef: PROJECT, meetingId: MEETING, workspace: PERSON }]);
    expect(output.meeting.id).toBe(MEETING);

    const elsewhere = setup({ showMeeting: (async () => ({ meeting: meeting({ projectId: OTHER }) })) as unknown as KnowledgeMeetingsOperationDeps["showMeeting"] });
    await refused(elsewhere.handler("ravi.meetings.get").run({ actor: actor(), input: { project: "prs", meeting: MEETING } }), 404);

    const bound = setup();
    await refused(
      bound.handler("ravi.meetings.get").run({ actor: actor({ boundProjectId: OTHER }), input: { project: "prs", meeting: MEETING } }),
      403,
    );
    expect(bound.calls.showMeeting).toBeUndefined();
  });

  test("meetings.transcript returns the recording's transcript and chat as untrusted text", async () => {
    const { calls, handler } = setup();
    const output = (await handler("ravi.meetings.transcript").run({ actor: actor(), input: { project: "prs", meeting: MEETING } })) as Record<
      string,
      unknown
    >;
    expect(calls.getRecording).toEqual([{ projectRef: PROJECT, meetingId: MEETING, workspace: PERSON }]);
    expect(output.text).toBe("[00:01:02] Ana: We ship on Friday.\n\n[chat]\n[00:01:10] Bia: ok");
    expect(output).toMatchObject({ source: "recording", nextCursor: null, truncated: false, contentTrust: "untrusted" });
    expect(output.participants).toEqual([{ name: "Ana", isHost: true }]);
    expect(output).not.toHaveProperty("media");
  });

  test("meetings.transcript falls back to the stored transcript when the vendor is unavailable", async () => {
    const { calls, handler } = setup({
      getRecording: async () => {
        throw new CliApiError(503, "SERVER_UNAVAILABLE", "gone");
      },
    });
    const output = (await handler("ravi.meetings.transcript").run({ actor: actor(), input: { project: "prs", meeting: MEETING } })) as Record<
      string,
      unknown
    >;
    expect(calls.getStoredTranscript).toEqual([{ projectRef: PROJECT, meetingId: MEETING, workspace: PERSON }]);
    expect(output).toMatchObject({ source: "stored", text: "[00:00:05] Ana: stored line" });
  });

  test("meetings.transcript pages long text with a cursor", async () => {
    const segments = Array.from({ length: 800 }, (_, index) => ({
      speaker: "Ana",
      speakerId: "1",
      isHost: true,
      startSeconds: index,
      endSeconds: index + 1,
      startedAt: null,
      text: `line ${index} ${"x".repeat(40)}`,
    }));
    const { handler } = setup({
      getRecording: (async () => ({
        meeting: meeting(),
        transcript: { status: "done", segments },
        participants: [],
        chat: [],
        media: [],
        recordings: [],
      })) as unknown as KnowledgeMeetingsOperationDeps["getRecording"],
    });
    const run = (cursor?: string) =>
      handler("ravi.meetings.transcript").run({
        actor: actor(),
        input: { project: "prs", meeting: MEETING, ...(cursor ? { cursor } : {}) },
      }) as Promise<{ text: string; nextCursor: string | null; totalChars: number }>;
    const first = await run();
    expect(first.text.length).toBeLessThanOrEqual(MEETING_TRANSCRIPT_PAGE_CHARS);
    expect(first.text.endsWith("\n")).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    let text = first.text;
    let cursor = first.nextCursor;
    while (cursor) {
      const next = await run(cursor);
      text += next.text;
      cursor = next.nextCursor;
    }
    expect(text.length).toBe(first.totalChars);
    expect(text.split("\n")).toHaveLength(800);
  });

  test("meetings.transcript refuses a cloud run naming another project", async () => {
    const { calls, handler } = setup();
    await refused(
      handler("ravi.meetings.transcript").run({ actor: actor({ boundProjectId: OTHER }), input: { project: "prs", meeting: MEETING } }),
      403,
    );
    expect(calls.getRecording).toBeUndefined();
  });

  test("calendar.events.list reads the person's own calendar window", async () => {
    const { calls, handler } = setup();
    const output = (await handler("ravi.calendar.events.list").run({
      actor: actor(),
      input: { from: "2026-10-20T00:00:00Z", to: "2026-10-27T00:00:00Z" },
    })) as { events: Array<Record<string, unknown>>; contentTrust: string; truncated: boolean };
    expect(calls.listEvents).toEqual([
      { params: { from: "2026-10-20T00:00:00Z", to: "2026-10-27T00:00:00Z" }, workspace: PERSON },
    ]);
    expect(calls.findProject).toBeUndefined();
    expect(output.events[0]).toMatchObject({ id: EVENT, title: "Planning", attendeeCount: 1, hasBriefing: true });
    expect(output.events[0]).not.toHaveProperty("connectionId");
    expect(output.contentTrust).toBe("untrusted");
    expect(output.truncated).toBe(false);
  });

  test("calendar.events.get returns the event with its briefing", async () => {
    const { calls, handler } = setup();
    const output = (await handler("ravi.calendar.events.get").run({ actor: actor(), input: { event: EVENT } })) as {
      event: Record<string, unknown>;
      contentTrust: string;
    };
    expect(calls.getEvent).toEqual([{ eventId: EVENT, workspace: PERSON }]);
    expect(output.event).toMatchObject({ id: EVENT, briefing: "## Briefing" });
    expect(output.contentTrust).toBe("untrusted");
  });

  test("an actor without a Console role reads no meetings or calendar", async () => {
    const { calls, handler } = setup();
    await refused(handler("ravi.calendar.events.get").run({ actor: actor({ orgRole: "weird" }), input: { event: EVENT } }), 403);
    await refused(handler("ravi.meetings.list").run({ actor: actor({ orgRole: null }), input: { project: "prs" } }), 403);
    expect(calls.getEvent).toBeUndefined();
    expect(calls.listMeetings).toBeUndefined();
  });

  test("transcriptPage refuses a cursor past the end", () => {
    expect(transcriptPage("", 0)).toEqual({ text: "", offset: 0, nextCursor: null });
    expect(() => transcriptPage("abc", 3)).toThrow();
  });
});
