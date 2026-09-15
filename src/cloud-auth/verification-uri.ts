const USER_CODE_PARAM = "user_code";

/**
 * Build the device-authorization URL that binds a pending grant.
 * Console's `/cli/authorize` page only attaches the device code when
 * `user_code` is present on the query string.
 */
export function completeVerificationUri(verificationUri: string, userCode: string): string {
  const uri = verificationUri.trim();
  const code = userCode.trim();
  if (!uri || !code) return uri;

  try {
    const url = new URL(uri);
    if (url.searchParams.get(USER_CODE_PARAM) === code) return uri;
    url.searchParams.set(USER_CODE_PARAM, code);
    return url.toString();
  } catch {
    return appendUserCodeToOpaqueUri(uri, code);
  }
}

function appendUserCodeToOpaqueUri(uri: string, code: string): string {
  const hashIndex = uri.indexOf("#");
  const beforeHash = hashIndex >= 0 ? uri.slice(0, hashIndex) : uri;
  const hash = hashIndex >= 0 ? uri.slice(hashIndex) : "";
  const queryIndex = beforeHash.indexOf("?");
  const path = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : "";
  const params = new URLSearchParams(query);
  if (params.get(USER_CODE_PARAM) === code) return uri;
  params.set(USER_CODE_PARAM, code);
  return `${path}?${params.toString()}${hash}`;
}
