import { describe, expect, test } from "bun:test";

import { CliApiError } from "@/server/cli/errors";

import {
  authorizeMeetingReadFromCli,
  meetingIdFromUrl,
  parseMeetingReadBody,
  resolveMeetingForUser,
  type ExternalReadDeps,
} from "./sharing";
import type { MeetingBotRow } from "./store";

const MEETING = "3f1c2b8a-7d4e-4c1a-9b2f-1e2d3c4b5a69";
const SOURCE_ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

function row(overrides: Partial<MeetingBotRow> = {}): MeetingBotRow {
  const now = new Date("2026-10-18T12:00:00Z");
  return {
    id: MEETING,
    organizationId: SOURCE_ORG,
    projectId: PROJECT,
    requestedByUserId: USER,
    localInstallationId: null,
    provider: "recall",
    providerBotId: "bot",
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
    joinAt: null,
    recordingStartedAt: now,
    endedAt: now,
    doneAt: now,
    recordingSeconds: 60,
    maxRecordingSeconds: 3600,
    readyNotifiedAt: now,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as MeetingBotRow;
}

type Calls = { audits: Array<Record<string, unknown>> };

function deps(
  options: {
    role?: string | null;
    canRead?: boolean;
    grant?: boolean;
    allowed?: boolean;
    available?: boolean;
    authorized?: boolean;
    orgStatus?: string;
    meeting?: MeetingBotRow | null;
  } = {},
  calls: Calls = { audits: [] },
): ExternalReadDeps {
  const meeting = options.meeting === undefined ? row() : options.meeting;
  return {
    findMeeting: async () =>
      meeting
        ? {
            row: meeting,
            organization: { id: SOURCE_ORG, slug: "rabbit", name: "Rabbit", status: options.orgStatus ?? "active" },
            project: { id: PROJECT, slug: "calls", name: "Calls" },
          }
        : null,
    memberRole: async () => (options.role === undefined ? "developer" : options.role),
    canReadProject: async () => options.canRead ?? true,
    featureFor: async () => ({ available: options.available ?? true, authorized: options.authorized ?? true }),
    hasGrant: async () => options.grant ?? false,
    externalAgentsAllowed: async () => options.allowed ?? false,
    audit: async (input) => {
      calls.audits.push(input);
    },
  };
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof CliApiError) return error.code;
    throw error;
  }
}

describe("meeting links", () => {
  test("reads the id from every Console meeting link", () => {
    expect(meetingIdFromUrl(`https://console.ravi.bot/p/calls/meetings/${MEETING}`)).toBe(MEETING);
    expect(meetingIdFromUrl(`https://console.ravi.bot/rabbit/p/calls/meetings/${MEETING}?t=1m30s`)).toBe(MEETING);
    expect(meetingIdFromUrl(`https://console.ravi.bot/shared/meetings/${MEETING.toUpperCase()}`)).toBe(MEETING);
    expect(meetingIdFromUrl(`http://localhost:3000/shared/meetings/${MEETING}/`)).toBe(MEETING);
  });

  test("refuses links that are not a meeting", () => {
    expect(meetingIdFromUrl("https://meet.google.com/abc-defg-hij")).toBeNull();
    expect(meetingIdFromUrl(`https://console.ravi.bot/p/calls/meetings/${MEETING}x`)).toBeNull();
    expect(meetingIdFromUrl(`javascript:alert(1)//meetings/${MEETING}`)).toBeNull();
    expect(meetingIdFromUrl("not a url")).toBeNull();
  });

  test("the body takes a link or an id, not both and not neither", () => {
    expect(parseMeetingReadBody({ meetingId: MEETING })).toEqual({ meetingId: MEETING });
    expect(parseMeetingReadBody({ url: `https://console.ravi.bot/shared/meetings/${MEETING}` })).toEqual({ meetingId: MEETING });
    for (const body of [{}, { url: "x", meetingId: MEETING }, { meetingId: "nope" }, { url: "https://console.ravi.bot/p/x" }, null]) {
      expect(() => parseMeetingReadBody(body)).toThrow(CliApiError);
    }
  });
});

