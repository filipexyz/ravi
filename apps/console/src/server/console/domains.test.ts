import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { CloudflareCustomHostnameError } from "@/server/console/pages/cloudflare-custom-hostnames";
import {
  consolePageDomainSetupDetails,
  formatConsolePageDomainSetupRequired,
  globalHostParent,
  hostnameMatchesClaimApex,
  hostnamePointsToPages,
  hostnameIsWithinClaim,
  isPlatformReservedDomain,
  normalizeConsoleDomainBindingHostname,
  normalizeConsoleDomain,
  pageCustomDomainSummary,
  pagesReadinessNextAction,
  registrableConsoleDomainForHostname,
  retargetPageBindingJsonForTests,
  safeCloudflareCustomHostnameDnsRecords,
  safeCloudflareCustomHostnameErrorDiagnostics,
  safeCloudflareCustomHostnameErrorReason,
  selectBestOwnedDomainClaimForHostname,
  selectBestVerifiedDomainClaimForHostname,
  shouldExposeCloudflareOwnershipVerificationRecord,
} from "@/server/console/domains";

describe("console domain contracts", () => {
  test("canonicalizes owned domains to lowercase ASCII hostnames", () => {
    expect(normalizeConsoleDomain(" Anotações.com. ")).toBe("xn--anotaes-yxa0k.com");
    expect(normalizeConsoleDomain("MAIL.Customer.Example")).toBe("mail.customer.example");
  });

  test("rejects invalid or reserved domain inputs", () => {
    expect(() => normalizeConsoleDomain("127.0.0.1")).toThrow(ConsoleApiError);
    expect(() => normalizeConsoleDomain("bad..example")).toThrow(ConsoleApiError);
    expect(isPlatformReservedDomain("ravi.bot")).toBe(true);
    expect(isPlatformReservedDomain("mail.ravi.bot")).toBe(true);
  });

  test("requires product hostnames to stay below the verified claim", () => {
    expect(hostnameIsWithinClaim("mail.customer.example", "customer.example")).toBe(true);
    expect(hostnameIsWithinClaim("customer.example", "customer.example")).toBe(true);
    expect(hostnameIsWithinClaim("customer.example.attacker.test", "customer.example")).toBe(false);
  });

  test("detects apex hostnames so Pages can explain root-domain DNS", () => {
    expect(hostnameMatchesClaimApex("customer.example", "customer.example")).toBe(true);
    expect(hostnameMatchesClaimApex("www.customer.example", "customer.example")).toBe(false);
  });

  test("allows wildcard product binding hostnames below a verified claim", () => {
    expect(normalizeConsoleDomainBindingHostname(" *.Customer.Example. ")).toBe("*.customer.example");
    expect(hostnameIsWithinClaim("*.customer.example", "customer.example")).toBe(true);
    expect(hostnameIsWithinClaim("*.customer.example.attacker.test", "customer.example")).toBe(false);
    expect(() => normalizeConsoleDomainBindingHostname("*")).toThrow(ConsoleApiError);
  });

  test("derives ownership claims with public and private suffix awareness", () => {
    expect(registrableConsoleDomainForHostname("teste.raphaelmarra.com")).toBe("raphaelmarra.com");
    expect(registrableConsoleDomainForHostname("docs.customer.co.uk")).toBe("customer.co.uk");
    expect(registrableConsoleDomainForHostname("preview.customer.github.io")).toBe("customer.github.io");
    expect(() => registrableConsoleDomainForHostname("com")).toThrow(ConsoleApiError);
  });

  test("selects the most specific verified claim for a Pages hostname", () => {
    const claim = selectBestVerifiedDomainClaimForHostname("www.docs.customer.example", [
      {
        id: "claim_root",
        normalizedDomain: "customer.example",
        status: "active",
        verificationStatus: "verified",
      },
      {
        id: "claim_docs",
        normalizedDomain: "docs.customer.example",
        status: "active",
        verificationStatus: "verified",
      },
      {
        id: "claim_inactive",
        normalizedDomain: "www.docs.customer.example",
        status: "pending",
        verificationStatus: "verified",
      },
    ]);

    expect(claim?.id).toBe("claim_docs");
  });

  test("does not select unverified claims for a Pages hostname", () => {
    expect(
      selectBestVerifiedDomainClaimForHostname("www.customer.example", [
        {
          id: "claim_failed",
          normalizedDomain: "customer.example",
          status: "active",
          verificationStatus: "failed",
        },
      ]),
    ).toBeNull();
  });

  test("prefers a verified owned claim before a more specific pending claim", () => {
    const claim = selectBestOwnedDomainClaimForHostname("www.docs.customer.com", [
      {
        id: "claim_verified",
        normalizedDomain: "customer.com",
        status: "active",
        verificationStatus: "verified",
      },
      {
        id: "claim_pending",
        normalizedDomain: "docs.customer.com",
        status: "pending",
        verificationStatus: "failed",
      },
    ]);

    expect(claim?.id).toBe("claim_verified");
  });

  test("reuses the most specific pending owned claim when none is verified", () => {
    const claim = selectBestOwnedDomainClaimForHostname("www.docs.customer.com", [
      {
        id: "claim_root",
        normalizedDomain: "customer.com",
        status: "pending",
        verificationStatus: "pending",
      },
      {
        id: "claim_docs",
        normalizedDomain: "docs.customer.com",
        status: "pending",
        verificationStatus: "failed",
      },
    ]);

    expect(claim?.id).toBe("claim_docs");
  });

  test("formats one actionable non-terminal setup response for released clients", () => {
    const message = formatConsolePageDomainSetupRequired([
      {
        hostname: "teste.raphaelmarra.com",
        nextAction: {
          code: "add_ownership_txt",
          dnsRecords: [
            {
              name: "_ravi-verify.raphaelmarra.com",
              type: "TXT",
              value: "ravi-domain-verification=test-token",
            },
          ],
          message: "Add this ownership record to the domain's authoritative DNS.",
        },
        state: "ownership_pending",
      },
    ]);

    expect(message).toContain("Pages domain setup was saved");
    expect(message).toContain(
      "TXT _ravi-verify.raphaelmarra.com = ravi-domain-verification=test-token",
    );
    expect(message).toContain("rerun the same ravi pages domains command");
  });

  test("names the current step and hands out the TXT and the CNAME in one message", () => {
    const setups = [
      {
        globalHost: {
          active: false,
          dnsRecord: { name: "*.rbbt.page", type: "CNAME", value: "cname.ravi.page" },
        },
        hostname: "nba-ui.rbbt.page",
        nextAction: {
          code: "add_ownership_txt",
          dnsRecords: [
            { name: "_ravi-verify.rbbt.page", type: "TXT", value: "ravi-domain-verification=t" },
            { name: "nba-ui.rbbt.page", type: "CNAME", value: "cname.ravi.page" },
          ],
          message: "Add these records.",
        },
        state: "ownership_pending" as const,
        steps: [
          {
            dnsRecords: [{ name: "_ravi-verify.rbbt.page", type: "TXT", value: "ravi-domain-verification=t" }],
            id: "ownership" as const,
            status: "pending" as const,
          },
          {
            dnsRecords: [{ name: "nba-ui.rbbt.page", type: "CNAME", value: "cname.ravi.page" }],
            id: "dns" as const,
            status: "pending" as const,
          },
          { dnsRecords: [], id: "certificate" as const, status: "pending" as const },
        ],
      },
    ];

    const message = formatConsolePageDomainSetupRequired(setups);
    expect(message).toContain("nba-ui.rbbt.page (step 1 of 3: Ownership)");
    expect(message).toContain("TXT _ravi-verify.rbbt.page = ravi-domain-verification=t");
    expect(message).toContain("CNAME nba-ui.rbbt.page = cname.ravi.page");
    expect(message).toContain("[ ] 2. DNS: waiting for nba-ui.rbbt.page to point to cname.ravi.page");
    expect(message).toContain("Global host: add CNAME *.rbbt.page = cname.ravi.page once");

    expect(consolePageDomainSetupDetails(setups).setups[0]).toMatchObject({
      currentStep: { id: "ownership", number: 1, total: 3 },
      globalHost: { active: false },
      hostname: "nba-ui.rbbt.page",
      state: "ownership_pending",
    });
  });

  test("tells root domains they need CNAME flattening or ALIAS", () => {
    const message = formatConsolePageDomainSetupRequired([
      {
        apex: true,
        hostname: "rbbt.page",
        nextAction: {
          code: "configure_pages_dns",
          dnsRecords: [{ name: "rbbt.page", type: "CNAME", value: "cname.ravi.page" }],
          message: "Add or keep these records.",
        },
        state: "pages_pending",
        steps: [
          { dnsRecords: [], id: "ownership", status: "done" },
          { dnsRecords: [{ name: "rbbt.page", type: "CNAME", value: "cname.ravi.page" }], id: "dns", status: "pending" },
          { dnsRecords: [], id: "certificate", status: "pending" },
        ],
      },
    ]);

    expect(message).toContain("rbbt.page (step 2 of 3: DNS)");
    expect(message).toContain("[x] 1. Ownership: verified");
    expect(message).toContain("CNAME flattening");
    expect(message).not.toContain("Global host");
  });

  test("offers a global host only for subdomains inside the claim", () => {
    expect(globalHostParent("nba-ui.rbbt.page", "rbbt.page")).toBe("rbbt.page");
    expect(globalHostParent("a.docs.customer.com", "customer.com")).toBe("docs.customer.com");
    expect(globalHostParent("rbbt.page", "rbbt.page")).toBeNull();
    expect(globalHostParent("*.rbbt.page", "rbbt.page")).toBeNull();
  });

  test("checks the hostname CNAME against the Pages target", async () => {
    const resolver = (answers: Record<string, string[]>) => ({
      resolveCname: async (hostname: string) => {
        const answer = answers[hostname];
        if (!answer) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
        return answer;
      },
      resolveTxt: async () => [],
    });

    expect(await hostnamePointsToPages("www.customer.com", resolver({ "www.customer.com": ["CNAME.ravi.page."] }))).toBe(true);
    expect(await hostnamePointsToPages("www.customer.com", resolver({ "www.customer.com": ["other.example"] }))).toBe(false);
    expect(await hostnamePointsToPages("www.customer.com", resolver({}))).toBe(false);
    expect(await hostnamePointsToPages("*.customer.com", resolver({ "*.customer.com": ["cname.ravi.page"] }))).toBe(false);
  });

  test("serves a rebound root domain instead of redirecting it to www", () => {
    const result = retargetPageBindingJsonForTests({
      claimDomain: "customer.example",
      hostname: "customer.example",
      policyJson: { mode: "redirect", redirectToHostname: "www.customer.example", siteId: "old_site" },
      readinessJson: { mode: "redirect", redirectToHostname: "www.customer.example", siteId: "old_site", status: "ready" },
      siteId: "new_site",
    });

    expect(result.policyJson).toEqual({ mode: "serve", siteId: "new_site" });
    expect(result.readinessJson).not.toHaveProperty("redirectToHostname");
    expect(result.readinessJson).toMatchObject({ mode: "serve", siteId: "new_site" });
  });

  test("does not misrepresent provider configuration failures as customer DNS work", () => {
    expect(
      pagesReadinessNextAction({
        readiness: {
          dns: {
            records: [
              { name: "teste.raphaelmarra.com", type: "CNAME", value: "cname.ravi.page" },
            ],
          },
          edge: {
            reason: "cloudflare_custom_hostname_provider_unauthorized",
          },
          status: "pending",
        },
      }),
    ).toEqual({
      code: "contact_operator",
      dnsRecords: [],
      message: "Ravi Pages custom-domain provisioning needs operator attention before setup can continue.",
    });
  });

  test("serializes safe Cloudflare custom hostname DNS records from all validation sources", () => {
    expect(
      safeCloudflareCustomHostnameDnsRecords({
        hostname: "*.customer.example",
        id: "custom_1",
        ownership_verification: {
          name: "_cf-custom-hostname.customer.example",
          type: "txt",
          value: "ownership-token",
        },
        ssl: {
          dcv_delegation_records: [
            {
              cname: "_acme-challenge.customer.example",
              cname_target: "_acme-challenge.customer.example.dcv.cloudflare.com",
            },
          ],
          validation_records: [
            {
              txt_name: "_acme-challenge.customer.example",
              txt_value: "certificate-token",
            },
          ],
        },
      }),
    ).toEqual([
      {
        name: "_cf-custom-hostname.customer.example",
        type: "TXT",
        value: "ownership-token",
      },
      {
        name: "_acme-challenge.customer.example",
        type: "CNAME",
        value: "_acme-challenge.customer.example.dcv.cloudflare.com",
      },
      {
        name: "_acme-challenge.customer.example",
        type: "TXT",
        value: "certificate-token",
      },
    ]);
  });

  test("retargets same-organization Pages bindings without losing readiness state", () => {
    const result = retargetPageBindingJsonForTests({
      claimDomain: "customer.example",
      hostname: "www.customer.example",
      policyJson: {
        mode: "serve",
        siteId: "old_site",
      },
      readinessJson: {
        checkedAt: "2026-06-06T20:00:00.000Z",
        dns: {
          records: [{ name: "www.customer.example", type: "CNAME", value: "cname.ravi.page" }],
          status: "ready",
        },
        edge: {
          adapter: "cloudflare_for_saas",
          status: "ready",
        },
        siteId: "old_site",
        status: "ready",
      },
      siteId: "new_site",
    });

    expect(result.policyJson).toMatchObject({
      mode: "serve",
      siteId: "new_site",
    });
    expect(result.readinessJson).toMatchObject({
      checkedAt: "2026-06-06T20:00:00.000Z",
      dns: {
        records: [{ name: "www.customer.example", type: "CNAME", value: "cname.ravi.page" }],
        status: "ready",
      },
      edge: {
        adapter: "cloudflare_for_saas",
        status: "ready",
      },
      hostname: "www.customer.example",
      mode: "serve",
      siteId: "new_site",
      status: "ready",
    });
  });

  test("hides Cloudflare ownership TXT for normal HTTP validation", () => {
    const hostname = {
      hostname: "www.customer.example",
      id: "custom_1",
      ownership_verification: {
        name: "_cf-custom-hostname.www.customer.example",
        type: "txt",
        value: "ownership-token",
      },
      ssl: {
        method: "http",
        status: "pending_validation",
      },
    };

    expect(shouldExposeCloudflareOwnershipVerificationRecord(hostname)).toBe(false);
    expect(
      safeCloudflareCustomHostnameDnsRecords(hostname, {
        includeOwnershipVerification: shouldExposeCloudflareOwnershipVerificationRecord(hostname),
      }),
    ).toEqual([]);
  });

  test("keeps Cloudflare ownership TXT for wildcard or non-http validation", () => {
    const hostname = {
      hostname: "*.customer.example",
      id: "custom_1",
      ownership_verification: {
        name: "_cf-custom-hostname.customer.example",
        type: "txt",
        value: "ownership-token",
      },
      ssl: {
        method: "txt",
        status: "pending_validation",
      },
    };

    expect(shouldExposeCloudflareOwnershipVerificationRecord(hostname)).toBe(true);
    expect(
      safeCloudflareCustomHostnameDnsRecords(hostname, {
        includeOwnershipVerification: shouldExposeCloudflareOwnershipVerificationRecord(hostname),
      }),
    ).toEqual([
      {
        name: "_cf-custom-hostname.customer.example",
        type: "TXT",
        value: "ownership-token",
      },
    ]);
  });

  test("maps Cloudflare authentication API codes to a credential readiness reason", () => {
    expect(
      safeCloudflareCustomHostnameErrorReason(
        new CloudflareCustomHostnameError("CF_10000", "Authentication error", 403),
      ),
    ).toBe("cloudflare_custom_hostname_provider_unauthorized");
    expect(
      safeCloudflareCustomHostnameErrorReason(
        new CloudflareCustomHostnameError("CF_9109", "Unauthorized to access requested resource", 403),
      ),
    ).toBe("cloudflare_custom_hostname_provider_unauthorized");
  });

  test("serializes sanitized Cloudflare diagnostics for observability", () => {
    const error = new CloudflareCustomHostnameError(
      "CF_10000",
      ` Authentication error\n${"x".repeat(600)}`,
      403,
      { token: "must-not-leak", providerPayload: true },
    );

    const diagnostics = safeCloudflareCustomHostnameErrorDiagnostics(error);

    expect(diagnostics).toMatchObject({
      code: "CF_10000",
      name: "CloudflareCustomHostnameError",
      status: 403,
    });
    expect(String(diagnostics.message).length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(diagnostics)).not.toContain("must-not-leak");
    expect(JSON.stringify(diagnostics)).not.toContain("providerPayload");
  });
});

