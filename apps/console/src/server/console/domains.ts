import { randomBytes } from "node:crypto";
import { resolveCname, resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import * as Sentry from "@sentry/nextjs";
import { and, eq, ne } from "drizzle-orm";
import { getDomain } from "tldts";
import { z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import { db, schema } from "@/server/db";
import type { PageCustomDomainSummary } from "@/features/console/types";
import type { JsonRecord } from "@/server/db/schema";
import { parseConsoleRole, type ConsoleWorkspace } from "@/server/console/workspace";
import {
  CloudflareCustomHostnameError,
  createCloudflareCustomHostnameProvider,
  getCloudflareCustomHostnameConfig,
  isCloudflareCustomHostnameReady,
  type CloudflareCustomHostname,
} from "./pages/cloudflare-custom-hostnames";

type DomainClaim = typeof schema.domainClaims.$inferSelect;
type DomainBinding = typeof schema.domainBindings.$inferSelect;
type PageSite = typeof schema.pageSites.$inferSelect;
type DomainWorkspace = {
  mode: ConsoleWorkspace["mode"];
  user: Pick<ConsoleWorkspace["user"], "id">;
  organization: Pick<ConsoleWorkspace["organization"], "id">;
  membership: Pick<ConsoleWorkspace["membership"], "role">;
};

type DnsResolver = {
  resolveCname?(hostname: string): Promise<string[]>;
  resolveTxt(domain: string): Promise<string[][]>;
};

type DomainDnsRecord = {
  name: string;
  type: string;
  value: string;
};

export type ConsolePageDomainSetupStepId = "ownership" | "dns" | "certificate";

/**
 * One of the three things a Pages hostname waits on, in order. `blocked` means
 * Ravi has to act (provider configuration), not the customer.
 */
export type ConsolePageDomainSetupStep = {
  dnsRecords: DomainDnsRecord[];
  id: ConsolePageDomainSetupStepId;
  status: "done" | "pending" | "blocked";
};

export type ConsolePageDomainSetupSummary = {
  /** The hostname is the claim's root domain, which needs CNAME flattening or ALIAS at the DNS provider. */
  apex?: boolean;
  /**
   * Wildcard DNS that points every subdomain of the domain at Ravi Pages, so
   * later hostnames under it skip the DNS step. Absent for apex and wildcard hostnames.
   */
  globalHost?: {
    active: boolean;
    dnsRecord: DomainDnsRecord;
  };
  hostname: string;
  nextAction: {
    code: string;
    dnsRecords: DomainDnsRecord[];
    message: string;
  } | null;
  state: "ownership_pending" | "pages_pending" | "ready";
  steps?: ConsolePageDomainSetupStep[];
};

const PLATFORM_RESERVED_SUFFIXES = ["ravi.bot", "ravi.page", "ravi.so"] as const;
const DEFAULT_PAGES_CUSTOM_HOSTNAME_CNAME_TARGET = "cname.ravi.page";
export const PAGES_APEX_DNS_HINT =
  "A root domain needs CNAME flattening (Cloudflare) or an ALIAS/ANAME record at the DNS provider; plain A records are not supported.";

const createClaimSchema = z.object({
  domain: z.string().min(1),
  ownershipMode: z.enum(["customer_managed", "ravi_managed"]).default("customer_managed"),
});

const createBindingSchema = z.object({
  hostname: z.string().min(1).optional(),
  product: z.enum(["mail", "pages"]),
  target: z
    .object({
      siteId: z.string().uuid().optional(),
    })
    .optional(),
});

const defaultDnsResolver: DnsResolver = {
  resolveCname,
  resolveTxt,
};

const SETUP_STEP_ORDER: ConsolePageDomainSetupStepId[] = ["ownership", "dns", "certificate"];
const SETUP_STEP_LABELS: Record<ConsolePageDomainSetupStepId, string> = {
  certificate: "Certificate",
  dns: "DNS",
  ownership: "Ownership",
};

export function normalizeConsoleDomain(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed || trimmed.length > 253 || isIP(trimmed)) {
    throw domainUnavailable();
  }

  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.includes("..")) {
    throw domainUnavailable();
  }

  const labels = ascii.split(".");
  if (labels.length < 2) throw domainUnavailable();

  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw domainUnavailable();
    }
  }

  return ascii;
}

export function hostnameIsWithinClaim(hostname: string, claimDomain: string) {
  const comparableHostname = hostname.startsWith("*.") ? hostname.slice(2) : hostname;
  return comparableHostname === claimDomain || comparableHostname.endsWith(`.${claimDomain}`);
}

export function hostnameMatchesClaimApex(hostname: string, claimDomain: string) {
  return hostname === claimDomain;
}

export function isPlatformReservedDomain(domain: string) {
  return PLATFORM_RESERVED_SUFFIXES.some(
    (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
  );
}

export function normalizeConsoleDomainBindingHostname(input: string): string {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed.startsWith("*.")) {
    const wildcardBase = normalizeConsoleDomain(trimmed.slice(2));
    return `*.${wildcardBase}`;
  }
  return normalizeConsoleDomain(trimmed);
}

export function registrableConsoleDomainForHostname(input: string): string {
  const hostname = normalizeConsoleDomainBindingHostname(input).replace(/^\*\./, "");
  const domain = getDomain(hostname, { allowPrivateDomains: true });
  if (!domain) throw domainUnavailable();
  return normalizeConsoleDomain(domain);
}

export async function listConsoleDomainClaims({ workspace }: { workspace: DomainWorkspace }) {
  assertDomainManageOrReadRole(workspace);
  const claims = await db
    .select()
    .from(schema.domainClaims)
    .where(
      and(
        eq(schema.domainClaims.organizationId, workspace.organization.id),
        ne(schema.domainClaims.status, "deleted"),
      ),
    )
    .orderBy(schema.domainClaims.normalizedDomain);

  const bindings =
    claims.length === 0
      ? []
      : await db
          .select()
          .from(schema.domainBindings)
          .where(
            and(
              eq(schema.domainBindings.organizationId, workspace.organization.id),
              ne(schema.domainBindings.status, "deleted"),
            ),
          )
          .orderBy(schema.domainBindings.hostname);

  return {
    claims: claims.map(serializeClaim),
    bindings: bindings.map(serializeBinding),
  };
}

