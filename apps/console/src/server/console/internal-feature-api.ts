import { NextResponse } from "next/server";

import type { ConsoleFeatureKey } from "@/features/console/types";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import type { ConsoleWorkspace } from "@/server/console/workspace";

export async function assertInternalConsoleFeature(
  workspace: ConsoleWorkspace,
  featureKey: ConsoleFeatureKey,
  requestId: string,
): Promise<NextResponse | null> {
  try {
    await assertConsoleFeatureAccess(workspace, featureKey);
    return null;
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return NextResponse.json(
        { status: "error", code: error.payload.error },
        { status: error.status, headers: { "x-request-id": requestId } },
      );
    }
    throw error;
  }
}