describe("pageCustomDomainSummary", () => {
  const pendingReadiness = (hostname: string) => ({
    dns: { records: [{ name: hostname, type: "CNAME", value: "cname.ravi.page" }], status: "pending" },
    edge: { reason: "cloudflare_custom_hostname_pending", status: "pending" },
    status: "pending",
  });

  test("a ready binding carries no next action", () => {
    expect(pageCustomDomainSummary("www.acme.com", "active", { status: "ready" })).toEqual({
      hostname: "www.acme.com",
      status: "ready",
    });
  });

  test("a pending subdomain names the DNS record still missing", () => {
    expect(pageCustomDomainSummary("www.acme.com", "pending", pendingReadiness("www.acme.com"))).toEqual({
      hostname: "www.acme.com",
      status: "pending",
      nextAction: {
        code: "configure_pages_dns",
        dnsRecords: [{ name: "www.acme.com", type: "CNAME", value: "cname.ravi.page" }],
        message: "Add or keep these records in the hostname's authoritative DNS.",
      },
    });
  });

  test("a pending root domain says a plain A record does not work", () => {
    const summary = pageCustomDomainSummary("acme.com", "pending", pendingReadiness("acme.com"));
    expect(summary.status).toBe("pending");
    expect(summary.apex).toBe(true);
    expect(summary.nextAction?.message).toContain("plain A records are not supported");
  });

  test("a pending binding without DNS instructions waits on Pages", () => {
    expect(pageCustomDomainSummary("docs.acme.com", "pending", {})).toMatchObject({
      status: "pending",
      nextAction: { code: "wait_for_pages", dnsRecords: [] },
    });
  });
});