export async function createConsoleDomainClaim({
  body,
  requestId,
  workspace,
}: {
  body: unknown;
  requestId: string;
  workspace: DomainWorkspace;
}) {
  assertDomainManageRole(workspace);
  const input = createClaimSchema.parse(body);
  const normalizedDomain = normalizeConsoleDomain(input.domain);

  if (input.ownershipMode === "customer_managed" && isPlatformReservedDomain(normalizedDomain)) {
    throw domainUnavailable();
  }

  const existing = await findActiveClaimByDomain(normalizedDomain);
  if (existing) {
    if (existing.organizationId !== workspace.organization.id) throw domainUnavailable();
    return { claim: serializeClaim(existing) };
  }

  const token = randomDnsToken();
  const verification = verificationJsonForDomain(normalizedDomain, token);
  const [claim] = await db
    .insert(schema.domainClaims)
    .values({
      organizationId: workspace.organization.id,
      normalizedDomain,
      displayDomain: normalizedDomain,
      ownershipMode: input.ownershipMode,
      status: "pending",
      verificationStatus: "pending",
      verificationMethod: "dns_txt",
      verificationJson: verification,
      createdByActorType: "user",
      createdByActorId: workspace.user.id,
    })
    .returning();

  if (!claim) throw new Error("Failed to create domain claim.");
  await auditDomainMutation({
    action: "domain_claim.created",
    requestId,
    targetId: claim.id,
    targetType: "domain_claim",
    workspace,
    metadataJson: {
      domain: claim.normalizedDomain,
      ownershipMode: claim.ownershipMode,
    },
  });

  return { claim: serializeClaim(claim) };
}

export async function verifyConsoleDomainClaim({
  claimId,
  requestId,
  resolver = defaultDnsResolver,
  workspace,
}: {
  claimId: string;
  requestId: string;
  resolver?: DnsResolver;
  workspace: DomainWorkspace;
}) {
  assertDomainManageRole(workspace);
  const claim = await requireClaim(workspace, claimId);
  const verification = record(claim.verificationJson);
  const expected = record(verification.expected);
  const txtName = textValue(expected.name);
  const txtValue = textValue(expected.value);

  if (!txtName || !txtValue) throw new ConsoleApiError(409, { error: "domain_verification_unavailable" });

  let matched = false;
  let lookupError: string | null = null;
  try {
    const rows = await resolver.resolveTxt(txtName);
    matched = rows.some((row) => row.join("").trim() === txtValue);
  } catch (error) {
    lookupError = error instanceof Error ? error.name : "dns_lookup_failed";
  }

  const now = new Date();
  const updatedVerification = {
    ...verification,
    lastCheckedAt: now.toISOString(),
    lastCheck: {
      matched,
      lookupError,
      type: "TXT",
    },
  };
  const [updated] = await db
    .update(schema.domainClaims)
    .set({
      status: matched ? "active" : "pending",
      verificationStatus: matched ? "verified" : "failed",
      verifiedAt: matched ? now : claim.verifiedAt,
      verificationJson: updatedVerification,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.domainClaims.id, claim.id),
        eq(schema.domainClaims.organizationId, workspace.organization.id),
      ),
    )
    .returning();

  if (!updated) throw new Error("Failed to update domain claim verification.");
  await auditDomainMutation({
    action: matched ? "domain_claim.verified" : "domain_claim.verification_failed",
    requestId,
    targetId: updated.id,
    targetType: "domain_claim",
    workspace,
    metadataJson: {
      domain: updated.normalizedDomain,
      matched,
    },
  });

  return { claim: serializeClaim(updated) };
}

export async function createConsoleDomainBinding({
  body,
  claimId,
  requestId,
  workspace,
}: {
  body: unknown;
  claimId: string;
  requestId: string;
  workspace: DomainWorkspace;
}) {
  assertDomainManageRole(workspace);
  const input = createBindingSchema.parse(body);
  if (input.product !== "pages") {
    throw new ConsoleApiError(400, { error: "domain_binding_product_unavailable" });
  }

  const claim = await requireVerifiedClaim(workspace, claimId);
  const hostname = normalizeConsoleDomainBindingHostname(input.hostname ?? defaultPagesHostnameForClaim(claim.normalizedDomain));

  if (!hostnameIsWithinClaim(hostname, claim.normalizedDomain)) {
    throw new ConsoleApiError(409, { error: "domain_binding_conflict" });
  }

  const existingBinding = await findActiveBinding(input.product, hostname);
  if (existingBinding) {
    if (existingBinding.organizationId !== workspace.organization.id) {
      throw new ConsoleApiError(409, { error: "domain_binding_unavailable" });
    }
    if (input.target?.siteId) {
      return rebindPageDomainBinding({
        binding: existingBinding,
        claim,
        requestId,
        siteId: input.target.siteId,
        workspace,
      });
    }
    return { binding: serializeBinding(existingBinding) };
  }

  if (!input.target?.siteId) {
    throw new ConsoleApiError(400, { error: "domain_binding_target_required" });
  }
  return createPageDomainBinding({
    claim,
    hostname,
    requestId,
    siteId: input.target.siteId,
    workspace,
  });
}

export async function createConsolePageDomainBindingForSite({
  hostname,
  requestId,
  siteId,
  workspace,
}: {
  hostname: string;
  requestId: string;
  siteId: string;
  workspace: DomainWorkspace;
}) {
  assertDomainManageRole(workspace);
  const normalizedHostname = normalizeConsoleDomainBindingHostname(hostname);
  const claim = await findVerifiedClaimForHostname(workspace, normalizedHostname);
  if (!claim) {
    throw new ConsoleApiError(409, { error: "domain_claim_not_verified" });
  }

  return createConsoleDomainBinding({
    body: {
      hostname: normalizedHostname,
      product: "pages",
      target: { siteId },
    },
    claimId: claim.id,
    requestId,
    workspace,
  });
}

