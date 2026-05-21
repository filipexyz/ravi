import "reflect-metadata";
import { Arg, Command, Group, Option, Scope } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import {
  cancelCrmTask,
  completeCrmTask,
  confirmCrmFact,
  createCrmAccount,
  createCrmOpportunity,
  createCrmTask,
  getCrmAccount,
  getCrmContactProfile,
  getCrmOpportunity,
  getCrmTask,
  linkCrmAccountContact,
  linkCrmOpportunityContact,
  listCrmContactCards,
  listCrmFacts,
  listCrmNextActions,
  listCrmOpportunityBoard,
  listCrmOpportunityContacts,
  listCrmTasks,
  moveCrmOpportunityStage,
  proposeCrmFact,
  rejectCrmFact,
  snoozeCrmTask,
  updateCrmContactProfile,
  type CrmOwnerType,
} from "../../contacts.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parseOwner(owner?: string): { ownerType?: CrmOwnerType; ownerId?: string } {
  const raw = owner?.trim();
  if (!raw) return {};
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail("--owner must use <type:id>, e.g. agent:main or team:sales");
  }
  const ownerType = raw.slice(0, separator) as CrmOwnerType;
  const ownerId = raw.slice(separator + 1);
  return { ownerType, ownerId };
}

function parseOptionalNumber(value: string | undefined, label: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === "-" || value === "null") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a number`);
  return parsed;
}

function parseJsonObjectArg(value: string): Record<string, unknown> | null {
  if (value === "-" || value === "null") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) fail("metadata must be a JSON object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonValueArg(value: string): unknown {
  if (value === "-" || value === "null") return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseNullable(value: string): string | null {
  return value === "-" || value === "null" ? null : value;
}

function renderNextAction(action: {
  taskId: string;
  priority: string;
  dueAt: string | null;
  title: string;
  contactName: string | null;
  accountName: string | null;
}) {
  const target = action.contactName ?? action.accountName ?? "-";
  console.log(`- ${action.priority.padEnd(7)} ${action.dueAt ?? "-"} ${action.taskId} ${target}: ${action.title}`);
}

function showCrmContactProfile(contactRef: string, asJson?: boolean) {
  const profile = getCrmContactProfile(contactRef);
  if (!profile) fail(`Contact not found: ${contactRef}`);
  const payload = { target: contactRef, crm: profile };
  if (asJson) {
    printJson(payload);
    return payload;
  }
  renderCrmContactCard(profile);
  return payload;
}

// ============================================================================
// Rich contact card renderer (text mode)
// ============================================================================

const CARD_WIDTH = 80;
const FACT_VALUE_PREVIEW = 200;

function renderCrmContactCard(profile: NonNullable<ReturnType<typeof getCrmContactProfile>>): void {
  const { contact, policy, profile: prof, accountMemberships, opportunities, tasks, nextActions, facts } = profile;
  const name = contact.displayName?.trim() || contact.id;

  console.log("");
  console.log(name);
  console.log(divider("─"));
  printPair("id", contact.id, "kind", contact.kind);
  printPair("phone", contact.primaryPhone ?? "-", "email", contact.primaryEmail ?? "-");
  printPair("added", formatDate(contact.createdAt), "updated", formatDate(contact.updatedAt));

  console.log("");
  console.log("Status");
  printPair(
    "lifecycle",
    prof?.lifecycle ?? "unknown",
    "health",
    prof?.relationshipHealth ?? "unknown",
    "priority",
    prof?.priority ?? "normal",
  );
  printPair(
    "policy",
    policy?.status ?? "unknown",
    "reply",
    policy?.replyMode ?? "auto",
    "opt-out",
    formatBool(policy?.optOut),
  );
  const owner = formatOwner(prof?.ownerType, prof?.ownerId);
  printPair("owner", owner, "source", policy?.source ?? "-");
  const allowed = policy?.allowedAgents?.length ? policy.allowedAgents.join(", ") : "(all)";
  printPair("allowed agents", allowed);
  if (prof?.nextActionSummary || prof?.nextActionAt) {
    const due = prof.nextActionAt ? formatDate(prof.nextActionAt) : "-";
    printPair("next at", due);
    printBlockValue("next", prof.nextActionSummary ?? "-");
  }

  console.log("");
  console.log("Interactions");
  printPair(
    "count",
    String(policy?.interactionCount ?? 0),
    "last in",
    formatRelative(policy?.lastInboundAt),
    "last out",
    formatRelative(policy?.lastOutboundAt),
  );
  if (prof?.lastMeaningfulInteractionAt) {
    printPair("last meaningful", formatRelative(prof.lastMeaningfulInteractionAt));
  }

  const tags = policy?.tags ?? [];
  console.log("");
  console.log(`Tags (${tags.length})`);
  console.log(`  ${tags.length === 0 ? "(none)" : tags.join(", ")}`);

  const notes = policy?.notes && typeof policy.notes === "object" ? (policy.notes as Record<string, unknown>) : {};
  const noteKeys = Object.keys(notes);
  if (noteKeys.length > 0) {
    console.log("");
    console.log(`Notes (${noteKeys.length})`);
    for (const k of noteKeys.slice(0, 10)) {
      printBlockValue(k, formatNoteValue(notes[k]));
    }
    if (noteKeys.length > 10) {
      console.log(`  … ${noteKeys.length - 10} more (--json for all)`);
    }
  }

  const confirmedFacts = facts.filter((f) => f.status === "confirmed");
  const proposedFacts = facts.filter((f) => f.status === "proposed");
  if (facts.length > 0) {
    console.log("");
    const summary = [
      confirmedFacts.length ? `${confirmedFacts.length} confirmed` : null,
      proposedFacts.length ? `${proposedFacts.length} proposed` : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(`Facts (${summary || facts.length})`);
    for (const fact of confirmedFacts) printFact(fact);
    if (proposedFacts.length > 0) {
      console.log("");
      console.log("  Proposed");
      for (const fact of proposedFacts) printFact(fact);
    }
  }

  if (accountMemberships.length > 0) {
    console.log("");
    console.log(`Accounts (${accountMemberships.length})`);
    for (const m of accountMemberships) {
      const accName = m.account?.name ?? "(no name)";
      const role = m.role ? ` · role ${m.role}` : "";
      const primary = m.isPrimary ? " · primary" : "";
      console.log(`  · ${accName} (${m.accountId})${role}${primary}`);
    }
  }

  if (opportunities.length > 0) {
    console.log("");
    console.log(`Opportunities (${opportunities.length})`);
    for (const o of opportunities) {
      const value = o.valueCents != null ? formatMoney(o.valueCents, o.currency) : "-";
      console.log(`  · ${o.title} · ${o.status} · ${o.priority} · value ${value}`);
    }
  }

  const openTasks = tasks.filter((t) => t.status !== "done" && t.status !== "canceled");
  if (openTasks.length > 0) {
    console.log("");
    console.log(`Open tasks (${openTasks.length})`);
    for (const t of openTasks.slice(0, 10)) {
      const due = t.dueAt ? formatDate(t.dueAt) : "-";
      console.log(`  · [${t.priority}] ${due} · ${t.title}`);
    }
    if (openTasks.length > 10) {
      console.log(`  … ${openTasks.length - 10} more (ravi crm tasks list --contact ${contact.id})`);
    }
  }

  if (nextActions.length > 0) {
    console.log("");
    console.log(`Next actions (${nextActions.length})`);
    for (const a of nextActions.slice(0, 10)) {
      const due = a.dueAt ? formatDate(a.dueAt) : "-";
      console.log(`  · [${a.priority}] ${due} · ${a.title}`);
    }
  }

  // Footer: link counts (always shown so callers know they exist even when empty),
  // plus pointer to --json for the raw payload.
  console.log("");
  console.log(
    `Links: ${accountMemberships.length} accounts · ${opportunities.length} opportunities · ${tasks.length} tasks · ${nextActions.length} next actions`,
  );
  console.log("Run with --json for the full payload (raw facts, evidence, metadata, all timestamps).");
}

function divider(char: string): string {
  return char.repeat(Math.min(CARD_WIDTH, 80));
}

function printPair(...labelValuePairs: string[]): void {
  // Compact 3-column layout: each pair is `label: value` with column padding.
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < labelValuePairs.length; i += 2) {
    pairs.push([labelValuePairs[i] ?? "", labelValuePairs[i + 1] ?? "-"]);
  }
  const cellWidth = pairs.length === 1 ? 76 : pairs.length === 2 ? 38 : 25;
  const cells = pairs.map(([label, value]) => {
    const text = `${label}: ${value}`;
    return text.length > cellWidth ? `${text.slice(0, cellWidth - 1)}…` : text.padEnd(cellWidth);
  });
  console.log(`  ${cells.join("")}`);
}

function printBlockValue(label: string, value: string): void {
  const lines = value.split("\n");
  console.log(`  ${label}:`);
  for (const line of lines) {
    const wrapped = line.length > CARD_WIDTH - 4 ? `${line.slice(0, CARD_WIDTH - 5)}…` : line;
    console.log(`    ${wrapped}`);
  }
}

function printFact(fact: {
  key: string;
  value: unknown;
  status: string;
  confidence: number;
  source: string;
  updatedAt: string;
}): void {
  const value = formatFactValue(fact.value);
  console.log(`  · ${fact.key}`);
  const wrapped = value.length > CARD_WIDTH - 6 ? `${value.slice(0, CARD_WIDTH - 7)}…` : value;
  console.log(`      ${wrapped}`);
  const conf = Number.isFinite(fact.confidence) ? fact.confidence.toFixed(2) : "?";
  console.log(`      ${fact.status} · confidence ${conf} · source ${fact.source} · ${formatDate(fact.updatedAt)}`);
}

function formatFactValue(value: unknown): string {
  if (value == null) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > FACT_VALUE_PREVIEW ? `${json.slice(0, FACT_VALUE_PREVIEW - 1)}…` : json;
  } catch {
    return String(value);
  }
}

function formatNoteValue(value: unknown): string {
  return formatFactValue(value);
}

function formatBool(value: boolean | null | undefined): string {
  return value ? "yes" : "no";
}

function formatOwner(ownerType?: string | null, ownerId?: string | null): string {
  if (!ownerType && !ownerId) return "-";
  if (ownerType && ownerId) return `${ownerType}:${ownerId}`;
  return ownerType ?? ownerId ?? "-";
}

// SQLite CURRENT_TIMESTAMP serializes as `YYYY-MM-DD HH:MM:SS` (no T, no
// zone). The DB stores UTC but the string lacks the marker, so plain
// `new Date(s)` parses it as local — making "now" look hours in the
// future on negative-offset hosts. Patch the marker when we detect the
// SQLite shape; otherwise pass through.
function parseTimestamp(value: string | number): Date {
  if (typeof value === "number") return new Date(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return new Date(`${value.replace(" ", "T")}Z`);
  }
  return new Date(value);
}

function formatDate(value: string | number | null | undefined): string {
  if (value == null) return "-";
  const d = parseTimestamp(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
}

function formatRelative(value: string | number | null | undefined): string {
  if (value == null) return "never";
  const d = parseTimestamp(value);
  if (Number.isNaN(d.getTime())) return "never";
  const ms = Date.now() - d.getTime();
  if (ms < 0) return formatDate(value);
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return formatDate(value);
}

function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${amount}`;
}

