import { describe, expect, test } from "bun:test";

import { normalizeGoogleEvent } from "./calendar-sync";

const context = { ownerEmail: "luis@acme.test", memberEmails: new Set(["luis@acme.test", "ana@acme.test"]) };

describe("normalizeGoogleEvent", () => {
  test("keeps the Meet link, the attendees and the owner's response, never the description or location", () => {
    const event = normalizeGoogleEvent(
      {
        id: "evt1",
        status: "confirmed",
        summary: "Weekly",
        description: "secret notes",
        location: "Room 1",
        start: { dateTime: "2026-10-20T13:00:00-03:00" },
        end: { dateTime: "2026-10-20T13:30:00-03:00" },
        hangoutLink: "https://meet.google.com/abc-defg-hij?authuser=0",
        organizer: { email: "Ana@acme.test" },
        attendees: [
          { email: "Luis@acme.test", responseStatus: "accepted", self: true },
          { email: "ana@acme.test", displayName: "Ana", responseStatus: "needsAction", organizer: true },
          { email: "room@resource.calendar.google.com", resource: true },
        ],
        recurringEventId: "rec1",
        iCalUID: "uid1",
        updated: "2026-10-18T10:00:00.000Z",
      } as never,
      context,
    );
    expect(event).toEqual({
      providerEventId: "evt1",
      icalUid: "uid1",
      recurringEventId: "rec1",
      title: "Weekly",
      startAt: new Date("2026-10-20T16:00:00.000Z"),
      endAt: new Date("2026-10-20T16:30:00.000Z"),
      allDay: false,
      status: "confirmed",
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      meetingCode: "abc-defg-hij",
      organizerEmail: "ana@acme.test",
      selfResponse: "accepted",
      attendees: [
        { email: "luis@acme.test", name: null, response: "accepted", organizer: false, self: true },
        { email: "ana@acme.test", name: "Ana", response: "needsAction", organizer: true, self: false },
      ],
      externalAttendees: false,
      providerUpdatedAt: new Date("2026-10-18T10:00:00.000Z"),
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("Room 1");
  });

  test("an attendee outside the organization makes the meeting external", () => {
    const event = normalizeGoogleEvent(
      {
        id: "evt2",
        start: { dateTime: "2026-10-20T13:00:00Z" },
        end: { dateTime: "2026-10-20T14:00:00Z" },
        attendees: [{ email: "luis@acme.test", self: true }, { email: "client@other.test" }],
      },
      context,
    );
    expect(event?.externalAttendees).toBe(true);
  });

  test("the video entry point counts when there is no hangoutLink; other hosts do not", () => {
    const zoom = normalizeGoogleEvent(
      {
        id: "z",
        start: { dateTime: "2026-10-20T13:00:00Z" },
        end: { dateTime: "2026-10-20T14:00:00Z" },
        conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://zoom.us/j/123" }] },
      },
      context,
    );
    expect(zoom?.meetingCode).toBeNull();
    const meet = normalizeGoogleEvent(
      {
        id: "m",
        start: { dateTime: "2026-10-20T13:00:00Z" },
        end: { dateTime: "2026-10-20T14:00:00Z" },
        conferenceData: {
          entryPoints: [
            { entryPointType: "phone", uri: "tel:+55-11" },
            { entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" },
          ],
        },
      },
      context,
    );
    expect(meet?.meetingCode).toBe("xyz-abcd-efg");
  });

  test("all-day events, a solo event's response, and unreadable events", () => {
    const allDay = normalizeGoogleEvent({ id: "d", start: { date: "2026-10-21" }, end: { date: "2026-10-22" } }, context);
    expect(allDay).toMatchObject({ allDay: true, startAt: new Date("2026-10-21T00:00:00Z"), selfResponse: "accepted", title: "" });
    expect(normalizeGoogleEvent({ id: "x", start: {}, end: {} }, context)).toBeNull();
    expect(normalizeGoogleEvent({ start: { date: "2026-10-21" }, end: { date: "2026-10-22" } }, context)).toBeNull();
    const long = normalizeGoogleEvent(
      { id: "l", summary: "a".repeat(400), start: { date: "2026-10-21" }, end: { date: "2026-10-22" } },
      context,
    );
    expect(long?.title.length).toBe(300);
  });
});
