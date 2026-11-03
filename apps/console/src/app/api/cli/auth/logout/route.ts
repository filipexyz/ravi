import { type NextRequest } from "next/server";

import { logoutCliAuth } from "@/server/cli/auth";
import { cliFailure, cliNoContent, requestIdFrom } from "@/server/cli/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    await logoutCliAuth({ request, requestId });
    return cliNoContent();
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
