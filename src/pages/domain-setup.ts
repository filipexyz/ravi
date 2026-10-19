/**
 * Pages custom-domain setup state, as Console sends it with
 * `DOMAIN_SETUP_REQUIRED` (`error.details.setups`).
 *
 * The projection keeps only the shape the CLI renders: hostnames, step ids and
 * statuses, and DNS records whose names and values look like DNS. Anything else
 * a remote side adds is dropped, so the same projection is safe for the local
 * Console client and for a gateway relaying the error.
 */

export const PAGES_CUSTOM_HOSTNAME_CNAME_TARGET = "cname.ravi.page";

export type PageDomainSetupStepId = "ownership" | "dns" | "certificate";

export interface PageDomainDnsRecord {
  type: string;
  name: string;
  value: string;
}

export interface PageDomainSetupStep {
  id: PageDomainSetupStepId;
  status: "done" | "pending" | "blocked";
  dnsRecords: PageDomainDnsRecord[];
}

export interface PageDomainSetup {
  hostname: string;
  state: "ownership_pending" | "pages_pending" | "ready";
  currentStep?: { id: PageDomainSetupStepId; number: number; total: number };
  steps?: PageDomainSetupStep[];
  nextActionCode?: string;
  dnsRecords?: PageDomainDnsRecord[];
  apex?: boolean;
  globalHost?: { active: boolean; dnsRecord: PageDomainDnsRecord };
}

const MAX_SETUPS = 20;
const MAX_RECORDS = 8;
const HOSTNAME_PATTERN = /^(?:\*\.)?(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;
const RECORD_TYPES = new Set(["A", "AAAA", "CNAME", "TXT"]);
const RECORD_VALUE_PATTERN = /^[A-Za-z0-9._=:/+-]{1,255}$/;
const ACTION_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const STEP_IDS = new Set<PageDomainSetupStepId>(["ownership", "dns", "certificate"]);
const STEP_STATUSES = new Set<PageDomainSetupStep["status"]>(["done", "pending", "blocked"]);
const SETUP_STATES = new Set<PageDomainSetup["state"]>(["ownership_pending", "pages_pending", "ready"]);

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function projectRecord(value: unknown): PageDomainDnsRecord | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const type = typeof record.type === "string" ? record.type.toUpperCase() : "";
  const name = typeof record.name === "string" ? record.name.toLowerCase().replace(/\.$/, "") : "";
  const recordValue = typeof record.value === "string" ? record.value.trim() : "";
  if (!RECORD_TYPES.has(type) || !HOSTNAME_PATTERN.test(name) || !RECORD_VALUE_PATTERN.test(recordValue)) {
    return undefined;
  }
  return { type, name, value: recordValue };
}

function projectRecords(value: unknown): PageDomainDnsRecord[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_RECORDS)
    .map(projectRecord)
    .filter((record): record is PageDomainDnsRecord => Boolean(record));
}

function projectStep(value: unknown): PageDomainSetupStep | undefined {
  const step = objectValue(value);
  if (!step) return undefined;
  const id = step.id as PageDomainSetupStepId;
  const status = step.status as PageDomainSetupStep["status"];
  if (!STEP_IDS.has(id) || !STEP_STATUSES.has(status)) return undefined;
  return { id, status, dnsRecords: projectRecords(step.dnsRecords) };
}

function projectSetup(value: unknown): PageDomainSetup | undefined {
  const setup = objectValue(value);
  if (!setup) return undefined;
  const hostname = typeof setup.hostname === "string" ? setup.hostname.toLowerCase() : "";
  const state = setup.state as PageDomainSetup["state"];
  if (!HOSTNAME_PATTERN.test(hostname) || !SETUP_STATES.has(state)) return undefined;

  const projected: PageDomainSetup = { hostname, state };
  if (Array.isArray(setup.steps)) {
    const steps = setup.steps
      .slice(0, STEP_IDS.size)
      .map(projectStep)
      .filter((step): step is PageDomainSetupStep => Boolean(step));
    if (steps.length > 0) {
      projected.steps = steps;
      const index = steps.findIndex((step) => step.status !== "done");
      if (index !== -1) projected.currentStep = { id: steps[index].id, number: index + 1, total: steps.length };
    }
  }
  const nextAction = objectValue(setup.nextAction);
  if (nextAction) {
    if (typeof nextAction.code === "string" && ACTION_CODE_PATTERN.test(nextAction.code)) {
      projected.nextActionCode = nextAction.code;
    }
    const dnsRecords = projectRecords(nextAction.dnsRecords);
    if (dnsRecords.length > 0) projected.dnsRecords = dnsRecords;
  }
  if (setup.apex === true) projected.apex = true;
  const globalHost = objectValue(setup.globalHost);
  const globalRecord = projectRecord(globalHost?.dnsRecord);
  if (globalHost && globalRecord && typeof globalHost.active === "boolean") {
    projected.globalHost = { active: globalHost.active, dnsRecord: globalRecord };
  }
  return projected;
}

/** Safe setup state from Console's `details.setups`, or undefined when nothing usable is there. */
export function projectPageDomainSetups(value: unknown): PageDomainSetup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const setups = value
    .slice(0, MAX_SETUPS)
    .map(projectSetup)
    .filter((setup): setup is PageDomainSetup => Boolean(setup));
  return setups.length > 0 ? setups : undefined;
}

/**
 * What the DNS will need before anything is written: one CNAME per hostname.
 * Ownership (TXT) is issued by Console on the first `--execute` when the
 * domain is not proven yet, so it cannot be shown here.
 */
export function plannedPageDomainDns(
  hostnames: string[],
): Array<{ hostname: string; dnsRecords: PageDomainDnsRecord[] }> {
  return hostnames.slice(0, MAX_SETUPS).map((input) => {
    const hostname = input.trim().toLowerCase().replace(/\.$/, "");
    return {
      hostname,
      dnsRecords: [{ type: "CNAME", name: hostname, value: PAGES_CUSTOM_HOSTNAME_CNAME_TARGET }],
    };
  });
}

/** Lines a person reads before `--execute`: the records to add and the two shortcuts. */
export function plannedPageDomainDnsLines(hostnames: string[]): string[] {
  const lines = ["DNS to add at the domain's DNS provider (proxy off / DNS only):"];
  for (const entry of plannedPageDomainDns(hostnames)) {
    for (const record of entry.dnsRecords) lines.push(`  ${record.type} ${record.name} = ${record.value}`);
  }
  lines.push(
    "If the domain is not proven yet, the first --execute also returns a TXT _ravi-verify.<domain> record.",
    `Global host: CNAME *.<domain> = ${PAGES_CUSTOM_HOSTNAME_CNAME_TARGET}, added once, covers every later subdomain.`,
    "Root domain (example.com): the DNS provider must support CNAME flattening or ALIAS/ANAME.",
  );
  return lines;
}
