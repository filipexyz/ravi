/**
 * Media-send Omni auth failures.
 *
 * The Omni CLI authenticates from `servers.list.<active>.apiKey`, which can
 * diverge from the top-level / `OMNI_API_KEY` the Ravi runtime uses. Keep the
 * public contract stable and free of provider payloads / key material.
 */

export const OMNI_AUTH_FAILED_CODE = "OMNI_AUTH_FAILED";
export const MEDIA_SEND_FAILED_CODE = "MEDIA_SEND_FAILED";
export const FILE_NOT_FOUND_CODE = "FILE_NOT_FOUND";

export const OMNI_AUTH_FAILED_MESSAGE = "Omni rejected the API key used to send media.";

export const MEDIA_SEND_FAILED_MESSAGE = "Media delivery failed.";

export const FILE_NOT_FOUND_MESSAGE = "Media file was not found.";

export const OMNI_AUTH_FAILED_SUGGESTED_ACTION =
  "Omni rejected the API key (401 Invalid API key). Ravi's runtime uses OMNI_API_KEY or the top-level apiKey in ~/.omni/config.json, but the Omni CLI prefers servers.list.<active>.apiKey. Align those keys (copy the live primary into the active server entry, or set OMNI_API_URL and OMNI_API_KEY) and retry.";

export const MEDIA_SEND_FAILED_SUGGESTED_ACTION =
  "Check the target (--account/--to or session context) and channel availability, then retry";

export const FILE_NOT_FOUND_SUGGESTED_ACTION =
  "Check the local file path (the file must exist on this machine) and re-run";

const MEDIA_SEND_REMOTE_CATALOG: Record<string, { message: string; suggestedAction: string }> = {
  [MEDIA_SEND_FAILED_CODE]: {
    message: MEDIA_SEND_FAILED_MESSAGE,
    suggestedAction: MEDIA_SEND_FAILED_SUGGESTED_ACTION,
  },
  [OMNI_AUTH_FAILED_CODE]: {
    message: OMNI_AUTH_FAILED_MESSAGE,
    suggestedAction: OMNI_AUTH_FAILED_SUGGESTED_ACTION,
  },
  [FILE_NOT_FOUND_CODE]: {
    message: FILE_NOT_FOUND_MESSAGE,
    suggestedAction: FILE_NOT_FOUND_SUGGESTED_ACTION,
  },
};

/** Local catalog copy for isolated remote `media send` failures. Never echoes remote text. */
export function localMediaSendCatalogCopy(code: string): { message: string; suggestedAction: string } | undefined {
  return MEDIA_SEND_REMOTE_CATALOG[code];
}

export class MediaSendAuthError extends Error {
  readonly code = OMNI_AUTH_FAILED_CODE;

  constructor() {
    super(OMNI_AUTH_FAILED_MESSAGE);
    this.name = "MediaSendAuthError";
  }
}

export interface MediaSendFailureMapping {
  code: typeof OMNI_AUTH_FAILED_CODE | typeof MEDIA_SEND_FAILED_CODE;
  message: string;
  retryable: boolean;
  suggestedAction: string;
}

function isAuthStatus(value: unknown): boolean {
  return value === 401 || value === "401";
}

function looksLikeAuthCode(code: string): boolean {
  return /^(unauthorized|unauthenticated|invalid_api_key|invalidapikey|auth_failed|authfailed)$/i.test(code);
}

function looksLikeAuthFailure(text: string): boolean {
  if (/invalid api key/i.test(text)) return true;
  if (/api key is invalid/i.test(text)) return true;
  if (/api error:\s*401\b/i.test(text)) return true;
  return /unauthorized/i.test(text) && /api key/i.test(text);
}

function inspectAuthPayload(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return looksLikeAuthFailure(value) || looksLikeAuthCode(value);
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (isAuthStatus(record.status) || isAuthStatus(record.statusCode)) return true;
  if (typeof record.code === "string" && looksLikeAuthCode(record.code)) return true;
  if (typeof record.error === "string" && (looksLikeAuthFailure(record.error) || looksLikeAuthCode(record.error))) {
    return true;
  }
  if (typeof record.message === "string" && looksLikeAuthFailure(record.message)) return true;
  if (record.error && typeof record.error === "object") return inspectAuthPayload(record.error);
  return false;
}

function inspectAuthText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (inspectAuthPayload(parsed)) return true;
  } catch {
    // Fall through to plaintext checks. Do not treat a bare "401" as auth —
    // that can appear in filenames or unrelated status lines.
  }
  return looksLikeAuthFailure(trimmed);
}

/** True when Omni CLI stdout/stderr (JSON or plaintext) reports an invalid API key / 401. */
export function isOmniCliAuthFailure(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => typeof text === "string" && inspectAuthText(text));
}

export function isMediaSendAuthError(error: unknown): boolean {
  return error instanceof MediaSendAuthError || (error instanceof Error && error.name === "MediaSendAuthError");
}

export function mapMediaSendFailure(error: unknown): MediaSendFailureMapping {
  if (isMediaSendAuthError(error)) {
    return {
      code: OMNI_AUTH_FAILED_CODE,
      message: OMNI_AUTH_FAILED_MESSAGE,
      retryable: false,
      suggestedAction: OMNI_AUTH_FAILED_SUGGESTED_ACTION,
    };
  }
  return {
    code: MEDIA_SEND_FAILED_CODE,
    message: MEDIA_SEND_FAILED_MESSAGE,
    retryable: true,
    suggestedAction: MEDIA_SEND_FAILED_SUGGESTED_ACTION,
  };
}
