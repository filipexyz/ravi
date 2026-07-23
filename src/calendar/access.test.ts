import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ScopeContext } from "../permissions/scope.js";
import type { ContextCapability, ContextRecord } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import {
  calendarAccessLevel,
  canUseAnyCalendar,
  canUseCalendar,
  canUseCalendarProvider,
  resolveDefaultCalendarOwnerSubject,
} from "./access.js";
import { addCalendarMember, createCalendar, createCalendarAccount } from "./db.js";
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

function cap(permission: string, objectType: string, objectId: string): ContextCapability {
  return { permission, objectType, objectId };
}

function ctxWith(capabilities: ContextCapability[], metadata: Record<string, unknown> = {}): ScopeContext {
  const context: ContextRecord = {
    contextId: "ctx_calendar_access",
    contextKey: "ctx_key_calendar_access",
    kind: "test-runtime",
    agentId: "dev",
    capabilities,
    metadata,
    createdAt: 0,
  };
  return { agentId: "dev", context };
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

  it("allows the active contact actor to use their own private calendar", () => {
    const owned = calendar({ ownerType: "contact", ownerId: "luis" });
    const luisCtx = ctxWith([], { actorPrincipal: "contact:luis", actorType: "contact", contactId: "luis" });
    const otherCtx = ctxWith([], { actorPrincipal: "contact:ana", actorType: "contact", contactId: "ana" });

    expect(canUseCalendar(luisCtx, "read", owned)).toBe(true);
    expect(canUseCalendar(luisCtx, "manage", owned)).toBe(true);
    expect(canUseCalendar(otherCtx, "read", owned)).toBe(false);
  });

  it("honors memberships for the active contact actor", () => {
    const account = createCalendarAccount({ id: "acct-local", provider: "local" });
    const owned = createCalendar({
      id: "cal-luis",
      accountId: account.id,
      name: "Luis",
      ownerType: "contact",
      ownerId: "luis",
      visibility: "private",
    });
    const anaCtx = ctxWith([], { actorPrincipal: "contact:ana", actorType: "contact", contactId: "ana" });

    expect(canUseCalendar(anaCtx, "read", owned)).toBe(false);

    addCalendarMember({ calendarId: owned.id, memberType: "contact", memberId: "ana", relation: "reader" });

    expect(canUseCalendar(anaCtx, "read", owned)).toBe(true);
    expect(canUseCalendar(anaCtx, "free-busy", owned)).toBe(true);
    expect(canUseCalendar(anaCtx, "write", owned)).toBe(false);
  });

  it("uses the active contact actor as the default owner before the executor agent", () => {
    const subject = resolveDefaultCalendarOwnerSubject(
      ctxWith([], { actorPrincipal: "contact:luis", actorType: "contact", contactId: "luis" }),
    );
    expect(subject).toEqual({ type: "contact", id: "luis" });

    const previousContactId = process.env.RAVI_CONTACT_ID;
    delete process.env.RAVI_CONTACT_ID;
    try {
      expect(resolveDefaultCalendarOwnerSubject(DEV)).toEqual({ type: "agent", id: "dev" });
      expect(resolveDefaultCalendarOwnerSubject({})).toEqual({ type: "system", id: "ravi" });
    } finally {
      if (previousContactId !== undefined) process.env.RAVI_CONTACT_ID = previousContactId;
    }
  });

  it("uses legacy RAVI_CONTACT_ID when no runtime context record is available", () => {
    const previousContactId = process.env.RAVI_CONTACT_ID;
    process.env.RAVI_CONTACT_ID = "luis";
    try {
      const owned = calendar({ ownerType: "contact", ownerId: "luis" });

      expect(resolveDefaultCalendarOwnerSubject(DEV)).toEqual({ type: "contact", id: "luis" });
      expect(canUseCalendar(DEV, "manage", owned)).toBe(true);
    } finally {
      if (previousContactId === undefined) {
        delete process.env.RAVI_CONTACT_ID;
      } else {
        process.env.RAVI_CONTACT_ID = previousContactId;
      }
    }
  });

  it("allows public calendars for read/search/free-busy but not writes", () => {
    const pub = calendar({ visibility: "public" });
    expect(canUseCalendar(DEV, "read", pub)).toBe(true);
    expect(canUseCalendar(DEV, "free-busy", pub)).toBe(true);
    expect(canUseCalendar(DEV, "write", pub)).toBe(false);
    expect(calendarAccessLevel(DEV, pub)).toBe("read");
  });

  it("honors a grant on the calendar id, name, or provider id", () => {
    const readCtx = ctxWith([cap("read", "calendar", "cal-1")]);
    expect(canUseCalendar(readCtx, "read", calendar())).toBe(true);
    expect(canUseCalendar(readCtx, "write", calendar())).toBe(false);

    expect(canUseCalendar(ctxWith([cap("write", "calendar", "Work")]), "write", calendar())).toBe(true);

    expect(canUseCalendar(ctxWith([cap("respond", "calendar", "prov-1")]), "respond", calendar())).toBe(true);
  });

  it("reports free-busy level when only read access exists on another calendar's detail", () => {
    expect(calendarAccessLevel(ctxWith([cap("read", "calendar", "cal-1")]), calendar())).toBe("read");
  });

  it("checks any-calendar and provider grants", () => {
    expect(canUseAnyCalendar(DEV, "read")).toBe(false);
    expect(canUseAnyCalendar(ctxWith([cap("read", "calendar", "*")]), "read")).toBe(true);

    expect(canUseCalendarProvider(DEV, "sync", "google")).toBe(false);
    expect(canUseCalendarProvider(ctxWith([cap("sync", "calendar-provider", "google")]), "sync", "google")).toBe(true);
  });
});
