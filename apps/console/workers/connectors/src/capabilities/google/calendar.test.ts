import { describe, expect, test } from "bun:test";

import { AdapterProviderError } from "../../adapters/adapter";
import { buildGoogleCalendarHandlers } from "./calendar";

const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function freeBusy(reply: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return reply();
  }) as typeof fetch;
  return { calls, handler: buildGoogleCalendarHandlers(fetchImpl).get("gcal.freebusy.query")! };
}

const signal = new AbortController().signal;

describe("gcal.freebusy.query", () => {
  test("posts the window and calendars and returns them in request order", async () => {
    const { calls, handler } = freeBusy(() =>
      respond({
        timeMin: "2026-10-12T00:00:00.000Z",
        timeMax: "2026-10-13T00:00:00.000Z",
        calendars: {
          "team@example.test": { errors: [{ domain: "calendar", reason: "notFound" }] },
          primary: {
            busy: [{ start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" }, { start: "2026-10-12T15:00:00Z" }],
          },
        },
      }),
    );
    const result = await handler.execute({
      parameters: {
        timeMin: "2026-10-12T00:00:00Z",
        timeMax: "2026-10-13T00:00:00Z",
        calendarIds: ["primary", "team@example.test", "missing@example.test"],
        timeZone: "America/Sao_Paulo",
      },
      accessToken: "at-1",
      abortSignal: signal,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(FREEBUSY_URL);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      timeMin: "2026-10-12T00:00:00Z",
      timeMax: "2026-10-13T00:00:00Z",
      timeZone: "America/Sao_Paulo",
      items: [{ id: "primary" }, { id: "team@example.test" }, { id: "missing@example.test" }],
    });
    expect(result).toEqual({
      timeMin: "2026-10-12T00:00:00.000Z",
      timeMax: "2026-10-13T00:00:00.000Z",
      calendars: [
        { id: "primary", busy: [{ start: "2026-10-12T13:00:00Z", end: "2026-10-12T14:00:00Z" }] },
        { id: "team@example.test", busy: [], errors: [{ reason: "notFound" }] },
        { id: "missing@example.test", busy: [] },
      ],
    });
  });

  test("defaults to the primary calendar", async () => {
    const { calls, handler } = freeBusy(() => respond({ calendars: {} }));
    await handler.execute({
      parameters: { timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-13T00:00:00Z" },
      accessToken: "at-1",
      abortSignal: signal,
    });
    expect(JSON.parse(String(calls[0]!.init.body)).items).toEqual([{ id: "primary" }]);
  });

  test("a Google error becomes a provider error", async () => {
    const { handler } = freeBusy(() => respond({ error: { status: "PERMISSION_DENIED", message: "no" } }, 403));
    const run = handler.execute({
      parameters: { timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-13T00:00:00Z" },
      accessToken: "at-1",
      abortSignal: signal,
    });
    await expect(run).rejects.toBeInstanceOf(AdapterProviderError);
    await expect(run).rejects.toMatchObject({ status: 403, providerCode: "PERMISSION_DENIED" });
  });
});
