import { describe, expect, test } from "bun:test";

import { formatCallClock, knowledgeResultUrl } from "./links";
import type { KnowledgeChunkRow } from "./retrieval-core";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const MEETING = "22222222-2222-4222-8222-222222222222";

function row(overrides: Partial<KnowledgeChunkRow>): KnowledgeChunkRow {
  return {
    chunkId: "33333333-3333-4333-8333-333333333333",
    organizationId: "org",
    projectId: PROJECT,
    sourceId: "s",
    documentId: "d",
    kind: "note",
    sourceType: "manual_note",
    originKey: null,
    sourceTitle: "Title",
    documentTitle: "Title",
    documentVersion: 1,
    trust: "said",
    text: "text",
    textHash: "hash",
    ordinal: 0,
    stableKey: null,
    charStart: null,
    charEnd: null,
    location: {},
    metadata: {},
    recordedAt: new Date("2026-10-15T14:02:11Z"),
    sourceRef: {},
    ...overrides,
  };
}

describe("formatCallClock", () => {
  test("formats hh:mm:ss and drops fractions", () => {
    expect(formatCallClock(872.4)).toBe("00:14:32");
    expect(formatCallClock(0)).toBe("00:00:00");
    expect(formatCallClock(3 * 3600 + 7)).toBe("03:00:07");
  });

  test("unknown or invalid times are null", () => {
    expect(formatCallClock(null)).toBeNull();
    expect(formatCallClock(-1)).toBeNull();
    expect(formatCallClock(Number.NaN)).toBeNull();
    expect(formatCallClock(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("knowledgeResultUrl", () => {
  test("a meeting links to the meeting screen at the call clock", () => {
    const meeting = row({ kind: "meeting", location: { kind: "meeting", meetingId: MEETING, part: 0, startSeconds: 872.4 } });
    expect(knowledgeResultUrl(meeting, "https://console.ravi.bot")).toBe(
      `https://console.ravi.bot/p/${PROJECT}/meetings/${MEETING}?t=872.4`,
    );
    expect(knowledgeResultUrl(meeting, "https://console.ravi.bot/")).toBe(
      `https://console.ravi.bot/p/${PROJECT}/meetings/${MEETING}?t=872.4`,
    );
  });

  test("a meeting without a call clock links without ?t", () => {
    const meeting = row({ kind: "meeting", location: { kind: "meeting", meetingId: MEETING, startSeconds: null } });
    expect(knowledgeResultUrl(meeting, "https://console.ravi.bot")).toBe(`https://console.ravi.bot/p/${PROJECT}/meetings/${MEETING}`);
  });

  test("a meeting without a valid id or project has no link", () => {
    expect(knowledgeResultUrl(row({ kind: "meeting", location: { meetingId: "../../x" } }), "https://c")).toBeNull();
    expect(knowledgeResultUrl(row({ kind: "meeting", projectId: null, location: { meetingId: MEETING } }), "https://c")).toBeNull();
  });

  test("a page links to its section on the host", () => {
    const page = row({ kind: "page", location: { kind: "page", host: "acme.ravi.page", path: "/politica", anchor: "trocas" } });
    expect(knowledgeResultUrl(page, "https://console.ravi.bot")).toBe("https://acme.ravi.page/politica#trocas");
    const noAnchor = row({ kind: "page", location: { host: "acme.ravi.page", path: "/", anchor: null } });
    expect(knowledgeResultUrl(noAnchor, "https://c")).toBe("https://acme.ravi.page/");
    const textFragment = row({ kind: "page", location: { host: "acme.ravi.page", path: "/a", anchor: ":~:text=prazo%20de%20troca" } });
    expect(knowledgeResultUrl(textFragment, "https://c")).toBe("https://acme.ravi.page/a#:~:text=prazo%20de%20troca");
  });

  test("a page with a bad host or path has no link", () => {
    expect(knowledgeResultUrl(row({ kind: "page", location: { host: "evil.com/x", path: "/" } }), "https://c")).toBeNull();
    expect(knowledgeResultUrl(row({ kind: "page", location: { host: "acme.ravi.page", path: "//evil.com" } }), "https://c")).toBeNull();
    expect(knowledgeResultUrl(row({ kind: "page", location: { host: "acme.ravi.page", path: "x" } }), "https://c")).toBeNull();
  });

  test("notes, manual sources and local transcripts have no link", () => {
    expect(knowledgeResultUrl(row({ kind: "note" }), "https://c")).toBeNull();
    expect(knowledgeResultUrl(row({ kind: "manual" }), "https://c")).toBeNull();
    expect(knowledgeResultUrl(row({ kind: "transcript", location: { meetingId: MEETING } }), "https://c")).toBeNull();
  });
});
