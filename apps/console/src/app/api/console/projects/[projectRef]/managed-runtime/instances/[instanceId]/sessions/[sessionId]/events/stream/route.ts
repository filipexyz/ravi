import { NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import {
  createManagedRuntimeEventStream,
  managedRuntimeEventCursor,
} from "@/server/console/managed-runtime-event-stream";
import { createManagedRuntimeStreamSource } from "@/server/console/managed-runtime-stream-source";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleWorkspace,
} from "@/server/console/workspace";
import { requestOrganizationRef } from "@/server/console/request-workspace";

type RouteContext = {
  params: Promise<{
    projectRef: string;
    instanceId: string;
    sessionId: string;
  }>;
};

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const { projectRef, instanceId, sessionId } = await context.params;
  const initialSequence = managedRuntimeEventCursor({
    after: request.nextUrl.searchParams.get("after"),
    lastEventId: request.headers.get("last-event-id"),
  });

  try {
    const source = await createManagedRuntimeStreamSource({
      instanceId, projectRef, sessionId,
      resolveWorkspace: async () => {
        const auth = await getConsoleApiAuthState();
        if (!auth) return null;
        const workspace = await getConsoleWorkspace(auth, {
          organizationRef: requestOrganizationRef(request),
        });
        await assertConsoleFeatureAccess(workspace, "console.managed_runtime");
        return workspace;
      },
    });
    const initialPage = await source.loadEvents(initialSequence);
    const stream = createManagedRuntimeEventStream({
      initialPage,
      initialSequence,
      loadEvents: source.loadEvents,
      authorizeEmission: source.authorizeEmission,
      signal: request.signal,
    });

    return new Response(stream, {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("Managed Ravi event stream failed", {
      error,
      instanceId,
      projectRef,
      sessionId,
    });
    return NextResponse.json(
      { error: "managed_runtime_stream_unavailable" },
      { status: 503 },
    );
  }
}
