import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { CliApiError } from "@/server/cli/errors";
import { ConsoleApiError } from "@/server/console/api-error";
import { openSharedMeetingMedia, readSharedMeeting } from "@/server/console/meetings/sharing";
import { ConsoleEmailVerificationRequiredError, getConsoleUserFromAuth } from "@/server/console/workspace";

// A meeting for whoever signed in may see it, outside any organization
// workspace (`/shared/meetings/<id>`):
//
//   GET shared/meetings/:id                the meeting and, once done, its recording
//   GET shared/meetings/:id/media/:kind    the audio or video, streamed (?part=N, ?inline=1)

type RouteContext = {
  params: Promise<{ meetingId: string; segments?: string[] }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Media plays through this route.
export const maxDuration = 800;

export async function GET(request: NextRequest, context: RouteContext) {
  const { meetingId, segments = [] } = await context.params;
  const auth = await getConsoleApiAuthState();
  if (!auth) return noStore(NextResponse.json({ error: "unauthenticated" }, { status: 401 }));
  const requestId = request.headers.get("x-request-id") ?? randomUUID();

  try {
    const user = await getConsoleUserFromAuth(auth);
    if (segments.length === 0) {
      return noStore(NextResponse.json(await readSharedMeeting({ meetingId, requestId, userId: user.id })));
    }
    if (segments.length === 2 && segments[0] === "media") {
      const stream = await openSharedMeetingMedia({
        meetingId,
        userId: user.id,
        kind: segments[1] ?? "",
        part: Number(request.nextUrl.searchParams.get("part") ?? "0"),
        range: request.headers.get("range"),
        disposition: request.nextUrl.searchParams.get("inline") === "1" ? "inline" : "attachment",
      });
      return noStore(new Response(stream.body, { status: stream.status, headers: stream.headers }));
    }
    return noStore(NextResponse.json({ error: "NOT_FOUND" }, { status: 404 }));
  } catch (error) {
    if (error instanceof CliApiError) {
      return noStore(
        NextResponse.json(
          { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
          { status: error.status },
        ),
      );
    }
    if (error instanceof ConsoleApiError) return noStore(NextResponse.json(error.payload, { status: error.status }));
    if (error instanceof ConsoleEmailVerificationRequiredError) {
      return noStore(NextResponse.json({ error: "email_verification_required" }, { status: 403 }));
    }
    console.error("Shared meeting request failed", { error, requestId, segments });
    return noStore(NextResponse.json({ error: "internal_error" }, { status: 500 }));
  }
}

function noStore<T extends Response>(response: T): T {
  response.headers.set("cache-control", "no-store");
  return response;
}