export async function setupConsolePageDomainForSite({
  hostname,
  requestId,
  resolver = defaultDnsResolver,
  siteId,
  workspace,
}: {
  hostname: string;
  requestId: string;
  resolver?: DnsResolver;
  siteId: string;
  workspace: DomainWorkspace;
}) {
  assertDomainManageRole(workspace);
  const normalizedHostname = normalizeConsoleDomainBindingHostname(hostname);
  let claim = await findBestOwnedClaimForHostname(workspace, normalizedHostname);

  if (!claim) {
    const created = await createConsoleDomainClaim({
      body: {
        domain: registrableConsoleDomainForHostname(normalizedHostname),
        ownershipMode: "customer_managed",
      },
      requestId,
      workspace,
    });
    claim = await requireClaim(workspace, created.claim.id);
  }

  if (claim.status === "disabled") {
    throw domainUnavailable();
  }

  if (claim.status !== "active" || claim.verificationStatus !== "verified") {
    await verifyConsoleDomainClaim({ claimId: claim.id, requestId, resolver, workspace });
    claim = await requireClaim(workspace, claim.id);
  }

  const serializedClaim = serializeClaim(claim);
  const apex = hostnameMatchesClaimApex(normalizedHostname, claim.normalizedDomain);
  const globalHost = await globalHostForHostname({ claimDomain: claim.normalizedDomain, hostname: normalizedHostname, resolver });
  const hostRecord = pagesHostnameDnsRecord(normalizedHostname);
  if (claim.status !== "active" || claim.verificationStatus !== "verified") {
    const ownership = ownershipVerificationNextAction(claim);
    // Hand out the host's CNAME with the TXT, so one DNS visit covers both steps.
    const pointed = globalHost?.active || (await hostnamePointsToPages(normalizedHostname, resolver));
    return {
      apex,
      binding: null,
      claim: serializedClaim,
      ...(globalHost ? { globalHost } : {}),
      hostname: normalizedHostname,
      nextAction: {
        ...ownership,
        dnsRecords: pointed ? ownership.dnsRecords : [...ownership.dnsRecords, hostRecord],
        message: pointed
          ? ownership.message
          : "Add these records to the domain's authoritative DNS: the TXT proves the organization owns the domain, the CNAME points the hostname to Ravi Pages.",
      },
      state: "ownership_pending" as const,
      steps: [
        { dnsRecords: ownership.dnsRecords, id: "ownership", status: "pending" },
        { dnsRecords: pointed ? [] : [hostRecord], id: "dns", status: pointed ? "done" : "pending" },
        { dnsRecords: [], id: "certificate", status: "pending" },
      ] satisfies ConsolePageDomainSetupStep[],
    };
  }

  const created = await createConsoleDomainBinding({
    body: {
      hostname: normalizedHostname,
      product: "pages",
      target: { siteId },
    },
    claimId: claim.id,
    requestId,
    workspace,
  });
  const checked = await checkConsoleDomainBinding({
    bindingId: created.binding.id,
    requestId,
    workspace,
  });

  if (checked.binding.status === "active") {
    return {
      apex,
      binding: checked.binding,
      claim: serializedClaim,
      ...(globalHost ? { globalHost } : {}),
      hostname: normalizedHostname,
      nextAction: null,
      state: "ready" as const,
      steps: SETUP_STEP_ORDER.map((id) => ({ dnsRecords: [], id, status: "done" as const })),
    };
  }

  const nextAction = pagesReadinessNextAction(checked.binding);
  const pointed =
    pagesBindingHostnameActive(checked.binding) ||
    globalHost?.active === true ||
    (await hostnamePointsToPages(normalizedHostname, resolver));
  return {
    apex,
    binding: checked.binding,
    claim: serializedClaim,
    ...(globalHost ? { globalHost } : {}),
    hostname: normalizedHostname,
    nextAction,
    state: "pages_pending" as const,
    steps: pagesPendingSteps({ hostRecord, nextAction, pointed }),
  };
}

function pagesPendingSteps({
  hostRecord,
  nextAction,
  pointed,
}: {
  hostRecord: DomainDnsRecord;
  nextAction: ReturnType<typeof pagesReadinessNextAction>;
  pointed: boolean;
}): ConsolePageDomainSetupStep[] {
  const ownership: ConsolePageDomainSetupStep = { dnsRecords: [], id: "ownership", status: "done" };
  if (nextAction.code === "contact_operator") {
    return [
      ownership,
      { dnsRecords: pointed ? [] : [hostRecord], id: "dns", status: pointed ? "done" : "pending" },
      { dnsRecords: [], id: "certificate", status: "blocked" },
    ];
  }
  const validationRecords = nextAction.dnsRecords.filter((record) => !sameDnsRecord(record, hostRecord));
  return [
    ownership,
    { dnsRecords: pointed ? [] : [hostRecord], id: "dns", status: pointed ? "done" : "pending" },
    { dnsRecords: validationRecords, id: "certificate", status: "pending" },
  ];
}

/** Structured setup state for CLI clients; carries only Ravi-owned, safe DNS instructions. */
export function consolePageDomainSetupDetails(setups: ConsolePageDomainSetupSummary[]) {
  return {
    setups: setups.map((setup) => ({
      ...(setup.apex ? { apex: true } : {}),
      ...(setup.globalHost ? { globalHost: setup.globalHost } : {}),
      hostname: setup.hostname,
      nextAction: setup.nextAction,
      state: setup.state,
      ...(setup.steps ? { currentStep: currentSetupStep(setup.steps), steps: setup.steps } : {}),
    })),
  };
}

function currentSetupStep(steps: ConsolePageDomainSetupStep[]) {
  const index = steps.findIndex((step) => step.status !== "done");
  return index === -1 ? null : { id: steps[index]!.id, number: index + 1, total: steps.length };
}

function sameDnsRecord(left: DomainDnsRecord, right: DomainDnsRecord) {
  return (
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.type.toUpperCase() === right.type.toUpperCase() &&
    left.value.toLowerCase() === right.value.toLowerCase()
  );
}

function pagesHostnameDnsRecord(hostname: string): DomainDnsRecord {
  return { name: hostname, type: "CNAME", value: pagesCustomHostnameCnameTarget() };
}

function pagesBindingHostnameActive(binding: { readiness: unknown }) {
  return textValue(record(record(binding.readiness).edge).hostnameStatus) === "active";
}

