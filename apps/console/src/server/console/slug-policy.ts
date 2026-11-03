export type SlugRejectionReason =
  | "missing"
  | "invalid_characters"
  | "invalid_length"
  | "reserved_exact"
  | "reserved_prefix"
  | "reserved_suffix"
  | "security_sensitive"
  | "dns_unsafe"
  | "uuid_like"
  | "provider_id_like"
  | "ipv4_like"
  | "numeric_only"
  | "namespace_conflict"
  | "risk_rule";

export type PublicSlugErrorCode = "slug_unavailable";

export type SlugValidationResult =
  | {
      ok: true;
      slug: string;
    }
  | {
      ok: false;
      reason: SlugRejectionReason;
      publicError: PublicSlugErrorCode;
    };

export type SlugPolicyOptions = {
  dnsLabel?: boolean;
  maxLength?: number;
  existingSlugs?: Iterable<string>;
  /**
   * When set, slugs that equal the owner org's slug or begin with
   * `${ownerOrganizationSlug}-` are not blocked by the reserved-exact,
   * reserved-prefix, reserved-suffix, or security-sensitive lists. The org
   * is the legitimate holder of its own namespace even if its name was later
   * added to those lists.
   */
  ownerOrganizationSlug?: string;
};

export const PUBLIC_SLUG_UNAVAILABLE = {
  error: "slug_unavailable",
  fieldErrors: {
    slug: "This slug is unavailable.",
  },
} as const;

const RESERVED_EXACT = new Set([
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "apps",
  "asset",
  "assets",
  "auth",
  "billing",
  "blog",
  "callback",
  "cdn",
  "cloud",
  "console",
  "dashboard",
  "deploy",
  "deployment",
  "deployments",
  "dev",
  "docs",
  "domain",
  "domains",
  "edge",
  "enterprise",
  "error",
  "events",
  "help",
  "home",
  "internal",
  "invite",
  "login",
  "logout",
  "me",
  "new",
  "oauth",
  "org",
  "organization",
  "organizations",
  "preview",
  "pricing",
  "privacy",
  "project",
  "projects",
  "public",
  "ravi",
  "ravi-bot",
  "ravi-cloud",
  "ravi-console",
  "ravi-page",
  "ravi-pages",
  "root",
  "settings",
  "shared",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "static",
  "status",
  "support",
  "sys",
  "system",
  "team",
  "teams",
  "terms",
  "token",
  "tokens",
  "user",
  "users",
  "webhook",
  "webhooks",
  "www",
]);

const RESERVED_PREFIXES = [
  "admin-",
  "api-",
  "auth-",
  "billing-",
  "console-",
  "internal-",
  "ravi-",
  "root-",
  "sys-",
  "system-",
  "www-",
  "art-",
  "artv-",
  "artva-",
  "dep-",
  "env-",
  "org-",
  "proj-",
  "usr-",
];

const RESERVED_SUFFIXES = [
  "-admin",
  "-api",
  "-auth",
  "-billing",
  "-cdn",
  "-internal",
  "-root",
  "-system",
  "-www",
];

const SECURITY_SENSITIVE = new Set([
  "acme-challenge",
  "autoconfig",
  "autodiscover",
  "config",
  "dns",
  "ftp",
  "imap",
  "mail",
  "mx",
  "ns",
  "pop",
  "smtp",
  "ssh",
  "ssl",
  "tls",
  "well-known",
]);

const UUID_LIKE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IPV4_LIKE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const PROVIDER_ID_LIKE = /^(workos|authkit|clerk|stripe|github|gh|org|user|team|acct|cus)[_-][a-z0-9_-]{6,}$/i;

export function validateSlugPolicy(
  slug: string | undefined,
  options: SlugPolicyOptions = {},
): SlugValidationResult {
  const reason = getSlugRejectionReason(slug, options);
  if (reason) {
    return {
      ok: false,
      reason,
      publicError: "slug_unavailable",
    };
  }

  return {
    ok: true,
    slug: slug as string,
  };
}

export function getSlugRejectionReason(
  slug: string | undefined,
  {
    dnsLabel = true,
    existingSlugs,
    maxLength = dnsLabel ? 63 : 80,
    ownerOrganizationSlug,
  }: SlugPolicyOptions = {},
): SlugRejectionReason | null {
  if (!slug) return "missing";
  if (slug.length < 2) return "invalid_length";
  if (dnsLabel && slug.length > 63) return "dns_unsafe";
  if (slug.length > maxLength) return dnsLabel ? "dns_unsafe" : "invalid_length";
  if (UUID_LIKE.test(slug)) return "uuid_like";
  if (IPV4_LIKE.test(slug)) return "ipv4_like";
  if (/^\d+$/.test(slug)) return "numeric_only";
  if (PROVIDER_ID_LIKE.test(slug)) return "provider_id_like";
  if (!/^[a-z0-9-]+$/.test(slug)) return "invalid_characters";
  if (!/^[a-z0-9]/.test(slug) || !/[a-z0-9]$/.test(slug) || slug.includes("--")) {
    return "invalid_characters";
  }
  const ownerSlug = ownerOrganizationSlug?.trim().toLowerCase();
  const ownedByOrg = Boolean(ownerSlug) && (slug === ownerSlug || slug.startsWith(`${ownerSlug}-`));
  if (!ownedByOrg) {
    if (RESERVED_EXACT.has(slug)) return "reserved_exact";
    if (RESERVED_PREFIXES.some((prefix) => slug.startsWith(prefix))) return "reserved_prefix";
    if (RESERVED_SUFFIXES.some((suffix) => slug.endsWith(suffix))) return "reserved_suffix";
    if (SECURITY_SENSITIVE.has(slug)) return "security_sensitive";
  }
  if (existingSlugs && new Set(existingSlugs).has(slug)) return "namespace_conflict";
  return null;
}

export function publicSlugError() {
  return PUBLIC_SLUG_UNAVAILABLE;
}
