import { ConsoleApiError } from "@/server/console/api-error";

export const MANAGED_MAIL_PROVIDER_ADAPTER = "cloudflare_email";

const DEFAULT_MANAGED_MAIL_DOMAINS = ["ravi.bot"] as const;

export function resolveManagedMailDomain(domain: string, env: Pick<NodeJS.ProcessEnv, string> = process.env) {
  const normalized = normalizeMailDomain(domain);
  const allowed = getManagedMailDomains(env);
  if (!allowed.has(normalized)) {
    throw new ConsoleApiError(400, { error: "mail_resource_unavailable" });
  }
  return normalized;
}

export function getManagedMailDomains(env: Pick<NodeJS.ProcessEnv, string> = process.env) {
  const configured = env.RAVI_MAIL_MANAGED_DOMAINS;
  const domains = configured
    ? configured
        .split(",")
        .map((domain) => normalizeMailDomain(domain))
        .filter(Boolean)
    : [...DEFAULT_MANAGED_MAIL_DOMAINS];

  return new Set(domains);
}

function normalizeMailDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}
