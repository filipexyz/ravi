import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authenticateCliRequest, type CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  ackInboxItems,
  buildInboxPulseEtag,
  getInboxPulse,
  pollInbox,
  upsertGlobalInboxSubscription,
  type AgentInboxWorkspace,
  type InboxPollAckInput,
} from "@/server/console/agent-inbox";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

const pollBodySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  subscriptionId: z.string().min(1).optional(),
});

const ackItemSchema = z.object({
  errorCode: z.string().min(1).max(120).optional(),
  itemId: z.string().min(1),
  leaseId: z.string().min(1).optional(),
  localEventId: z.string().min(1).max(240).optional(),
  status: z.enum(["delivered", "read", "resolved", "failed", "skipped"]).optional(),
});

const ackBodySchema = z.object({
  acks: z.array(ackItemSchema).optional(),
  items: z.array(ackItemSchema).optional(),
  itemIds: z.array(z.string().min(1)).optional(),
  subscriptionId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    if (!matches(segments, "pulse")) {
      throw cliApiError(404, "PAYLOAD_INVALID", "Unknown inbox CLI route.");
    }

    const auth = await authenticateCliRequest(request, requestId, { touch: false, actor: "contact" });
    requireScope(auth, "console.inbox.read");
    const pulse = await getInboxPulse({
      subscriptionId: new URL(request.url).searchParams.get("subscriptionId"),
      workspace: workspaceFromCliAuth(auth),
    });
    const headers = pulseHeaders(pulse, requestId);
    if (
      isPulseFresh(
        request,
        headers.get("etag"),
        pulse.watermark.generation,
        pulse.subscription?.lastDeliveredSequence ?? null,
        pulse.watermark.latestSequence,
      )
    ) {
      return new NextResponse(null, { status: 304, headers });
    }

    return cliSuccess(pulse, { headers });
  } catch (error) {
    return cliFailure(inboxCliError(error), requestId);
  }
}

export async function HEAD(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    if (!matches(segments, "pulse")) {
      throw cliApiError(404, "PAYLOAD_INVALID", "Unknown inbox CLI route.");
    }

    const auth = await authenticateCliRequest(request, requestId, { touch: false, actor: "contact" });
    requireScope(auth, "console.inbox.read");
    const pulse = await getInboxPulse({
      subscriptionId: new URL(request.url).searchParams.get("subscriptionId"),
      workspace: workspaceFromCliAuth(auth),
    });
    const headers = pulseHeaders(pulse, requestId);
    if (
      isPulseFresh(
        request,
        headers.get("etag"),
        pulse.watermark.generation,
        pulse.subscription?.lastDeliveredSequence ?? null,
        pulse.watermark.latestSequence,
      )
    ) {
      return new NextResponse(null, { status: 304, headers });
    }

    return new NextResponse(null, { status: 204, headers });
  } catch (error) {
    return cliFailure(inboxCliError(error), requestId);
  }
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "contact" });
    requireScope(auth, "console.inbox.subscribe");

    if (matches(segments, "subscriptions", "global")) {
      return cliSuccess(
        await upsertGlobalInboxSubscription({
          body: await optionalJsonBody(request, requestId),
          workspace: workspaceFromCliAuth(auth),
        }),
        { status: 201 },
      );
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown inbox CLI route.");
  } catch (error) {
    return cliFailure(inboxCliError(error), requestId);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "contact" });
    const workspace = workspaceFromCliAuth(auth);

    if (matches(segments, "poll")) {
      requireScope(auth, "console.inbox.deliver");
      const body = pollBodySchema.optional().parse(await optionalJsonBody(request, requestId)) ?? {};
      const searchParams = new URL(request.url).searchParams;
      return cliSuccess(
        await pollInbox({
          limit: body.limit ?? parseLimit(searchParams),
          subscriptionId: body.subscriptionId ?? searchParams.get("subscriptionId"),
          workspace,
        }),
      );
    }

    if (matches(segments, "ack")) {
      requireScope(auth, "console.inbox.ack");
      const body = parseAckBody(await readJsonBody(request, requestId));
      return cliSuccess(
        await ackInboxItems({
          acks: body.acks,
          subscriptionId: body.subscriptionId,
          workspace,
        }),
      );
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown inbox CLI route.");
  } catch (error) {
    return cliFailure(inboxCliError(error), requestId);
  }
}