function normalizeDnsName(value: string) {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * True when the hostname's CNAME already names the Pages target. A proxied or
 * flattened record answers with addresses instead; that case stays false here
 * and the provider's hostname status decides.
 */
export async function hostnamePointsToPages(hostname: string, resolver: DnsResolver = defaultDnsResolver) {
  if (!resolver.resolveCname || hostname.startsWith("*.")) return false;
  const target = normalizeDnsName(pagesCustomHostnameCnameTarget());
  try {
    const targets = await resolver.resolveCname(hostname);
    return targets.some((value) => normalizeDnsName(value) === target);
  } catch {
    return false;
  }
}

/**
 * The org-wide host for a subdomain: `*.<parent>` pointed at Ravi Pages once,
 * so every later hostname under that parent needs no DNS change. Probed with a
 * random label, which only a wildcard record can answer.
 */
async function globalHostForHostname({
  claimDomain,
  hostname,
  resolver,
}: {
  claimDomain: string;
  hostname: string;
  resolver: DnsResolver;
}): Promise<ConsolePageDomainSetupSummary["globalHost"]> {
  const parent = globalHostParent(hostname, claimDomain);
  if (!parent) return undefined;
  const probe = `ravi-probe-${randomBytes(6).toString("hex")}.${parent}`;
  return {
    active: await hostnamePointsToPages(probe, resolver),
    dnsRecord: { name: `*.${parent}`, type: "CNAME", value: pagesCustomHostnameCnameTarget() },
  };
}

export function globalHostParent(hostname: string, claimDomain: string) {
  if (hostname.startsWith("*.") || hostnameMatchesClaimApex(hostname, claimDomain)) return null;
  const parent = hostname.slice(hostname.indexOf(".") + 1);
  return hostnameIsWithinClaim(parent, claimDomain) ? parent : null;
}

export function formatConsolePageDomainSetupRequired(setups: ConsolePageDomainSetupSummary[]) {
  const pending = setups.filter(
    (setup): setup is ConsolePageDomainSetupSummary & { nextAction: NonNullable<ConsolePageDomainSetupSummary["nextAction"]> } =>
      setup.state !== "ready" && Boolean(setup.nextAction),
  );
  const lines = ["Pages domain setup was saved but is not ready yet."];

  for (const setup of pending) {
    const current = setup.steps ? currentSetupStep(setup.steps) : null;
    const position = current ? ` (step ${current.number} of ${current.total}: ${SETUP_STEP_LABELS[current.id]})` : "";
    lines.push("", `${setup.hostname}${position}: ${setup.nextAction.message}`);
    for (const dnsRecord of setup.nextAction.dnsRecords) {
      lines.push(formatDnsRecordLine(dnsRecord));
    }
    if (setup.steps) {
      lines.push(...setup.steps.map((step, index) => `  ${setupStepMark(step)} ${index + 1}. ${setupStepLine(step, setup)}`));
    }
    if (setup.apex && setup.steps?.some((step) => step.id === "dns" && step.status !== "done")) {
      lines.push(`  ${PAGES_APEX_DNS_HINT}`);
    }
    if (setup.globalHost && !setup.globalHost.active) {
      lines.push(
        `  Global host: add ${formatDnsRecordLine(setup.globalHost.dnsRecord)} once and every other subdomain of ${setup.globalHost.dnsRecord.name.slice(2)} skips the DNS step.`,
      );
    }
  }

  lines.push("", "After completing the action and allowing for propagation, rerun the same ravi pages domains command.");
  return lines.join("\n");
}

function formatDnsRecordLine(dnsRecord: DomainDnsRecord) {
  return `${dnsRecord.type.toUpperCase()} ${dnsRecord.name} = ${dnsRecord.value}`;
}

function setupStepMark(step: ConsolePageDomainSetupStep) {
  if (step.status === "done") return "[x]";
  if (step.status === "blocked") return "[!]";
  return "[ ]";
}

function setupStepLine(step: ConsolePageDomainSetupStep, setup: ConsolePageDomainSetupSummary) {
  switch (step.id) {
    case "ownership":
      return step.status === "done" ? "Ownership: verified" : "Ownership: waiting for the TXT record";
    case "dns":
      if (step.status === "done") return `DNS: ${setup.hostname} points to Ravi Pages`;
      return `DNS: waiting for ${setup.hostname} to point to ${pagesCustomHostnameCnameTarget()}`;
    case "certificate":
      if (step.status === "done") return "Certificate: active";
      if (step.status === "blocked") return "Certificate: waiting on Ravi (provider configuration)";
      return "Certificate: issued automatically once DNS resolves";
  }
}

export async function checkConsoleDomainBinding({
  bindingId,
  requestId,
  workspace,
}: {
  bindingId: string;
  requestId: string;
  workspace: DomainWorkspace;
}) {
  assertDomainManageRole(workspace);
  const binding = await requireBinding(workspace, bindingId);
  if (binding.product !== "pages") {
    throw new ConsoleApiError(400, { error: "domain_binding_product_unavailable" });
  }

  const readiness = await checkPageBinding({ binding });

  const status = readiness.status === "ready" ? "active" : readiness.status === "failed" ? "failed" : "pending";
  const [updated] = await db
    .update(schema.domainBindings)
    .set({
      status,
      readinessJson: readiness,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.domainBindings.id, binding.id),
        eq(schema.domainBindings.organizationId, workspace.organization.id),
      ),
    )
    .returning();

  if (!updated) throw new Error("Failed to update domain binding readiness.");

  await db
    .update(schema.pageDomainBindings)
    .set({
      edgeReadinessJson: record(readiness.edge),
      updatedAt: new Date(),
    })
    .where(eq(schema.pageDomainBindings.domainBindingId, updated.id));

  await auditDomainMutation({
    action: status === "active" ? "domain_binding.ready" : "domain_binding.check_pending",
    requestId,
    targetId: updated.id,
    targetType: "domain_binding",
    workspace,
    metadataJson: {
      hostname: updated.hostname,
      product: updated.product,
      status: readiness.status,
    },
  });

  return { binding: serializeBinding(updated) };
}

export function selectBestVerifiedDomainClaimForHostname(
  hostname: string,
  claims: Array<Pick<DomainClaim, "id" | "normalizedDomain" | "status" | "verificationStatus">>,
) {
  const normalizedHostname = normalizeConsoleDomainBindingHostname(hostname);
  return (
    claims
      .filter(
        (claim) =>
          claim.status === "active" &&
          claim.verificationStatus === "verified" &&
          hostnameIsWithinClaim(normalizedHostname, claim.normalizedDomain),
      )
      .sort((left, right) => {
        const rightLabels = right.normalizedDomain.split(".").length;
        const leftLabels = left.normalizedDomain.split(".").length;
        return rightLabels - leftLabels || right.normalizedDomain.length - left.normalizedDomain.length;
      })[0] ?? null
  );
}

export function selectBestOwnedDomainClaimForHostname<
  T extends Pick<DomainClaim, "normalizedDomain" | "status" | "verificationStatus">,
>(hostname: string, claims: T[]): T | null {
  const normalizedHostname = normalizeConsoleDomainBindingHostname(hostname);
  return (
    claims
      .filter(
        (claim) =>
          (claim.status === "active" || claim.status === "pending") &&
          hostnameIsWithinClaim(normalizedHostname, claim.normalizedDomain),
      )
      .sort((left, right) => {
        const rightVerified = right.status === "active" && right.verificationStatus === "verified" ? 1 : 0;
        const leftVerified = left.status === "active" && left.verificationStatus === "verified" ? 1 : 0;
        if (rightVerified !== leftVerified) return rightVerified - leftVerified;
        const rightLabels = right.normalizedDomain.split(".").length;
        const leftLabels = left.normalizedDomain.split(".").length;
        return rightLabels - leftLabels || right.normalizedDomain.length - left.normalizedDomain.length;
      })[0] ?? null
  );
}

