import type { DomainBindingSummary, DomainClaimSummary } from "@/features/console/types";
import type { Tone } from "@/ui/badge";

export type DnsRecord = { name: string; type: string; value: string };

export type DomainState = "ready" | "dns_missing" | "waiting_certificate" | "needs_support";

export type BindingView = {
  binding: DomainBindingSummary;
  state: DomainState;
  label: string;
  tone: Tone;
  /** The next step, in one sentence. */
  message: string;
  /** DNS records still to add, when the next step is DNS. */
  records: DnsRecord[];
  /** Apex hostnames send visitors to the www hostname. */
  redirectTo: string | null;
};

const SUPPORT_REASONS = new Set([
  "cloudflare_custom_hostname_adapter_unconfigured",
  "cloudflare_custom_hostname_provider_unauthorized",
  "cloudflare_custom_hostname_zone_unavailable",
]);

const PROVIDER_RETRY_REASONS = new Set([
  "cloudflare_custom_hostname_provider_failed",
  "cloudflare_custom_hostname_provider_rate_limited",
]);

/** Certificate states that only need time, once the hostname itself points to Ravi. */
const CERTIFICATE_WAIT_STATES = new Set(["initializing", "pending_issuance", "pending_deployment"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

export function bindingSiteId(binding: DomainBindingSummary) {
  return text(record(binding.readiness).siteId);
}

export function bindingIsReady(binding: DomainBindingSummary) {
  const readinessStatus = text(record(binding.readiness).status) ?? binding.status;
  return binding.status === "active" || readinessStatus === "ready";
}

function bindingDnsRecords(binding: DomainBindingSummary): DnsRecord[] {
  const dns = record(record(binding.readiness).dns);
  const records = Array.isArray(dns.records) ? dns.records : [];
  const parsed = records.flatMap((item) => {
    const entry = record(item);
    const type = text(entry.type);
    const name = text(entry.name);
    const value = text(entry.value);
    return type && name && value ? [{ name, type: type.toUpperCase(), value }] : [];
  });
  return parsed.length ? parsed : [pagesHostnameRecord(binding.hostname)];
}

const PAGES_CNAME_TARGET = "cname.ravi.page";

/** The CNAME that points one hostname to Ravi Pages. */
export function pagesHostnameRecord(hostname: string): DnsRecord {
  return { name: hostname, type: "CNAME", value: PAGES_CNAME_TARGET };
}

/**
 * The wildcard record that makes every subdomain next to this hostname reach
 * Ravi Pages, so later hostnames skip the DNS step. Null for wildcards, for the
 * domain itself, and outside the proven domain.
 */
export function globalHostRecord(hostname: string, claimDomain: string | null): DnsRecord | null {
  if (!claimDomain || hostname.startsWith("*.") || hostname === claimDomain) return null;
  const parent = hostname.slice(hostname.indexOf(".") + 1);
  if (!hostnameIsWithinClaim(parent, claimDomain)) return null;
  return { name: `*.${parent}`, type: "CNAME", value: PAGES_CNAME_TARGET };
}

/** One state in words for a hostname bound to Pages, and what to do next. */
export function describeBinding(binding: DomainBindingSummary): BindingView {
  const readiness = record(binding.readiness);
  const edge = record(readiness.edge);
  const reason = text(readiness.reason) ?? text(edge.reason);
  const redirectTo = readiness.mode === "redirect" ? text(readiness.redirectToHostname) : null;
  const base = { binding, records: [] as DnsRecord[], redirectTo };

  if (bindingIsReady(binding)) {
    return {
      ...base,
      label: "Ready",
      message: redirectTo ? `Visitors are sent to ${redirectTo}.` : "Pages on this host open at this address.",
      state: "ready",
      tone: "ok",
    };
  }
  if (binding.status === "failed" || binding.status === "disabled" || (reason && SUPPORT_REASONS.has(reason))) {
    return {
      ...base,
      label: "Needs support",
      message: "Custom domains need a fix on Ravi's side before this can continue. Contact support and mention this hostname.",
      state: "needs_support",
      tone: "err",
    };
  }
  if (reason && PROVIDER_RETRY_REASONS.has(reason)) {
    return {
      ...base,
      label: "Waiting for the certificate",
      message: "Ravi couldn't reach the certificate provider just now. Check again in a few minutes.",
      state: "waiting_certificate",
      tone: "warn",
    };
  }
  const hostnameStatus = text(edge.hostnameStatus);
  const sslStatus = text(edge.sslStatus);
  if (hostnameStatus === "active" && sslStatus && CERTIFICATE_WAIT_STATES.has(sslStatus)) {
    return {
      ...base,
      label: "Waiting for the certificate",
      message: "The DNS record is in place. The security certificate usually arrives within a few minutes; check again then.",
      state: "waiting_certificate",
      tone: "warn",
    };
  }
  return {
    ...base,
    label: "DNS record missing",
    message: "Add these records at your DNS provider, then check again. DNS changes can take up to an hour to show up.",
    records: bindingDnsRecords(binding),
    state: "dns_missing",
    tone: "warn",
  };
}

/** Hostnames bound to one host, newest first. */
export function bindingsForSite(bindings: DomainBindingSummary[], siteId: string) {
  return bindings
    .filter((binding) => binding.product === "pages" && binding.status !== "deleted" && bindingSiteId(binding) === siteId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Accepts what people paste ("https://www.example.com/") and returns the hostname. */
export function normalizeHostnameInput(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

export function looksLikeHostname(hostname: string) {
  return /^(\*\.)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$/.test(hostname);
}

export function claimIsVerified(claim: DomainClaimSummary) {
  return claim.status === "active" && claim.verificationStatus === "verified";
}

function hostnameIsWithinClaim(hostname: string, domain: string) {
  const comparable = hostname.startsWith("*.") ? hostname.slice(2) : hostname;
  return comparable === domain || comparable.endsWith(`.${domain}`);
}

/** Same choice as the server: a proven domain first, then the most specific one. */
export function findClaimForHostname(claims: DomainClaimSummary[], hostname: string) {
  return (
    claims
      .filter((claim) => (claim.status === "active" || claim.status === "pending") && hostnameIsWithinClaim(hostname, claim.domain))
      .sort((left, right) => {
        const verified = Number(claimIsVerified(right)) - Number(claimIsVerified(left));
        if (verified) return verified;
        return right.domain.split(".").length - left.domain.split(".").length || right.domain.length - left.domain.length;
      })[0] ?? null
  );
}

export function ownershipRecord(claim: DomainClaimSummary): DnsRecord | null {
  const expected = claim.verification.expected;
  if (!expected?.name || !expected.value) return null;
  return { name: expected.name, type: (expected.type ?? "TXT").toUpperCase(), value: expected.value };
}

/** Plain words for the domain endpoints' error codes. */
export function domainErrorMessage(code: string | undefined) {
  switch (code) {
    case "domain_unavailable":
      return "This domain can't be used here. Check the spelling; it may also belong to another organization or to Ravi.";
    case "domain_claim_not_verified":
      return "Prove you own the domain first, then try again.";
    case "domain_binding_conflict":
      return "This hostname isn't part of the domain you proved.";
    case "domain_binding_unavailable":
      return "This hostname is already used by another organization.";
    case "domain_verification_unavailable":
      return "This domain has no ownership record to check. Contact support.";
    default:
      return null;
  }
}
