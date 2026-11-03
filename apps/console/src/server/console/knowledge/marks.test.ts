import { describe, expect, test } from "bun:test";

import { markHasAudience, readRouteMark, stripReservedRouteConfig, type KnowledgeRouteMark } from "./marks";

const MARK: KnowledgeRouteMark = {
  v: 1,
  state: "active",
  audiences: [
    { kind: "page_viewers" },
    { kind: "contacts", localInstallationId: "00000000-0000-4000-8000-000000000001", instanceId: "wa-main", label: "WhatsApp" },
  ],
  approvedDocumentId: "00000000-0000-4000-8000-000000000002",
  approvedVersion: 3,
  approvedContentHash: "abc",
  approvedBy: "00000000-0000-4000-8000-000000000003",
  approvedAt: "2026-10-17T00:00:00.000Z",
  managedBy: "web",
  faqHtmlSha256: null,
  suspendedAt: null,
  suspendedReason: null,
};

describe("route marks (pure parts)", () => {
  test("readRouteMark validates the reserved key", () => {
    expect(readRouteMark({ knowledge: MARK, other: 1 })).toEqual(MARK);
    expect(readRouteMark(JSON.stringify({ knowledge: MARK }))).toEqual(MARK);
  });

  test("readRouteMark on invalid JSON or an invalid mark returns null", () => {
    expect(readRouteMark("{not json")).toBeNull();
    expect(readRouteMark(null)).toBeNull();
    expect(readRouteMark([])).toBeNull();
    expect(readRouteMark({})).toBeNull();
    expect(readRouteMark({ knowledge: { ...MARK, v: 2 } })).toBeNull();
    expect(readRouteMark({ knowledge: { ...MARK, approvedDocumentId: "not-a-uuid" } })).toBeNull();
    expect(readRouteMark({ knowledge: { ...MARK, managedBy: "cli" } })).toBeNull();
  });

  test("stripReservedRouteConfig removes only knowledge", () => {
    expect(stripReservedRouteConfig({ knowledge: {}, x: 1, nested: { knowledge: 2 } })).toEqual({ x: 1, nested: { knowledge: 2 } });
    expect(stripReservedRouteConfig({ x: 1 })).toEqual({ x: 1 });
    expect(stripReservedRouteConfig(undefined)).toBeUndefined();
  });

  test("markHasAudience matches page viewers and contacts by installation and instance", () => {
    expect(markHasAudience(MARK, { kind: "page_viewers" })).toBe(true);
    expect(markHasAudience(MARK, { kind: "contacts", localInstallationId: "00000000-0000-4000-8000-000000000001" })).toBe(true);
    expect(
      markHasAudience(MARK, { kind: "contacts", localInstallationId: "00000000-0000-4000-8000-000000000001", instanceId: "tg" }),
    ).toBe(false);
    expect(markHasAudience({ ...MARK, audiences: [] }, { kind: "page_viewers" })).toBe(false);
  });
});