function showCrmAccount(accountRef: string, asJson?: boolean) {
  const account = getCrmAccount(accountRef);
  if (!account) fail(`CRM account not found: ${accountRef}`);
  const payload = { target: accountRef, crm: account };
  if (asJson) {
    printJson(payload);
    return payload;
  }
  console.log(`\nCRM account: ${account.account.name}`);
  console.log(`  id: ${account.account.id}`);
  console.log(`  contacts: ${account.contacts.length}`);
  console.log(`  opportunities: ${account.opportunities.length}`);
  console.log(`  tasks: ${account.tasks.length}`);
  return payload;
}

function showCrmOpportunity(opportunityId: string, asJson?: boolean) {
  const opportunity = getCrmOpportunity(opportunityId);
  if (!opportunity) fail(`CRM opportunity not found: ${opportunityId}`);
  const payload = { target: opportunityId, opportunity };
  if (asJson) {
    printJson(payload);
    return payload;
  }
  console.log(`\nCRM opportunity: ${opportunity.title}`);
  console.log(`  status: ${opportunity.status}`);
  console.log(`  priority: ${opportunity.priority}`);
  console.log(`  value: ${opportunity.valueCents ?? "-"} ${opportunity.currency}`);
  return payload;
}

@Group({
  name: "crm",
  description: "CRM relationship surface",
})
export class ACrmCommands {
  @Scope("open")
  @Command({ name: "next", description: "List open CRM next actions" })
  next(
    @Option({ flags: "--owner <type:id>", description: "Filter by owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--contact <contact>", description: "Filter by contact" }) contact?: string,
    @Option({ flags: "--account <account>", description: "Filter by account" }) account?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Filter by opportunity" }) opportunity?: string,
    @Option({ flags: "--task-type <type>", description: "Filter by task_type (e.g. commitment, follow_up, call)" })
    taskType?: string,
    @Option({ flags: "--due-today", description: "Only actions whose due_at is today" }) dueToday?: boolean,
    @Option({ flags: "--due-before <ts>", description: "Only actions with due_at < <ts>" }) dueBefore?: string,
    @Option({ flags: "--due-after <ts>", description: "Only actions with due_at >= <ts>" }) dueAfter?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 25, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching actions to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ownerFilter = parseOwner(owner);
    const page = listCrmNextActions({
      ...ownerFilter,
      contactRef: contact,
      accountId: account,
      opportunityId: opportunity,
      taskType,
      dueToday: Boolean(dueToday),
      dueBefore,
      dueAfter,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "next"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--owner",
        owner,
        "--contact",
        contact,
        "--account",
        account,
        "--opportunity",
        opportunity,
        "--task-type",
        taskType,
        ...(dueToday ? ["--due-today"] : []),
        "--due-before",
        dueBefore,
        "--due-after",
        dueAfter,
      ],
    });
    const payload = { total: page.total, pagination, items: page.items, actions: page.items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No open CRM next actions.");
      return payload;
    }
    console.log(`\nCRM next actions (${page.items.length} returned of ${page.total}):\n`);
    for (const action of page.items) renderNextAction(action);
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("open")
  @Command({ name: "contact", description: "Show CRM profile for one contact" })
  contact(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmContactProfile(contactRef, asJson);
  }