async function createPageDomainBinding({
  claim,
  hostname,
  requestId,
  siteId,
  workspace,
}: {
  claim: DomainClaim;
  hostname: string;
  requestId: string;
  siteId: string;
  workspace: DomainWorkspace;
}) {
  const site = await requirePageSite(workspace, siteId);

  const readiness = initialPageReadiness(hostname, claim, site);
  const policyJson = pageBindingPolicyJson(hostname, claim, site);
  const result = await db.transaction(async (tx) => {
    const binding = await tx
      .insert(schema.domainBindings)
      .values({
        organizationId: workspace.organization.id,
        domainClaimId: claim.id,
        product: "pages",
        hostname,
        status: "pending",
        readinessJson: readiness,
        policyJson,
      })
      .returning()
      .then((rows) => rows[0]);

    if (!binding) throw new Error("Failed to create Pages domain binding.");
    await tx.insert(schema.pageDomainBindings).values({
      domainBindingId: binding.id,
      pageSiteId: site.id,
      hostname,
      edgeReadinessJson: readiness.edge,
    });
    return binding;
  });

  await auditDomainMutation({
    action: "domain_binding.pages.created",
    requestId,
    targetId: result.id,
    targetType: "domain_binding",
    workspace,
    metadataJson: { hostname, siteId: site.id },
  });

  return { binding: serializeBinding(result) };
}

async function rebindPageDomainBinding({
  binding,
  claim,
  requestId,
  siteId,
  workspace,
}: {
  binding: DomainBinding;
  claim: DomainClaim;
  requestId: string;
  siteId: string;
  workspace: DomainWorkspace;
}) {
  const site = await requirePageSite(workspace, siteId);
  const [currentPageBinding] = await db
    .select()
    .from(schema.pageDomainBindings)
    .where(eq(schema.pageDomainBindings.domainBindingId, binding.id))
    .limit(1);

  if (currentPageBinding?.pageSiteId === site.id) {
    return { binding: serializeBinding(binding) };
  }

  const now = new Date();
  const { readinessJson, policyJson } = retargetPageBindingJson({
    binding,
    claim,
    site,
  });

  const updated = await db.transaction(async (tx) => {
    const [updatedBinding] = await tx
      .update(schema.domainBindings)
      .set({
        policyJson,
        readinessJson,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.domainBindings.id, binding.id),
          eq(schema.domainBindings.organizationId, workspace.organization.id),
        ),
      )
      .returning();

    if (!updatedBinding) throw new Error("Failed to rebind Pages domain binding.");

    const pageBindingPatch = {
      edgeReadinessJson: record(record(readinessJson).edge),
      hostname: binding.hostname,
      pageSiteId: site.id,
      updatedAt: now,
    };

    const [updatedPageBinding] = await tx
      .update(schema.pageDomainBindings)
      .set(pageBindingPatch)
      .where(eq(schema.pageDomainBindings.domainBindingId, binding.id))
      .returning();

    if (!updatedPageBinding) {
      await tx.insert(schema.pageDomainBindings).values({
        domainBindingId: binding.id,
        ...pageBindingPatch,
      });
    }

    return updatedBinding;
  });

  await auditDomainMutation({
    action: "domain_binding.pages.rebound",
    requestId,
    targetId: updated.id,
    targetType: "domain_binding",
    workspace,
    metadataJson: {
      hostname: updated.hostname,
      previousSiteId: currentPageBinding?.pageSiteId ?? null,
      siteId: site.id,
    },
  });

  return { binding: serializeBinding(updated) };
}

async function requirePageSite(workspace: DomainWorkspace, siteId: string) {
  const [site] = await db
    .select()
    .from(schema.pageSites)
    .where(
      and(
        eq(schema.pageSites.id, siteId),
        eq(schema.pageSites.organizationId, workspace.organization.id),
        ne(schema.pageSites.status, "deleted"),
      ),
    )
    .limit(1);
  if (!site) throw new ConsoleApiError(404, { error: "domain_binding_target_unavailable" });
  return site;
}

async function checkPageBinding({ binding }: { binding: DomainBinding }): Promise<JsonRecord> {
  const now = new Date().toISOString();
  const config = getCloudflareCustomHostnameConfig();
  if (!config) {
    return pageReadinessWithEdge({
      binding,
      checkedAt: now,
      edge: {
        adapter: "cloudflare_for_saas",
        reason: "cloudflare_custom_hostname_adapter_unconfigured",
        status: "pending",
      },
      reason: "cloudflare_custom_hostname_adapter_unconfigured",
      status: "pending",
    });
  }

  try {
    const provider = createCloudflareCustomHostnameProvider(config);
    const hostname = await provider.ensureCustomHostname({ hostname: binding.hostname });
    const ready = isCloudflareCustomHostnameReady(hostname);

    return pageReadinessWithEdge({
      binding,
      checkedAt: now,
      dnsRecords: safeCloudflareCustomHostnameDnsRecords(hostname, {
        includeOwnershipVerification: shouldExposeCloudflareOwnershipVerificationRecord(hostname),
      }),
      edge: safeCloudflareCustomHostnameEdgeReadiness(hostname),
      reason: ready ? null : "cloudflare_custom_hostname_pending",
      status: ready ? "ready" : "pending",
    });
  } catch (error) {
    const reason = safeCloudflareCustomHostnameErrorReason(error);
    await capturePagesCustomHostnameCheckFailure({
      binding,
      config,
      error,
      reason,
    });
    return pageReadinessWithEdge({
      binding,
      checkedAt: now,
      edge: {
        adapter: "cloudflare_for_saas",
        reason,
        status: "pending",
      },
      reason,
      status: "pending",
    });
  }
}

