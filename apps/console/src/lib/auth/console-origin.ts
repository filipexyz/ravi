import { getOidcOrigin, oidcModeEnabled } from "./oidc-config";
import { safeAuthReturnTo } from "./return-to";

/** OIDC has a fixed installation origin. Never derive it from proxy headers. */
export function consoleBrowserOrigin(requestUrl: string) {
  return oidcModeEnabled() ? getOidcOrigin() : new URL(requestUrl).origin;
}

export function consoleRedirectUrl(path: string, requestUrl: string) {
  const localPath = safeAuthReturnTo(path);
  if (!localPath) throw new Error("Console redirect must be a local path.");
  const origin = consoleBrowserOrigin(requestUrl);
  const target = new URL(localPath, origin);
  if (target.origin !== origin) throw new Error("Console redirect origin rejected.");
  return target;
}

export function isConsoleMutationOrigin(request: { url: string; headers: Headers }) {
  const origin = request.headers.get("origin");
  if (oidcModeEnabled()) return origin === consoleBrowserOrigin(request.url);
  // Preserve the hosted WorkOS behavior, including older clients without Origin.
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}
