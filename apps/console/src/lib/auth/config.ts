export function isWorkOSConfigured() {
  if (process.env.RAVI_AUTH_MODE && process.env.RAVI_AUTH_MODE !== "workos") return false;
  return Boolean(
    process.env.WORKOS_API_KEY &&
      process.env.WORKOS_CLIENT_ID &&
      process.env.WORKOS_COOKIE_PASSWORD &&
      process.env.WORKOS_COOKIE_PASSWORD.length >= 32,
  );
}

export function isAnonymousModeEnabled() {
  if (process.env.RAVI_AUTH_MODE && process.env.RAVI_AUTH_MODE !== "anonymous") return false;
  if (process.env.RAVI_CONSOLE_ANONYMOUS_MODE !== "true") return false;
  return !isHostedOrProductionRuntime();
}

export function isHostedOrProductionRuntime() {
  return Boolean(
    process.env.VERCEL ||
      process.env.VERCEL_ENV ||
      process.env.NODE_ENV === "production",
  );
}

export function configuredWorkOSRedirectUri() {
  return (
    normalizeRedirectUri(process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI) ||
    normalizeRedirectUri(process.env.WORKOS_REDIRECT_URI) ||
    callbackUrlFromBaseUrl(process.env.NEXT_PUBLIC_CONSOLE_URL) ||
    callbackUrlFromBaseUrl(process.env.VERCEL_PROJECT_PRODUCTION_URL) ||
    callbackUrlFromBaseUrl(process.env.VERCEL_BRANCH_URL) ||
    callbackUrlFromBaseUrl(process.env.VERCEL_URL)
  );
}

function callbackUrlFromBaseUrl(value: string | undefined) {
  const url = normalizeRedirectUri(value);
  if (!url) return undefined;
  return new URL("/callback", url).toString();
}

function normalizeRedirectUri(value: string | undefined) {
  if (!value) return undefined;
  const input = value.trim();
  const base = input.startsWith("http://") || input.startsWith("https://") ? input : `https://${input}`;
  try {
    const url = new URL(base);
    if (url.pathname === "/") url.pathname = "/callback";
    return url.toString();
  } catch {
    return undefined;
  }
}