function pageReadinessWithEdge({
  binding,
  checkedAt,
  edge,
  dnsRecords,
  reason,
  status,
}: {
  binding: DomainBinding;
  checkedAt: string;
  dnsRecords?: Array<{ name: string; type: string; value: string }>;
  edge: JsonRecord;
  reason: string | null;
  status: "failed" | "pending" | "ready";
}) {
  const current = record(binding.readinessJson);
  const policy = record(binding.policyJson);
  const currentDns = record(current.dns);
  const currentDnsRecords = Array.isArray(currentDns.records) ? currentDns.records : [];
  const nextDnsRecords = dnsRecords ? mergeDnsRecords(currentDnsRecords, dnsRecords) : currentDnsRecords;
  const mode = textValue(current.mode) ?? textValue(policy.mode);
  const redirectToHostname = textValue(current.redirectToHostname) ?? textValue(policy.redirectToHostname);
  const siteId = textValue(current.siteId) ?? textValue(policy.siteId);
  return {
    ...current,
    checkedAt,
    dns: {
      ...currentDns,
      records: nextDnsRecords,
      status: status === "ready" ? "ready" : "pending",
    },
    edge,
    ...(mode ? { mode } : {}),
    reason,
    ...(redirectToHostname ? { redirectToHostname } : {}),
    ...(siteId ? { siteId } : {}),
    status,
  } satisfies JsonRecord;
}

export function retargetPageBindingJsonForTests(input: {
  claimDomain: string;
  hostname: string;
  policyJson: unknown;
  readinessJson: unknown;
  siteId: string;
}) {
  return retargetPageBindingJson({
    binding: {
      hostname: input.hostname,
      policyJson: input.policyJson,
      readinessJson: input.readinessJson,
    } as Pick<DomainBinding, "hostname" | "policyJson" | "readinessJson">,
    claim: {
      normalizedDomain: input.claimDomain,
    } as Pick<DomainClaim, "normalizedDomain">,
    site: {
      id: input.siteId,
    } as Pick<PageSite, "id">,
  });
}

function retargetPageBindingJson({
  binding,
  claim,
  site,
}: {
  binding: Pick<DomainBinding, "hostname" | "policyJson" | "readinessJson">;
  claim: Pick<DomainClaim, "normalizedDomain">;
  site: Pick<PageSite, "id">;
}) {
  const bindingMode = pageBindingMode(binding.hostname, claim.normalizedDomain);
  // A rebound apex stops redirecting to www and serves its new site.
  const { redirectToHostname: _staleReadinessRedirect, ...readiness } = record(binding.readinessJson);
  const { redirectToHostname: _stalePolicyRedirect, ...policy } = record(binding.policyJson);
  return {
    policyJson: {
      ...policy,
      mode: bindingMode.mode,
      ...(bindingMode.redirectToHostname ? { redirectToHostname: bindingMode.redirectToHostname } : {}),
      siteId: site.id,
    } satisfies JsonRecord,
    readinessJson: {
      ...readiness,
      hostname: binding.hostname,
      mode: bindingMode.mode,
      ...(bindingMode.redirectToHostname ? { redirectToHostname: bindingMode.redirectToHostname } : {}),
      siteId: site.id,
    } satisfies JsonRecord,
  };
}

function safeCloudflareCustomHostnameEdgeReadiness(hostname: CloudflareCustomHostname) {
  const ready = isCloudflareCustomHostnameReady(hostname);
  return {
    adapter: "cloudflare_for_saas",
    hostnameStatus: hostname.status ?? "unknown",
    reason: ready ? null : "cloudflare_custom_hostname_pending",
    sslStatus: hostname.ssl?.status ?? "unknown",
    status: ready ? "ready" : "pending",
  } satisfies JsonRecord;
}

export function safeCloudflareCustomHostnameDnsRecords(
  hostname: CloudflareCustomHostname,
  options: { includeOwnershipVerification?: boolean } = {},
) {
  const records: Array<{ name: string; type: string; value: string }> = [];
  const ownership = hostname.ownership_verification;
  if (options.includeOwnershipVerification !== false && ownership?.name && ownership.type && ownership.value) {
    records.push({
      name: ownership.name,
      type: ownership.type.toUpperCase(),
      value: ownership.value,
    });
  }

  for (const record of [
    ...(hostname.ssl?.dcv_delegation_records ?? []),
    ...(hostname.ssl?.validation_records ?? []),
  ]) {
    if (record.txt_name && record.txt_value) {
      records.push({
        name: record.txt_name,
        type: "TXT",
        value: record.txt_value,
      });
    }
    if (record.cname && record.cname_target) {
      records.push({
        name: record.cname,
        type: "CNAME",
        value: record.cname_target,
      });
    }
  }

  return records;
}

export function shouldExposeCloudflareOwnershipVerificationRecord(hostname: CloudflareCustomHostname) {
  if (hostname.hostname.startsWith("*.")) return true;
  const sslMethod = hostname.ssl?.method?.toLowerCase();
  return sslMethod !== "http";
}

function mergeDnsRecords(current: unknown[], next: Array<{ name: string; type: string; value: string }>) {
  const records = current
    .map((record) => recordValue(record))
    .filter((record): record is { name: string; type: string; value: string } => Boolean(record))
    .filter((record) => !isCloudflarePagesValidationRecord(record));
  for (const record of next) {
    if (
      !records.some(
        (candidate) =>
          candidate.name === record.name &&
          candidate.type.toUpperCase() === record.type.toUpperCase() &&
          candidate.value === record.value,
      )
    ) {
      records.push(record);
    }
  }
  return records;
}

function isCloudflarePagesValidationRecord(record: { name: string; type: string; value: string }) {
  const name = record.name.toLowerCase();
  return name.startsWith("_cf-custom-hostname.") || name.startsWith("_acme-challenge.");
}

function recordValue(value: unknown) {
  const item = record(value);
  const name = textValue(item.name);
  const type = textValue(item.type);
  const recordValueText = textValue(item.value);
  return name && type && recordValueText ? { name, type, value: recordValueText } : null;
}

export function safeCloudflareCustomHostnameErrorReason(error: unknown) {
  if (error instanceof CloudflareCustomHostnameError) {
    if (
      error.code === "CF_UNAUTHORIZED" ||
      error.code === "CF_FORBIDDEN" ||
      error.code === "CF_10000" ||
      error.code === "CF_9109"
    ) {
      return "cloudflare_custom_hostname_provider_unauthorized";
    }
    if (error.code === "CF_ZONE_NOT_FOUND" || error.code === "CF_NOT_FOUND") {
      return "cloudflare_custom_hostname_zone_unavailable";
    }
    if (error.code === "CF_RATE_LIMITED") {
      return "cloudflare_custom_hostname_provider_rate_limited";
    }
    return "cloudflare_custom_hostname_provider_failed";
  }
  return "cloudflare_custom_hostname_provider_failed";
}

export function safeCloudflareCustomHostnameErrorDiagnostics(error: unknown) {
  if (error instanceof CloudflareCustomHostnameError) {
    return compact({
      code: error.code,
      message: safeDiagnosticMessage(error.message),
      name: error.name,
      status: error.status,
    });
  }
  if (error instanceof Error) {
    return compact({
      message: safeDiagnosticMessage(error.message),
      name: error.name,
    });
  }
  return compact({
    message: safeDiagnosticMessage(String(error)),
    name: "UnknownError",
  });
}

