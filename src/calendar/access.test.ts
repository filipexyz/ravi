import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { grantRelation } from "../permissions/relations.js";
import type { ScopeContext } from "../permissions/scope.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { calendarAccessLevel, canUseAnyCalendar, canUseCalendar, canUseCalendarProvider } from "./access.js";
import type { CalendarCalendar } from "./types.js";

let stateDir: string | null = null;

const DEV: ScopeContext = { agentId: "dev" };

type Cal = Pick<CalendarCalendar, "id" | "name" | "providerCalendarId" | "visibility" | "ownerType" | "ownerId">;

function calendar(overrides: Partial<Cal> = {}): Cal {
  return {
    id: "cal-1",
    name: "Work",
    providerCalendarId: "prov-1",
    visibility: "private",
    ownerType: "system",
    ownerId: "system",
    ...overrides,
  } as Cal;
}

function grant(relation: string, objectType: string, objectId: string) {
  grantRelation("agent", "dev", relation, objectType, objectId, "manual", { permanent: true });
}

describe("calendar access gate", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-calendar-access-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("allows everything for a direct operator with no agent principal", () => {
    expect(canUseCalendar({}, "write", calendar())).toBe(true);
    expect(canUseAnyCalendar({}, "read")).toBe(true);
    expect(canUseCalendarProvider({}, "sync", "google")).toBe(true);
  });

  it("denies a private calendar with no grant (fail closed)", () => {
    expect(canUseCalendar(DEV, "read", calendar())).toBe(false);
    expect(canUseCalendar(DEV, "write", calendar())).toBe(false);
    expect(calendarAccessLevel(DEV, calendar())).toBe("none");
  });

  it("allows the owning agent full access", () => {
    const owned = calendar({ ownerType: "agent", ownerId: "dev" });
    expect(canUseCalendar(DEV, "write", owned)).toBe(true);
    expect(canUseCalendar(DEV, "manage", owned)).toBe(true);
  });

  it("allows public calendars for read/search/free-busy but not writes", () => {
    const pub = calendar({ visibility: "public" });
    expect(canUseCalendar(DEV, "read", pub)).toBe(true);
    expect(canUseCalendar(DEV, "free-busy", pub)).toBe(true);
    expect(canUseCalendar(DEV, "write", pub)).toBe(false);
    expect(calendarAccessLevel(DEV, pub)).toBe("read");
  });

  it("honors a grant on the calendar id, name, or provider id", () => {
    grant("read", "calendar", "cal-1");
    expect(canUseCalendar(DEV, "read", calendar())).toBe(true);
    expect(canUseCalendar(DEV, "write", calendar())).toBe(false);

    grant("write", "calendar", "Work");
    expect(canUseCalendar(DEV, "write", calendar())).toBe(true);

    grant("respond", "calendar", "prov-1");
    expect(canUseCalendar(DEV, "respond", calendar())).toBe(true);
  });

  it("reports free-busy level when only read access exists on another calendar's detail", () => {
    grant("read", "calendar", "cal-1");
    expect(calendarAccessLevel(DEV, calendar())).toBe("read");
  });

  it("checks any-calendar and provider grants", () => {
    expect(canUseAnyCalendar(DEV, "read")).toBe(false);
    grant("read", "calendar", "*");
    expect(canUseAnyCalendar(DEV, "read")).toBe(true);

    expect(canUseCalendarProvider(DEV, "sync", "google")).toBe(false);
    grant("sync", "calendar-provider", "google");
    expect(canUseCalendarProvider(DEV, "sync", "google")).toBe(true);
  });
});
