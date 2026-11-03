import { AdapterProviderError } from "../../adapters/adapter";
import type { GoogleCapabilityHandler } from "../../adapters/google";

const GCAL_API_BASE = "https://www.googleapis.com/calendar/v3";

export function buildGoogleCalendarHandlers(
  fetchImpl: typeof fetch = fetch,
): Map<string, GoogleCapabilityHandler> {
  return new Map<string, GoogleCapabilityHandler>([
    ["gcal.event.list", gcalEventList(fetchImpl)],
    ["gcal.freebusy.query", gcalFreeBusyQuery(fetchImpl)],
  ]);
}

function gcalEventList(fetchImpl: typeof fetch): GoogleCapabilityHandler {
  return {
    async execute(input) {
      const params = input.parameters as {
        calendarId?: string;
        maxResults?: number;
        pageToken?: string;
        q?: string;
        timeMax?: string;
        timeMin?: string;
      };
      const calendarId = params.calendarId ?? "primary";
      const url = new URL(`${GCAL_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
      if (params.timeMin) url.searchParams.set("timeMin", params.timeMin);
      if (params.timeMax) url.searchParams.set("timeMax", params.timeMax);
      if (params.q) url.searchParams.set("q", params.q);
      if (params.maxResults) url.searchParams.set("maxResults", String(params.maxResults));
      if (params.pageToken) url.searchParams.set("pageToken", params.pageToken);

      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: input.abortSignal,
      });
      return readJsonOrThrow(response);
    },
  };
}

interface GoogleFreeBusyResponse {
  timeMin?: string;
  timeMax?: string;
  calendars?: Record<
    string,
    { busy?: { start?: string; end?: string }[]; errors?: { domain?: string; reason?: string }[] }
  >;
}

/** `POST /freeBusy`: busy intervals per requested calendar, in request order. */
function gcalFreeBusyQuery(fetchImpl: typeof fetch): GoogleCapabilityHandler {
  return {
    async execute(input) {
      const params = input.parameters as {
        timeMin: string;
        timeMax: string;
        calendarIds?: string[];
        timeZone?: string;
      };
      const calendarIds = params.calendarIds?.length ? params.calendarIds : ["primary"];
      const response = await fetchImpl(`${GCAL_API_BASE}/freeBusy`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        signal: input.abortSignal,
        body: JSON.stringify({
          timeMin: params.timeMin,
          timeMax: params.timeMax,
          ...(params.timeZone ? { timeZone: params.timeZone } : {}),
          items: calendarIds.map((id) => ({ id })),
        }),
      });
      const result = (await readJsonOrThrow(response)) as GoogleFreeBusyResponse | null;
      const calendars = result?.calendars ?? {};
      return {
        timeMin: result?.timeMin,
        timeMax: result?.timeMax,
        calendars: calendarIds.map((id) => {
          const entry = calendars[id];
          return {
            id,
            busy: (entry?.busy ?? []).filter((interval) => interval.start && interval.end),
            ...(entry?.errors?.length
              ? { errors: entry.errors.map((error) => ({ reason: error.reason })) }
              : {}),
          };
        }),
      };
    },
  };
}

async function readJsonOrThrow(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) {
    let providerCode: string | null = null;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string; status?: string } };
      providerCode = parsed?.error?.status ?? null;
    } catch {
      /* not JSON */
    }
    throw new AdapterProviderError(response.status, providerCode, "Google Calendar API request failed");
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AdapterProviderError(502, "invalid_response", "Google Calendar returned non-JSON body");
  }
}
