import { type NextRequest } from "next/server";

import { getCliMe } from "@/server/cli/auth";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    return cliSuccess(await getCliMe({ request, requestId }));
  } catch (error) {
    return cliFailure(error, requestId);
  }
}