async function capturePagesCustomHostnameCheckFailure({
  binding,
  config,
  error,
  reason,
}: {
  binding: DomainBinding;
  config: NonNullable<ReturnType<typeof getCloudflareCustomHostnameConfig>>;
  error: unknown;
  reason: string;
}) {
  try {
    ensureSentryServerClient();
    const diagnostics = safeCloudflareCustomHostnameErrorDiagnostics(error);
    Sentry.captureMessage("Pages custom hostname check failed", {
      level: reason === "cloudflare_custom_hostname_provider_rate_limited" ? "warning" : "error",
      tags: {
        adapter: "cloudflare_for_saas",
        component: "console-domains",
        "cloudflare.code": diagnosticString(diagnostics.code) ?? "unknown",
        "cloudflare.status": diagnosticString(diagnostics.status) ?? "unknown",
        product: "pages",
        reason,
      },
      contexts: {
        cloudflare_custom_hostname: diagnostics,
        ravi_pages_domain_binding: compact({
          bindingId: binding.id,
          customOriginConfigured: Boolean(config.customOriginServer),
          hostname: binding.hostname,
          product: binding.product,
          status: binding.status,
          zoneConfigured: Boolean(config.zoneId),
          zoneName: config.zoneName,
        }),
      },
    });
    await Sentry.flush(2000);
  } catch {
    // Domain readiness checks must continue even if observability is unavailable.
  }
}

function ensureSentryServerClient() {
  if (Sentry.getClient()) return;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    enableLogs: true,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    tracesSampleRate: Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  });
}

