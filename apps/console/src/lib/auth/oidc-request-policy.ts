/** Public machine endpoints authenticate independently; this policy is for
 * requests using the Console's browser session, including internal approvals. */
export function oidcBrowserRequestAllowed(method: string, origin: string | null, consoleOrigin: string) {
  return ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) || origin === consoleOrigin;
}

/** Do not start or end authentication from an image, iframe, fetch or prefetch.
 * Older user agents without Fetch Metadata still rely on state/PKCE/cookie rules. */
export function oidcInteractiveNavigationAllowed(headers: Headers) {
  const destination = headers.get("sec-fetch-dest");
  return destination === null || (destination === "document" && headers.get("sec-fetch-mode") === "navigate");
}