describe("who may see a meeting", () => {
  test("a member who can read the project sees it as a member", async () => {
    const resolved = await resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps());
    expect(resolved.access).toBe("member");
    expect(resolved.organization.name).toBe("Rabbit");
  });

  test("a member without the project, the feature or the role falls back to a grant", async () => {
    expect((await resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ canRead: false, grant: true }))).access).toBe("guest");
    expect((await resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ authorized: false, grant: true }))).access).toBe("guest");
    expect(await code(resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ canRead: false })))).toBe("NOT_FOUND");
  });

  test("a person with a grant and no membership is a guest", async () => {
    const resolved = await resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ role: null, grant: true }));
    expect(resolved.access).toBe("guest");
  });

  test("everything else is not found, so the meeting's existence does not leak", async () => {
    expect(await code(resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ role: null })))).toBe("NOT_FOUND");
    expect(await code(resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ meeting: null })))).toBe("NOT_FOUND");
    expect(await code(resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ orgStatus: "suspended" })))).toBe("NOT_FOUND");
    expect(await code(resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ meeting: row({ projectId: null }) })))).toBe(
      "NOT_FOUND",
    );
    expect(await code(resolveMeetingForUser({ meetingId: "nope", userId: USER }, deps()))).toBe("NOT_FOUND");
    // An organization that lost meetings takes its grants' access with it.
    expect(await code(resolveMeetingForUser({ meetingId: MEETING, userId: USER }, deps({ role: null, grant: true, available: false })))).toBe(
      "NOT_FOUND",
    );
  });
});

describe("reading from a CLI session", () => {
  const body = { url: `https://console.ravi.bot/rabbit/p/calls/meetings/${MEETING}` };
  const session = (organizationId: string) => ({ organizationId, userId: USER, localInstallationId: "inst" });

  test("inside the meeting's own organization it is a project read, with no policy and no audit", async () => {
    const calls: Calls = { audits: [] };
    const resolved = await authorizeMeetingReadFromCli({ body, requestId: "r", session: session(SOURCE_ORG) }, deps({}, calls));
    expect(resolved.crossOrganization).toBe(false);
    expect(calls.audits).toHaveLength(0);
  });

  test("from another organization it needs the source organization's policy, and is audited either way", async () => {
    const calls: Calls = { audits: [] };
    const denied = authorizeMeetingReadFromCli({ body, requestId: "r1", session: session(OTHER_ORG) }, deps({ allowed: false }, calls));
    expect(await code(denied)).toBe("ORG_ACCESS_DENIED");
    const allowed = await authorizeMeetingReadFromCli({ body, requestId: "r2", session: session(OTHER_ORG) }, deps({ allowed: true }, calls));
    expect(allowed.crossOrganization).toBe(true);
    expect(calls.audits.map((audit) => [audit.organizationId, (audit.afterJson as { allowed: boolean }).allowed])).toEqual([
      [SOURCE_ORG, false],
      [SOURCE_ORG, true],
    ]);
    expect((calls.audits[1]?.afterJson as { fromOrganizationId: string }).fromOrganizationId).toBe(OTHER_ORG);
  });

  test("the refusal names the organization and what its admins can change", async () => {
    try {
      await authorizeMeetingReadFromCli({ body, requestId: "r", session: session(OTHER_ORG) }, deps({ allowed: false }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(CliApiError);
      const refusal = error as CliApiError;
      expect(refusal.status).toBe(403);
      expect(refusal.details).toEqual({ reason: "external_agents_disabled", organization: { name: "Rabbit" } });
      expect(refusal.message).toContain("Rabbit");
    }
  });

  test("the policy never opens a meeting the person cannot see", async () => {
    const calls: Calls = { audits: [] };
    const read = authorizeMeetingReadFromCli({ body, requestId: "r", session: session(OTHER_ORG) }, deps({ role: null, allowed: true }, calls));
    expect(await code(read)).toBe("NOT_FOUND");
    expect(calls.audits).toHaveLength(0);
  });

  test("a guest reads from their own organization's agent when the source allows it", async () => {
    const resolved = await authorizeMeetingReadFromCli(
      { body: { meetingId: MEETING }, requestId: "r", session: session(OTHER_ORG) },
      deps({ role: null, grant: true, allowed: true }),
    );
    expect(resolved.access).toBe("guest");
  });
});