function safeDiagnosticMessage(message: string) {
  const trimmed = message.trim().replace(/\s+/g, " ");
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

function diagnosticString(value: unknown) {
  if (value === undefined || value === null) return null;
  return String(value);
}

function compact<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

async function requireClaim(workspace: DomainWorkspace, claimId: string) {
  const [claim] = await db
    .select()
    .from(schema.domainClaims)
    .where(
      and(
        eq(schema.domainClaims.id, claimId),
        eq(schema.domainClaims.organizationId, workspace.organization.id),
        ne(schema.domainClaims.status, "deleted"),
      ),
    )
    .limit(1);
  if (!claim) throw new ConsoleApiError(404, { error: "domain_not_found" });
  return claim;
}

async function requireVerifiedClaim(workspace: DomainWorkspace, claimId: string) {
  const claim = await requireClaim(workspace, claimId);
  if (claim.status !== "active" || claim.verificationStatus !== "verified") {
    throw new ConsoleApiError(409, { error: "domain_claim_not_verified" });
  }
  return claim;
}

async function requireBinding(workspace: DomainWorkspace, bindingId: string) {
  const [binding] = await db
    .select()
    .from(schema.domainBindings)
    .where(
      and(
        eq(schema.domainBindings.id, bindingId),
        eq(schema.domainBindings.organizationId, workspace.organization.id),
        ne(schema.domainBindings.status, "deleted"),
      ),
    )
    .limit(1);
  if (!binding) throw new ConsoleApiError(404, { error: "domain_binding_not_found" });
  return binding;
}

async function findActiveClaimByDomain(normalizedDomain: string) {
  const [claim] = await db
    .select()
    .from(schema.domainClaims)
    .where(
      and(
        eq(schema.domainClaims.normalizedDomain, normalizedDomain),
        ne(schema.domainClaims.status, "deleted"),
      ),
    )
    .limit(1);
  return claim ?? null;
}

async function findActiveBinding(product: "pages", hostname: string) {
  const [binding] = await db
    .select()
    .from(schema.domainBindings)
    .where(
      and(
        eq(schema.domainBindings.product, product),
        eq(schema.domainBindings.hostname, hostname),
        ne(schema.domainBindings.status, "deleted"),
      ),
    )
    .limit(1);
  return binding ?? null;
}

async function findVerifiedClaimForHostname(workspace: DomainWorkspace, hostname: string) {
  const claims = await db
    .select({
      id: schema.domainClaims.id,
      normalizedDomain: schema.domainClaims.normalizedDomain,
      status: schema.domainClaims.status,
      verificationStatus: schema.domainClaims.verificationStatus,
    })
    .from(schema.domainClaims)
    .where(
      and(
        eq(schema.domainClaims.organizationId, workspace.organization.id),
        eq(schema.domainClaims.status, "active"),
        eq(schema.domainClaims.verificationStatus, "verified"),
      ),
    );

  const selected = selectBestVerifiedDomainClaimForHostname(hostname, claims);
  return selected ? requireVerifiedClaim(workspace, selected.id) : null;
}

async function findBestOwnedClaimForHostname(workspace: DomainWorkspace, hostname: string) {
  const claims = await db
    .select()
    .from(schema.domainClaims)
    .where(
      and(
        eq(schema.domainClaims.organizationId, workspace.organization.id),
        ne(schema.domainClaims.status, "deleted"),
      ),
    );

  return selectBestOwnedDomainClaimForHostname(hostname, claims);
}

function ownershipVerificationNextAction(claim: DomainClaim) {
  const expected = record(record(claim.verificationJson).expected);
  const dnsRecord = recordValue(expected);
  if (!dnsRecord) {
    throw new ConsoleApiError(409, { error: "domain_verification_unavailable" });
  }

  return {
    code: "add_ownership_txt" as const,
    dnsRecords: [{ ...dnsRecord, type: dnsRecord.type.toUpperCase() }],
    message: "Add this ownership record to the domain's authoritative DNS.",
  };
}

export function pagesReadinessNextAction(binding: { readiness: unknown }) {
  const readiness = record(binding.readiness);
  const edge = record(readiness.edge);
  const reason = textValue(readiness.reason) ?? textValue(edge.reason);
  const dns = record(readiness.dns);
  const dnsRecords = (Array.isArray(dns.records) ? dns.records : [])
    .map((value) => recordValue(value))
    .filter((value): value is DomainDnsRecord => Boolean(value));

  if (
    reason === "cloudflare_custom_hostname_adapter_unconfigured" ||
    reason === "cloudflare_custom_hostname_provider_unauthorized" ||
    reason === "cloudflare_custom_hostname_zone_unavailable"
  ) {
    return {
      code: "contact_operator" as const,
      dnsRecords: [],
      message: "Ravi Pages custom-domain provisioning needs operator attention before setup can continue.",
    };
  }

  if (
    reason === "cloudflare_custom_hostname_provider_failed" ||
    reason === "cloudflare_custom_hostname_provider_rate_limited"
  ) {
    return {
      code: "retry_provider_check" as const,
      dnsRecords: [],
      message: "The Ravi Pages domain provider is temporarily unavailable; retry this setup shortly.",
    };
  }

  if (dnsRecords.length === 0) {
    return {
      code: "wait_for_pages" as const,
      dnsRecords,
      message: "Ravi Pages is still provisioning this hostname.",
    };
  }

  return {
    code: "configure_pages_dns" as const,
    dnsRecords,
    message: "Add or keep these records in the hostname's authoritative DNS.",
  };
}

/** One Pages custom domain as host lists show it: ready, or pending with what still blocks it. */
export function pageCustomDomainSummary(
  hostname: string,
  bindingStatus: string,
  readinessJson: unknown,
): PageCustomDomainSummary {
  const apex = pageHostnameIsApex(hostname);
  if (pageDomainBindingIsReady(bindingStatus, readinessJson)) {
    return { hostname, status: "ready", ...(apex ? { apex: true as const } : {}) };
  }
  const nextAction = pagesReadinessNextAction({ readiness: readinessJson });
  return {
    hostname,
    status: "pending",
    ...(apex ? { apex: true as const } : {}),
    nextAction: {
      code: nextAction.code,
      dnsRecords: nextAction.dnsRecords,
      message: apex && nextAction.code === "configure_pages_dns" ? `${nextAction.message} ${PAGES_APEX_DNS_HINT}` : nextAction.message,
    },
  };
}

function pageHostnameIsApex(hostname: string) {
  try {
    return registrableConsoleDomainForHostname(hostname) === hostname;
  } catch {
    return false;
  }
}

function pageDomainBindingIsReady(bindingStatus: string, readinessJson: unknown) {
  const readiness = record(readinessJson);
  const readinessStatus = typeof readiness.status === "string" ? readiness.status : bindingStatus;
  return bindingStatus === "active" || readinessStatus === "ready";
}

function initialPageReadiness(hostname: string, claim: DomainClaim, site: PageSite) {
  const bindingMode = pageBindingMode(hostname, claim.normalizedDomain);
  return {
    schemaVersion: 1,
    dns: {
      records: [
        {
          name: hostname,
          type: "CNAME",
          value: pagesCustomHostnameCnameTarget(),
        },
      ],
      status: "pending",
    },
    edge: {
      adapter: "cloudflare_for_saas",
      reason: "cloudflare_custom_hostname_not_checked",
      status: "pending",
    },
    hostname,
    mode: bindingMode.mode,
    ...(bindingMode.redirectToHostname ? { redirectToHostname: bindingMode.redirectToHostname } : {}),
    siteId: site.id,
    status: "pending",
  } satisfies JsonRecord;
}

function pageBindingPolicyJson(hostname: string, claim: DomainClaim, site: PageSite) {
  const bindingMode = pageBindingMode(hostname, claim.normalizedDomain);
  return {
    mode: bindingMode.mode,
    ...(bindingMode.redirectToHostname ? { redirectToHostname: bindingMode.redirectToHostname } : {}),
    siteId: site.id,
  } satisfies JsonRecord;
}

/**
 * Every new binding serves its site, the root domain included. Bindings saved
 * before apex serving keep their stored `redirect` policy until rebound.
 */
function pageBindingMode(_hostname: string, _claimDomain: string): { mode: "serve"; redirectToHostname?: string } {
  return { mode: "serve" };
}

function defaultPagesHostnameForClaim(claimDomain: string) {
  return `www.${claimDomain}`;
}

function pagesCustomHostnameCnameTarget() {
  return process.env.RAVI_PAGES_CUSTOM_HOSTNAME_CNAME_TARGET?.trim() || DEFAULT_PAGES_CUSTOM_HOSTNAME_CNAME_TARGET;
}

function verificationJsonForDomain(normalizedDomain: string, token: string) {
  return {
    schemaVersion: 1,
    expected: {
      name: `_ravi-verify.${normalizedDomain}`,
      type: "TXT",
      value: `ravi-domain-verification=${token}`,
    },
    issuedAt: new Date().toISOString(),
  } satisfies JsonRecord;
}

function serializeClaim(claim: DomainClaim) {
  return {
    id: claim.id,
    domain: claim.normalizedDomain,
    displayDomain: claim.displayDomain,
    ownershipMode: claim.ownershipMode,
    status: claim.status,
    verificationStatus: claim.verificationStatus,
    verificationMethod: claim.verificationMethod,
    verification: safeVerificationForResponse(claim.verificationJson),
    verifiedAt: claim.verifiedAt,
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
  };
}

function serializeBinding(binding: DomainBinding) {
  return {
    id: binding.id,
    claimId: binding.domainClaimId,
    product: binding.product,
    hostname: binding.hostname,
    status: binding.status,
    readiness: binding.readinessJson,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function safeVerificationForResponse(value: unknown) {
  const verification = record(value);
  return {
    expected: verification.expected,
    lastCheck: verification.lastCheck,
    lastCheckedAt: verification.lastCheckedAt,
    schemaVersion: verification.schemaVersion,
  };
}

function assertDomainManageRole(workspace: DomainWorkspace) {
  const role = parseConsoleRole(workspace.membership.role);
  if (role !== "owner" && role !== "admin" && role !== "developer") {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }
}

function assertDomainManageOrReadRole(workspace: DomainWorkspace) {
  const role = parseConsoleRole(workspace.membership.role);
  if (role !== "owner" && role !== "admin" && role !== "developer" && role !== "viewer") {
    throw new ConsoleApiError(403, { error: "forbidden" });
  }
}

async function auditDomainMutation(input: {
  action: string;
  metadataJson?: JsonRecord;
  requestId: string;
  targetId: string;
  targetType: string;
  workspace: DomainWorkspace;
}) {
  await db.insert(schema.auditEvents).values({
    organizationId: input.workspace.organization.id,
    actorType: "user",
    actorId: input.workspace.user.id,
    targetType: input.targetType,
    targetId: input.targetId,
    action: input.action,
    requestId: input.requestId,
    metadataJson: input.metadataJson ?? {},
  });
}

function randomDnsToken() {
  return randomBytes(24).toString("base64url");
}

function domainUnavailable() {
  return new ConsoleApiError(409, { error: "domain_unavailable" });
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function textValue(value: unknown) {
  return typeof value === "string" ? value : null;
}
