import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import {
  getInternalControlFeatures,
  getInternalControlOrganization,
  getInternalControlSummary,
  getInternalControlUser,
  listInternalControlOrganizations,
  listInternalControlUsers,
} from "@/server/console/internal-control";

type RouteContext = {
  params: Promise<{ segments?: string[] }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const segments = (await context.params).segments ?? [];

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });

    if (segments.length === 0 || matches(segments, "summary")) {
      return cliSuccess(await getInternalControlSummary({ auth }));
    }

    if (matches(segments, "features")) {
      return cliSuccess(await getInternalControlFeatures({ auth }));
    }

    if (matches(segments, "orgs")) {
      const searchParams = new URL(request.url).searchParams;
      return cliSuccess(
        await listInternalControlOrganizations({
          auth,
          limit: parseLimit(searchParams),
          query: searchParams.get("query") ?? searchParams.get("q"),
        }),
      );
    }

    if (matches(segments, "orgs", ":orgRef", "features")) {
      return cliSuccess(
        await getInternalControlFeatures({
          auth,
          organizationRef: segments[1]!,
        }),
      );
    }

    if (matches(segments, "orgs", ":orgRef")) {
      return cliSuccess(
        await getInternalControlOrganization({
          auth,
          organizationRef: segments[1]!,
        }),
      );
    }

    if (matches(segments, "users")) {
      const searchParams = new URL(request.url).searchParams;
      return cliSuccess(
        await listInternalControlUsers({
          auth,
          limit: parseLimit(searchParams),
          query: searchParams.get("query") ?? searchParams.get("q"),
        }),
      );
    }

    if (matches(segments, "users", ":userRef")) {
      return cliSuccess(
        await getInternalControlUser({
          auth,
          userRef: segments[1]!,
        }),
      );
    }

    throw cliApiError(404, "PAYLOAD_INVALID", "Unknown internal control CLI route.");
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

function matches(segments: string[], ...pattern: string[]) {
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}

function parseLimit(searchParams: URLSearchParams) {
  const raw = searchParams.get("limit");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return value;
}