function workspaceFromCliAuth(auth: CliAuthContext): AgentInboxWorkspace {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    user: { id: auth.user.id },
    organization: {
      id: auth.organization.id,
      name: auth.organization.name,
      slug: auth.organization.slug,
    },
    membership: { role },
    localInstallation: {
      id: auth.localInstallation.id,
      name: auth.localInstallation.name,
      capabilitiesJson: auth.scopes,
    },
  };
}

function requireScope(auth: CliAuthContext, scope: string) {
  if (!auth.scopes.includes(scope)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
}

function parseAckBody(body: unknown): { acks: InboxPollAckInput[]; subscriptionId?: string } {
  const parsed = ackBodySchema.parse(body);
  const acks =
    parsed.acks ??
    parsed.items ??
    parsed.itemIds?.map((itemId) => ({
      itemId,
      status: "delivered" as const,
    })) ??
    [];
  if (acks.length === 0) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Ack requires at least one item.");
  }
  return {
    acks,
    subscriptionId: parsed.subscriptionId,
  };
}

async function optionalJsonBody(request: NextRequest, requestId: string) {
  const contentLength = request.headers.get("content-length");
  if (contentLength === "0") return undefined;
  try {
    return await readJsonBody(request, requestId);
  } catch (error) {
    if (!contentLength) return undefined;
    throw error;
  }
}

function parseLimit(searchParams: URLSearchParams) {
  const raw = searchParams.get("limit");
  if (!raw) return undefined;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Invalid inbox poll limit.");
  }
  return limit;
}

function pulseHeaders(pulse: Awaited<ReturnType<typeof getInboxPulse>>, requestId: string) {
  const headers = new Headers();
  const subscriptionCursor = pulse.subscription?.lastDeliveredSequence ?? null;
  headers.set("cache-control", "private, max-age=10, stale-while-revalidate=30");
  headers.set("etag", buildInboxPulseEtag({
    ...pulse.watermark,
    subscriptionCursor,
    subscriptionId: pulse.subscription?.id ?? null,
    subscribed: pulse.subscribed,
  }));
  headers.set("x-ravi-inbox-generation", String(pulse.watermark.generation));
  headers.set("x-ravi-inbox-latest-sequence", String(pulse.watermark.latestSequence));
  if (subscriptionCursor !== null) {
    headers.set("x-ravi-inbox-last-delivered-sequence", String(subscriptionCursor));
  }
  headers.set("x-request-id", requestId);
  return headers;
}

function isPulseFresh(
  request: NextRequest,
  etag: string | null,
  generation: number,
  subscriptionCursor: number | null,
  latestSequence: number,
) {
  // Never report fresh while the subscription still has items to deliver.
  // Without this guard, a daemon that advanced its local generation in
  // markSubscriptionPolled without actually delivering items can get
  // permanently stuck on 304: both sides agree on (generation, cursor)
  // even though subscriptionCursor < latestSequence.
  if (subscriptionCursor === null || subscriptionCursor < latestSequence) return false;

  const ifNoneMatch = request.headers.get("if-none-match");
  if (etag && ifNoneMatch?.split(",").map((value) => value.trim()).includes(etag)) return true;

  const clientGeneration = request.headers.get("x-ravi-inbox-generation");
  const clientCursor = request.headers.get("x-ravi-inbox-last-delivered-sequence");
  return (
    clientGeneration === String(generation) &&
    clientCursor !== null &&
    clientCursor === String(subscriptionCursor)
  );
}

function matches(segments: string[], ...pattern: string[]) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}

function inboxCliError(error: unknown) {
  if (error instanceof z.ZodError) return cliApiError(400, "PAYLOAD_INVALID");
  return error;
}
