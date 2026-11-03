/** Credential/setup/SSO surfaces opt out of external error/trace/replay data. */
export function fleetPrivateUrl(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const path = new URL(value, "https://console.invalid").pathname;
    return path === "/setup" || path.startsWith("/api/setup/") || path === "/callback" || path.startsWith("/callback/") ||
      path === "/api/console/fleet" || path.startsWith("/api/console/fleet/") || /\/(credentials|sso|installations|onboarding)(\/|$)/.test(path);
  } catch { return false; }
}
