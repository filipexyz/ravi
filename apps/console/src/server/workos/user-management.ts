export const WORKOS_USER_MANAGEMENT_API_ORIGIN = "https://api.workos.com";

export type WorkosUserManagementMetadataFailureReason =
  | "missing_api_key"
  | "invalid_user_id"
  | "request_failed"
  | "bad_status"
  | "invalid_payload";

export type WorkosUserManagementMetadataResult =
  | { ok: true; metadata: Record<string, unknown> }
  | { ok: false; reason: WorkosUserManagementMetadataFailureReason };

export function isWorkosUserManagementUserId(value: string): boolean {
  return /^user_[A-Za-z0-9]+$/.test(value);
}

export function workosUserManagementUserUrl(workosUserId: string): string {
  return `${WORKOS_USER_MANAGEMENT_API_ORIGIN}/user_management/users/${encodeURIComponent(workosUserId)}`;
}

export async function fetchWorkosUserManagementMetadata(
  workosUserId: string,
  options: {
    apiKey?: string;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<WorkosUserManagementMetadataResult> {
  if (!isWorkosUserManagementUserId(workosUserId)) {
    return { ok: false, reason: "invalid_user_id" };
  }

  const apiKey = options.apiKey ?? process.env.WORKOS_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, reason: "missing_api_key" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(workosUserManagementUserUrl(workosUserId), {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });
  } catch (error) {
    console.error("WorkOS user-management metadata lookup failed", {
      reason: "request_failed",
      errorName: error instanceof Error ? error.name : "unknown",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: "request_failed" };
  }

  if (!response.ok) {
    console.error("WorkOS user-management metadata lookup failed", {
      reason: "bad_status",
      status: response.status,
    });
    return { ok: false, reason: "bad_status" };
  }

  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "invalid_payload" };
  }

  return {
    ok: true,
    metadata: metadataFromUserManagementPayload(payload as Record<string, unknown>),
  };
}

function metadataFromUserManagementPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}
