import { ConsoleApiError } from "@/server/console/api-error";

const AUDIENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const MAX_ORIGINS = 8;

export function normalizeViewerAssertionAudience(value: string): string {
  const audience = value.trim();
  if (!AUDIENCE_PATTERN.test(audience) || audience.includes("*")) {
    throw new ConsoleApiError(400, {
      error: "payload_invalid",
      fieldErrors: {
        audience: "Audience must be an exact string without spaces or wildcards.",
      },
    });
  }
  return audience;
}

export function normalizeViewerAssertionOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalidOrigin();
  }

  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) {
    throw invalidOrigin();
  }
  if (url.pathname !== "/" && url.pathname !== "") throw invalidOrigin();
  if (!url.hostname || url.hostname.includes("*")) throw invalidOrigin();

  return url.origin;
}

export function assertViewerAssertionOriginsForSite(origins: string[], hostnames: string[]): string[] {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > MAX_ORIGINS) {
    throw invalidOrigin();
  }

  const allowedHosts = new Set(hostnames.map((hostname) => hostname.trim().toLowerCase()).filter(Boolean));
  const normalized: string[] = [];
  for (const origin of origins) {
    const next = normalizeViewerAssertionOrigin(origin);
    const host = new URL(next).hostname;
    if (!allowedHosts.has(host)) {
      throw new ConsoleApiError(400, {
        error: "payload_invalid",
        fieldErrors: {
          origins: "Each origin must be this site's default hostname or an active custom hostname.",
        },
      });
    }
    if (!normalized.includes(next)) normalized.push(next);
  }

  if (normalized.length < 1) throw invalidOrigin();
  return normalized;
}

export function originMatchesRequestHost(origin: string, requestHost: string): boolean {
  try {
    const normalized = normalizeViewerAssertionOrigin(origin);
    const host = requestHost.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
    return new URL(normalized).hostname === host;
  } catch {
    return false;
  }
}

function invalidOrigin() {
  return new ConsoleApiError(400, {
    error: "payload_invalid",
    fieldErrors: {
      origins: "Origins must be https://host values with no path, port, or wildcard.",
    },
  });
}
