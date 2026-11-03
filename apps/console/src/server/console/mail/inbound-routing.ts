import { ConsoleApiError } from "@/server/console/api-error";

import {
  createCloudflareEmailRoutingProvider,
  getCloudflareEmailRoutingConfig,
} from "./providers/cloudflare-email-routing";
import type { MailInboundRoutingProvider } from "./service";

/**
 * Build the shared inbound MX routing provider for Ravi Mail. The provider is
 * passed into `createMailConsoleMailService` so both the Console UI and the
 * CLI write paths keep Cloudflare Email Routing in sync as mailboxes are
 * created. Returns `undefined` when the provider is not configured, so the
 * service falls back to DB-only behaviour during local development.
 */
export function buildMailInboundRoutingProvider(): MailInboundRoutingProvider | undefined {
  const config = getCloudflareEmailRoutingConfig();
  if (!config) return undefined;
  const provider = createCloudflareEmailRoutingProvider(config);
  const zoneCache = new Map<string, string>();

  async function resolveZoneId(domain: string): Promise<string> {
    const normalizedDomain = domain.trim().toLowerCase();
    const cached = zoneCache.get(normalizedDomain);
    const zoneId =
      cached ?? readZoneIdFromEnv(normalizedDomain) ?? (await provider.lookupZoneIdByName(normalizedDomain));
    if (!zoneId) {
      throw new ConsoleApiError(502, { error: "mail_inbound_provider_failed" });
    }
    if (!cached) zoneCache.set(normalizedDomain, zoneId);
    return zoneId;
  }

  return {
    async deleteMailboxRule({ address, domain, mailboxId: _mailboxId }) {
      const zoneId = await resolveZoneId(domain);
      await provider.deleteAddressRulesByAddress({ zoneId, address });
    },
    async ensureMailboxRule({ address, domain, mailboxId: _mailboxId }) {
      const zoneId = await resolveZoneId(domain);
      await provider.createAddressRule({ zoneId, address });
    },
  };
}

/**
 * Resolve the Cloudflare zone id for a domain from a `CLOUDFLARE_ZONE_ID_*`
 * env var, falling back to a generic `CLOUDFLARE_ZONE_ID` when only one zone
 * is managed. The naming follows the domain's hostname uppercased with dots
 * and hyphens replaced by underscores (e.g. `ravi.so` -> `CLOUDFLARE_ZONE_ID_RAVI_SO`).
 */
function readZoneIdFromEnv(domain: string): string | null {
  const slug = domain.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const specific = process.env[`CLOUDFLARE_ZONE_ID_${slug}`]?.trim();
  if (specific) return specific;
  const fallback = process.env.CLOUDFLARE_ZONE_ID?.trim();
  return fallback ? fallback : null;
}
