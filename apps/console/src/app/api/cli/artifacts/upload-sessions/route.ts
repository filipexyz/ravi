import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { pagePublishCliError } from "@/server/console/pages/cli-errors";
import {
  cliPublishContextFromAuth,
  createPageUploadSession,
} from "@/server/console/pages/publish";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const body = await readJsonBody(request, requestId);
    const context = cliPublishContextFromAuth(auth);

    return cliSuccess(
      serializePagePayload(
        await createPageUploadSession({
          context,
          input: body as Parameters<typeof createPageUploadSession>[0]["input"],
          requestId,
        }),
      ),
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(pagePublishCliError(error), requestId);
    }
    return cliFailure(error, requestId);
  }
}

function serializePagePayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializePagePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializePagePayload(item)]),
    );
  }
  return value;
}