  @Scope("open")
  @Command({ name: "account", description: "Show CRM account" })
  account(
    @Arg("account", { description: "CRM account ID or org contact ID" }) accountRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmAccount(accountRef, asJson);
  }

  @Scope("open")
  @Command({ name: "opportunity", description: "Show CRM opportunity" })
  opportunity(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmOpportunity(opportunityId, asJson);
  }

  @Scope("open")
  @Command({ name: "contacts", description: "List CRM contact cards" })
  contacts(
    @Option({ flags: "--status <lifecycle>", description: "Filter by CRM lifecycle" }) lifecycle?: string,
    @Option({ flags: "--owner <type:id>", description: "Filter by owner" }) owner?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching contacts to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ownerFilter = parseOwner(owner);
    const page = listCrmContactCards({ ...ownerFilter, lifecycle, limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "contacts"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--status", lifecycle, "--owner", owner],
    });
    const payload = { total: page.total, pagination, items: page.items, contacts: page.items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM contacts found.");
      return payload;
    }
    console.log(`\nCRM contacts (${page.items.length} returned of ${page.total}):\n`);
    for (const contact of page.items) {
      console.log(
        `- ${contact.contactId} ${contact.displayName ?? "-"} lifecycle=${contact.lifecycle ?? "unknown"} next=${contact.nextActionSummary ?? "-"}`,
      );
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("open")
  @Command({ name: "board", description: "Show open opportunity board" })
  board(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const board = listCrmOpportunityBoard();
    const payload = { total: board.length, opportunities: board };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (board.length === 0) {
      console.log("No open CRM opportunities.");
      return payload;
    }
    console.log("\nCRM opportunity board:\n");
    for (const opportunity of board) {
      console.log(`- ${opportunity.stageKey ?? "-"} ${opportunity.opportunityId}: ${opportunity.title}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.contact",
  description: "CRM contact profile mutations",
})
export class CrmContactCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM profile for one contact" })
  show(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmContactProfile(contactRef, asJson);
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set one CRM contact profile field" })
  set(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("field", { description: "CRM field" }) field: string,
    @Arg("value", { description: "Field value, '-' to clear nullable fields" }) value: string,
    @Option({ flags: "--source <source>", description: "Mutation source (default: cli)" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const input: Parameters<typeof updateCrmContactProfile>[0] = {
      contactRef,
      source: source?.trim() || "cli",
      actorType: "user",
    };
    switch (field) {
      case "lifecycle":
        input.lifecycle = parseNullable(value);
        break;
      case "relationship-health":
      case "health":
        input.relationshipHealth = parseNullable(value);
        break;
      case "priority":
        input.priority = parseNullable(value);
        break;
      case "score":
        input.score = parseOptionalNumber(value, "score");
        break;
      case "health-score":
        input.healthScore = parseOptionalNumber(value, "health-score");
        break;
      case "owner": {
        if (value === "-" || value === "null") {
          input.ownerType = null;
          input.ownerId = null;
        } else {
          Object.assign(input, parseOwner(value));
        }
        break;
      }
      case "primary-account":
        input.primaryAccountId = parseNullable(value);
        break;
      case "primary-opportunity":
        input.primaryOpportunityId = parseNullable(value);
        break;
      case "lead-source":
        input.leadSource = parseNullable(value);
        break;
      case "persona":
        input.persona = parseNullable(value);
        break;
      case "buying-role":
        input.buyingRole = parseNullable(value);
        break;
      case "last-meaningful-interaction-at":
        input.lastMeaningfulInteractionAt = parseNullable(value);
        break;
      case "next-action-at":
        input.nextActionAt = parseNullable(value);
        break;
      case "next-action-summary":
        input.nextActionSummary = parseNullable(value);
        break;
      case "next-task":
        input.nextTaskId = parseNullable(value);
        break;
      case "metadata":
        input.metadata = parseJsonObjectArg(value);
        break;
      default:
        fail(
          "Unknown CRM contact field. Use lifecycle, relationship-health, priority, score, health-score, owner, primary-account, primary-opportunity, lead-source, persona, buying-role, next-action-at, next-action-summary, next-task, metadata.",
        );
    }
    const profile = updateCrmContactProfile(input);
    const payload = { status: "updated" as const, contactId: profile.contactId, field, profile, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM contact updated: ${profile.contactId} ${field}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.account",
  description: "CRM account mutations",
})
export class CrmAccountCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM account" })
  show(
    @Arg("account", { description: "CRM account ID or org contact ID" }) accountRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmAccount(accountRef, asJson);
  }

  @Scope("writeContacts")
  @Command({ name: "create", description: "Create a CRM account" })
  create(
    @Arg("name", { description: "Account name" }) name: string,
    @Option({ flags: "--contact <orgContact>", description: "Organization contact ID" }) orgContactRef?: string,
    @Option({ flags: "--domain <domain>", description: "Account domain" }) domain?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated account creation" })
    idempotencyKey?: string,
  ) {
    const account = createCrmAccount({
      name,
      orgContactRef,
      domain,
      ...parseOwner(owner),
      idempotencyKey,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "created" as const, account, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM account created: ${account.id} ${account.name}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "link-contact", description: "Link a contact to an account" })
  linkContact(
    @Arg("account", { description: "CRM account ID" }) accountId: string,
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--role <role>", description: "Membership role (default: member)" }) role?: string,
    @Option({ flags: "--primary", description: "Mark as primary account contact" }) primary?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const membership = linkCrmAccountContact({
      accountId,
      contactRef,
      role,
      isPrimary: primary === true ? true : undefined,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "linked" as const, membership, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM account contact linked: ${membership.accountId} -> ${membership.contactId}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.opportunity",
  description: "CRM opportunity mutations",
})
export class CrmOpportunityCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM opportunity" })
  show(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return showCrmOpportunity(opportunityId, asJson);
  }

  @Scope("writeContacts")
  @Command({ name: "create", description: "Create a CRM opportunity" })
  create(
    @Arg("title", { description: "Opportunity title" }) title: string,
    @Option({ flags: "--account <account>", description: "CRM account ID" }) accountId?: string,
    @Option({ flags: "--contact <contact>", description: "Contact ID or identity" }) contactRef?: string,
    @Option({ flags: "--stage <stage>", description: "Pipeline stage key or ID" }) stage?: string,
    @Option({ flags: "--value <cents>", description: "Opportunity value in cents" }) value?: string,
    @Option({ flags: "--currency <code>", description: "Currency (default: BRL)" }) currency?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated opportunity creation" })
    idempotencyKey?: string,
  ) {
    const opportunity = createCrmOpportunity({
      title,
      accountId,
      contactRef,
      stageKey: stage,
      valueCents: parseOptionalNumber(value, "value") ?? undefined,
      currency,
      ...parseOwner(owner),
      idempotencyKey,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "created" as const, opportunity, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM opportunity created: ${opportunity.id} ${opportunity.title}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "move", description: "Move an opportunity to another stage" })
  move(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Arg("stage", { description: "Pipeline stage key or ID" }) stageRef: string,
    @Option({ flags: "--lost-reason <text>", description: "Lost reason when moving to lost" }) lostReason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const opportunity = moveCrmOpportunityStage({
      opportunityId,
      stageRef,
      lostReason,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "moved" as const, opportunity, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM opportunity moved: ${opportunity.id} status=${opportunity.status}`);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "contacts", description: "List contacts linked to an opportunity" })
  contacts(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contacts = listCrmOpportunityContacts(opportunityId);
    const payload = { total: contacts.length, contacts };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (contacts.length === 0) {
      console.log("No CRM opportunity contacts.");
      return payload;
    }
    for (const contact of contacts) {
      console.log(`- ${contact.isPrimary ? "*" : "-"} ${contact.contactId} ${contact.role}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "link-contact", description: "Link a contact to an opportunity" })
  linkContact(
    @Arg("opportunity", { description: "CRM opportunity ID" }) opportunityId: string,
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--role <role>", description: "Opportunity role (default: stakeholder)" }) role?: string,
    @Option({ flags: "--account <account>", description: "CRM account ID" }) accountId?: string,
    @Option({ flags: "--primary", description: "Mark as primary opportunity contact" }) primary?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = linkCrmOpportunityContact({
      opportunityId,
      contactRef,
      role,
      accountId,
      isPrimary: primary === true ? true : undefined,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "linked" as const, contact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM opportunity contact linked: ${contact.opportunityId} -> ${contact.contactId}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.fact",
  description: "CRM proposed and confirmed facts",
})
export class CrmFactCommands {
  @Scope("open")
  @Command({ name: "list", description: "List CRM facts" })
  list(
    @Option({ flags: "--entity-type <type>", description: "Filter by CRM entity type" }) entityType?: string,
    @Option({ flags: "--entity <id>", description: "Filter by CRM entity id" }) entityId?: string,
    @Option({ flags: "--contact <contact>", description: "Filter by contact" }) contactRef?: string,
    @Option({ flags: "--account <account>", description: "Filter by CRM account" }) accountId?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Filter by CRM opportunity" }) opportunityId?: string,
    @Option({ flags: "--status <status>", description: "proposed|confirmed|rejected|superseded" }) status?: string,
    @Option({ flags: "--key <key>", description: "Filter by fact key" }) key?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 25, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching facts to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const page = listCrmFacts({
      entityType,
      entityId,
      contactRef,
      accountId,
      opportunityId,
      status,
      key,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "fact", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--entity-type",
        entityType,
        "--entity",
        entityId,
        "--contact",
        contactRef,
        "--account",
        accountId,
        "--opportunity",
        opportunityId,
        "--status",
        status,
        "--key",
        key,
      ],
    });
    const payload = { total: page.total, pagination, items: page.items, facts: page.items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM facts found.");
      return payload;
    }
    for (const fact of page.items) {
      console.log(`- ${fact.status.padEnd(10)} ${fact.entityType}:${fact.entityId} ${fact.key}`);
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "propose", description: "Propose or confirm a CRM fact" })
  propose(
    @Arg("entityType", { description: "CRM entity type" }) entityType: string,
    @Arg("entity", { description: "CRM entity id" }) entityId: string,
    @Arg("key", { description: "Fact key" }) key: string,
    @Arg("value", { description: "JSON value or plain string" }) value: string,
    @Option({ flags: "--contact <contact>", description: "Related contact" }) contactRef?: string,
    @Option({ flags: "--account <account>", description: "Related account" }) accountId?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Related opportunity" }) opportunityId?: string,
    @Option({ flags: "--status <status>", description: "proposed|confirmed" }) status?: string,
    @Option({ flags: "--confidence <n>", description: "Confidence between 0 and 1" }) confidence?: string,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated fact writes" })
    idempotencyKey?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const fact = proposeCrmFact({
      entityType,
      entityId,
      key,
      value: parseJsonValueArg(value),
      contactRef,
      accountId,
      opportunityId,
      status,
      confidence: parseOptionalNumber(confidence, "confidence") ?? undefined,
      idempotencyKey,
      source: "cli",
      actorType: "user",
    });
    const payload = { status: "proposed" as const, fact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM fact ${fact.status}: ${fact.id} ${fact.key}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "confirm", description: "Confirm a CRM fact" })
  confirm(
    @Arg("fact", { description: "CRM fact ID" }) factId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const fact = confirmCrmFact({ factId, source: "cli", actorType: "user" });
    const payload = { status: "confirmed" as const, fact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM fact confirmed: ${fact.id}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "reject", description: "Reject a CRM fact" })
  reject(
    @Arg("fact", { description: "CRM fact ID" }) factId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const fact = rejectCrmFact({ factId, source: "cli", actorType: "user" });
    const payload = { status: "rejected" as const, fact, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM fact rejected: ${fact.id}`);
    }
    return payload;
  }
}

@Group({
  name: "crm.task",
  description: "CRM task mutations",
})
export class CrmTaskCommands {
  @Scope("open")
  @Command({ name: "show", description: "Show CRM task" })
  show(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const task = getCrmTask(taskId);
    if (!task) fail(`CRM task not found: ${taskId}`);
    const payload = { target: taskId, task };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`\nCRM task: ${task.title}`);
    console.log(`  status: ${task.status}`);
    console.log(`  due: ${task.dueAt ?? "-"}`);
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "create", description: "Create a CRM relationship task" })
  create(
    @Arg("title", { description: "Task title" }) title: string,
    @Option({ flags: "--contact <contact>", description: "Contact ID or identity" }) contactRef?: string,
    @Option({ flags: "--account <account>", description: "CRM account ID" }) accountId?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "CRM opportunity ID" }) opportunityId?: string,
    @Option({ flags: "--due <date>", description: "Due date/time" }) dueAt?: string,
    @Option({ flags: "--priority <priority>", description: "low|normal|high|urgent" }) priority?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--task-type <type>", description: "Task type (e.g. follow_up, commitment, call)" })
    taskType?: string,
    @Option({ flags: "--body <text>", description: "Task body / longer description" }) body?: string,
    @Option({ flags: "--source <source>", description: "Source label (default: cli)" }) source?: string,
    @Option({ flags: "--confidence <n>", description: "Confidence in the task (0.0–1.0)" }) confidence?: string,
    @Option({ flags: "--evidence <json>", description: "Evidence JSON array attached to the task event" })
    evidenceJson?: string,
    @Option({ flags: "--metadata <json>", description: "Metadata JSON object stored on the task" })
    metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--idempotency-key <key>", description: "Deduplicate repeated task creation" })
    idempotencyKey?: string,
  ) {
    const evidence = parseOptionalJson(evidenceJson, "--evidence");
    const metadata = parseOptionalJsonObject(metadataJson, "--metadata");
    const confidenceValue = confidence !== undefined ? parseFloatOrFail(confidence, "--confidence") : undefined;
    const task = createCrmTask({
      title,
      contactRef,
      accountId,
      opportunityId,
      dueAt,
      priority,
      taskType,
      body,
      ...parseOwner(owner),
      idempotencyKey,
      source: source ?? "cli",
      actorType: "user",
      confidence: confidenceValue,
      evidence,
      metadata,
    });
    const payload = { status: "created" as const, task, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task created: ${task.id} ${task.title}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "done", description: "Complete a CRM task" })
  done(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const task = completeCrmTask({ taskId, source: "cli", actorType: "user" });
    const payload = { status: "done" as const, task, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task completed: ${task.id}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "cancel", description: "Cancel a CRM task" })
  cancel(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--reason <text>", description: "Reason for cancellation (stored in event payload)" })
    reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const task = cancelCrmTask({ taskId, reason, source: "cli", actorType: "user" });
    const payload = { status: "canceled" as const, task, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task canceled: ${task.id}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "snooze", description: "Snooze a CRM task to a new due_at" })
  snooze(
    @Arg("task", { description: "CRM task ID" }) taskId: string,
    @Option({ flags: "--until <ts>", description: "New due_at / snoozed_until (ISO timestamp)" }) until?: string,
    @Option({ flags: "--reason <text>", description: "Reason for snoozing" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!until) fail("--until <ts> is required");
    const task = snoozeCrmTask({
      taskId,
      snoozedUntil: until,
      source: "cli",
      actorType: "user",
      evidence: reason ? { reason } : undefined,
    });
    const payload = { status: "snoozed" as const, task, changedCount: 1 };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ CRM task snoozed until ${until}: ${task.id}`);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "list", description: "List CRM tasks (all statuses)" })
  list(
    @Option({ flags: "--owner <type:id>", description: "Filter by owner, e.g. agent:main" }) owner?: string,
    @Option({ flags: "--contact <contact>", description: "Filter by contact" }) contact?: string,
    @Option({ flags: "--account <account>", description: "Filter by account" }) account?: string,
    @Option({ flags: "--opportunity <opportunity>", description: "Filter by opportunity" }) opportunity?: string,
    @Option({ flags: "--task-type <type>", description: "Filter by task_type" }) taskType?: string,
    @Option({ flags: "--status <status>", description: "Filter by status (open, scheduled, done, canceled, snoozed)" })
    status?: string,
    @Option({ flags: "--due-today", description: "Only tasks whose due_at is today" }) dueToday?: boolean,
    @Option({ flags: "--due-before <ts>", description: "Only tasks with due_at < <ts>" }) dueBefore?: string,
    @Option({ flags: "--due-after <ts>", description: "Only tasks with due_at >= <ts>" }) dueAfter?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 25, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching tasks to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const ownerFilter = parseOwner(owner);
    const page = listCrmTasks({
      ...ownerFilter,
      contactRef: contact,
      accountId: account,
      opportunityId: opportunity,
      taskType,
      status,
      dueToday: Boolean(dueToday),
      dueBefore,
      dueAfter,
      limit,
      offset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "crm", "task", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: [
        "--owner",
        owner,
        "--contact",
        contact,
        "--account",
        account,
        "--opportunity",
        opportunity,
        "--task-type",
        taskType,
        "--status",
        status,
        ...(dueToday ? ["--due-today"] : []),
        "--due-before",
        dueBefore,
        "--due-after",
        dueAfter,
      ],
    });
    const payload = { total: page.total, pagination, items: page.items, tasks: page.items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (page.items.length === 0) {
      console.log("No CRM tasks match the filter.");
      return payload;
    }
    console.log(`\nCRM tasks (${page.items.length} returned of ${page.total}):\n`);
    for (const task of page.items) {
      console.log(
        `  ${task.id}  [${task.status}]  ${task.taskType.padEnd(12)}  due=${task.dueAt ?? "-"}  ${task.title}`,
      );
    }
    if (pagination.nextCommand) console.log(`\nNext page:\n  ${pagination.nextCommand}`);
    return payload;
  }
}

function parseOptionalJson(value: string | undefined, label: string): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    fail(`${label} must be valid JSON: ${(error as Error).message}`);
  }
}

function parseOptionalJsonObject(value: string | undefined, label: string): Record<string, unknown> | undefined {
  const parsed = parseOptionalJson(value, label);
  if (parsed === undefined) return undefined;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseFloatOrFail(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be a number`);
  return parsed;
}
