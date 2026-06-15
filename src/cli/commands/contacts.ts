/**
 * Contacts Commands - Contact management CLI (v2 with identities)
 */

import "reflect-metadata";
import { Group, Command, CommandAccess, Scope, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import { commandEnvelopeReturnSchema, declareCommandReturns } from "./operational-return-schemas.js";
import { nats } from "../../nats.js";

/** Notify gateway that config changed */
function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}
import {
  getAllContacts,
  getContact,
  getPendingContacts,
  upsertContact,
  deleteContact,
  allowContact,
  blockContact,
  normalizePhone,
  formatPhone,
  setContactReplyMode,
  updateContact,
  findContactsByTag,
  searchContacts,
  addContactTag,
  removeContactTag,
  setOptOut,
  linkContactIdentity,
  unlinkContactIdentity,
  mergeContacts,
  getContactDetails,
  listContactEvents,
  addContactNote,
  listContactMetadata,
  setContactMetadata,
  removeContactMetadata,
  setContactKind,
  listDuplicateContacts,
  getCrmContactProfile,
  backfillInboundContacts,
  type Contact,
  type ContactContextEntry,
  type ContactDetails,
  type ContactEvent,
  type ContactEventScopeType,
  type ContactStatus,
  type ReplyMode,
  type ContactSource,
  listAccountPending,
  listAccountPendingContacts,
  listAccountPendingChats,
} from "../../contacts.js";
import { dbListMessageMetaByContactId, dbListRoutes, type MessageMetadata } from "../../router/router-db.js";
import { findSessionByChatId } from "../../router/sessions.js";
import {
  listContactSessionSummaries,
  listSessionEventsByContactId,
  type ContactSessionSummary,
} from "../../session-trace/session-trace-db.js";
import type { SessionEventRecord } from "../../session-trace/types.js";
import { getScopeContext, isScopeEnforced, canAccessContact, canWriteContacts } from "../../permissions/scope.js";
import { printInspectionBlock, printInspectionField } from "../inspection-output.js";

const CONTACT_DB_META = { source: "contact-db", freshness: "persisted" } as const;
const CONTACT_TAGS_META = {
  source: "contact-db",
  freshness: "persisted",
  via: "tag-bindings+contact_policies",
} as const;
const ROUTE_RESOLVER_META = { source: "resolver", freshness: "derived-now", via: "route-lookup" } as const;
const SESSION_LOOKUP_META = { source: "session-db", freshness: "derived-now", via: "identity-lookup" } as const;

function statusIcon(status: ContactStatus): string {
  switch (status) {
    case "allowed":
      return "\x1b[32m✓\x1b[0m";
    case "pending":
      return "\x1b[33m?\x1b[0m";
    case "blocked":
      return "\x1b[31m✗\x1b[0m";
    case "discovered":
      return "\x1b[36m○\x1b[0m";
  }
}

function statusText(status: ContactStatus): string {
  switch (status) {
    case "allowed":
      return "\x1b[32mallowed\x1b[0m";
    case "pending":
      return "\x1b[33mpending\x1b[0m";
    case "blocked":
      return "\x1b[31mblocked\x1b[0m";
    case "discovered":
      return "\x1b[36mdiscovered\x1b[0m";
  }
}

/** Cached routes for batch lookups (reset per CLI invocation) */
let _cachedRoutes: ReturnType<typeof dbListRoutes> | null = null;

/** Lookup agent from routes table by checking all contact identities (searches all accounts) */
function getRouteAgent(contact: Contact): string | null {
  if (!_cachedRoutes) _cachedRoutes = dbListRoutes();
  for (const id of contact.identities) {
    const val = id.value.toLowerCase();
    const match = _cachedRoutes.find((r) => r.pattern === val);
    if (match) return match.agent;
  }
  return null;
}

/** Lookup session name by checking all contact identities */
function getSessionName(contact: Contact): string | null {
  for (const id of contact.identities) {
    const session = findSessionByChatId(id.value);
    if (session?.name) return session.name;
  }
  return null;
}

function platformIcon(platform: string): string {
  switch (platform) {
    case "phone":
      return "📱";
    case "whatsapp":
      return "🆔";
    case "whatsapp_group":
      return "👥";
    case "email":
      return "✉";
    case "matrix":
      return "🔗";
    case "telegram":
      return "✈️";
    default:
      return "•";
  }
}

function formatIdentities(contact: Contact): string {
  if (contact.identities.length === 0) return "-";
  return contact.identities
    .map((i) => `${platformIcon(i.platform)} ${formatIdentityValue(i.platform, i.value)}`)
    .join(" | ");
}

function formatIdentitiesShort(contact: Contact, maxLen = 40): string {
  const full = formatIdentities(contact);
  if (full.length <= maxLen) return full;
  return full.slice(0, maxLen - 1) + "…";
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function formatIdentityValue(platform: string, value: string): string {
  if (platform === "phone" || platform === "whatsapp" || platform === "whatsapp_group") {
    return formatPhone(value);
  }
  return value;
}

function serializeContact(contact: Contact, options: { includeDuplicateCandidates?: boolean } = {}) {
  const includeDuplicateCandidates = options.includeDuplicateCandidates === true;
  const details = getContactDetails(contact.id, { includeDuplicateCandidates });
  return {
    ...contact,
    contact: details?.contact ?? null,
    platformIdentities: details?.platformIdentities ?? [],
    policy: details?.policy ?? null,
    duplicateCandidates: includeDuplicateCandidates ? (details?.duplicateCandidates ?? []) : [],
    routeAgent: getRouteAgent(contact),
    sessionName: getSessionName(contact),
  };
}

function serializeContactMaybe(contact: Contact | null) {
  return contact ? serializeContact(contact) : null;
}

function isChatIdentityValue(value: string): boolean {
  return normalizePhone(value).startsWith("group:");
}

function isChatCompatibilityContact(contact: Contact): boolean {
  return (
    contact.identities.length > 0 &&
    contact.identities.every(
      (identity) => identity.platform === "whatsapp_group" || isChatIdentityValue(identity.value),
    )
  );
}

function failIfChatContact(contactRef: string, contact?: Contact | null): void {
  if (isChatIdentityValue(contactRef) || (contact && isChatCompatibilityContact(contact))) {
    fail(
      "Groups/chats are not contacts. Use 'ravi instances pending approve <instance> <chat> --agent <agent>' or add a route.",
    );
  }
}

function getUpdatedContact(contact: Contact): Contact {
  return getContact(contact.id) ?? getContact(contact.phone) ?? contact;
}

function parseAgentIds(agentIds?: string): string[] | null {
  if (!agentIds) return null;
  return agentIds
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

function parseScopeOption(scope?: string): { scopeType?: ContactEventScopeType; scopeId?: string } {
  const raw = scope?.trim();
  if (!raw) return {};
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail("--scope must use <type:id>, e.g. chat:chat_123 or project:ravi-web");
  }
  return {
    scopeType: raw.slice(0, separator) as ContactEventScopeType,
    scopeId: raw.slice(separator + 1),
  };
}

function parseOwnerOption(owner?: string): { ownerType?: string; ownerId?: string } {
  const raw = owner?.trim();
  if (!raw) return {};
  const separator = raw.indexOf(":");
  if (separator <= 0 || separator === raw.length - 1) {
    fail("Owner must use <type:id>, e.g. agent:ravi-crm or system:ravi");
  }
  return {
    ownerType: raw.slice(0, separator),
    ownerId: raw.slice(separator + 1),
  };
}

function parseJsonArgument(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    fail(`Invalid JSON value: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function formatContactEventScope(event: Pick<ContactEvent, "scopeType" | "scopeId">): string {
  return event.scopeType === "global" ? "global" : `${event.scopeType}:${event.scopeId ?? "-"}`;
}

function serializeContactEvent(event: ContactEvent) {
  return event;
}

function serializeContactContextEntry(entry: ContactContextEntry) {
  return entry;
}

function serializeContactMessage(message: MessageMetadata) {
  return message;
}

function serializeContactActivityEvent(event: SessionEventRecord) {
  return event;
}

function serializeContactSessionSummary(summary: ContactSessionSummary) {
  return summary;
}

function formatMillis(value: number | null | undefined): string {
  if (value == null) return "-";
  return new Date(value).toISOString();
}

function resolveContactDetailsOrFail(
  contactRef: string,
  options: { includeDuplicateCandidates?: boolean } = {},
): ContactDetails {
  const details = getContactDetails(contactRef, options);
  if (!details) fail(`Contact not found: ${contactRef}`);
  return details!;
}

function metadataValue(
  entries: ContactContextEntry[],
  key: string,
  scopeType = "global",
  scopeId: string | null = null,
) {
  return entries.find((entry) => entry.key === key && entry.scopeType === scopeType && entry.scopeId === scopeId)
    ?.value;
}

function summarizeContacts(contacts: Contact[]) {
  return {
    total: contacts.length,
    allowed: contacts.filter((c) => c.status === "allowed").length,
    pending: contacts.filter((c) => c.status === "pending").length,
    blocked: contacts.filter((c) => c.status === "blocked").length,
    discovered: contacts.filter((c) => c.status === "discovered").length,
  };
}

function canReadContactRecord(scopeCtx: ReturnType<typeof getScopeContext>, contact: Contact): boolean {
  const contactAgent = getRouteAgent(contact);
  const contactSessions = contactAgent ? [{ agentId: contactAgent }] : [];
  return canAccessContact(scopeCtx, contact, null, contactSessions);
}

function canReadCanonicalContact(
  scopeCtx: ReturnType<typeof getScopeContext>,
  contactId: string,
  tags: string[] = [],
): boolean {
  const contact = getContact(contactId);
  if (contact) return canReadContactRecord(scopeCtx, contact);
  return canAccessContact(scopeCtx, { id: contactId, tags }, null, []);
}

function canReadContactDetails(scopeCtx: ReturnType<typeof getScopeContext>, details: ContactDetails): boolean {
  return canReadCanonicalContact(scopeCtx, details.contact.id, details.policy?.tags ?? []);
}

function filterVisibleContacts<T extends Contact>(contacts: T[]): T[] {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return contacts;
  return contacts.filter((contact) => canReadContactRecord(scopeCtx, contact));
}

function getVisibleContactDetails(
  contactRef: string,
  options: { includeDuplicateCandidates?: boolean } = {},
): { contact: Contact | null; details: ContactDetails | null } {
  const details = getContactDetails(contactRef, options);
  const contact = getContact(contactRef);
  if (!contact && !details) return { contact: null, details: null };

  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return { contact, details };

  if (contact && canReadContactRecord(scopeCtx, contact)) return { contact, details };
  if (details && canReadContactDetails(scopeCtx, details)) return { contact, details };
  return { contact: null, details: null };
}

function assertCanReadContact(contactRef: string): void {
  const visible = getVisibleContactDetails(contactRef);
  if (visible.contact || visible.details) return;
  fail(`Contact not found: ${contactRef}`);
}

function assertCanReadContactTimeline(contactRef: string): void {
  assertCanReadContact(contactRef);
}

function canViewPendingAccountEntry(entry: { phone: string; pendingKind?: string }): boolean {
  const scopeCtx = getScopeContext();
  if (!isScopeEnforced(scopeCtx)) return true;
  if (entry.pendingKind === "chat") return canWriteContacts(scopeCtx);
  const contact = getContact(entry.phone);
  return contact ? canReadContactRecord(scopeCtx, contact) : canWriteContacts(scopeCtx);
}

@Group({
  name: "contacts",
  description: "Contact management",
})
export class ContactsCommands {
  @Scope("open")
  @Command({ name: "list", description: "List all contacts" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "list", risk: "low" })
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) filterStatus?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching contacts to skip (default: 0)" }) offset?: string,
  ) {
    let contacts = filterStatus ? getAllContacts().filter((c) => c.status === filterStatus) : getAllContacts();
    contacts = filterVisibleContacts(contacts);

    const page = paginateCliItems(contacts, { limit, offset });
    const pageContacts = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "contacts", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageContacts.length,
      total: page.total,
      options: ["--status", filterStatus],
    });

    const payload = {
      filter: { status: filterStatus ?? null },
      counts: summarizeContacts(contacts),
      total: page.total,
      pagination,
      items: pageContacts.map((contact) => serializeContact(contact)),
      contacts: pageContacts.map((contact) => serializeContact(contact)),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (pageContacts.length === 0) {
      console.log("No contacts registered.");
      console.log("\nAdd a contact: ravi contacts add <phone> [name]");
      return payload;
    }

    console.log("\nContacts:\n");
    console.log("  ST  ID          NAME                  AGENT           SESSION              IDENTITIES");
    console.log(
      "  --  ----------  --------------------  --------------  -------------------  ---------------------------",
    );
    for (const contact of pageContacts) {
      const icon = statusIcon(contact.status);
      const id = contact.id.padEnd(10);
      const name = (contact.name || "-").slice(0, 20).padEnd(20);
      const agent = (getRouteAgent(contact) || "-").padEnd(14);
      const session = (getSessionName(contact) || "-").padEnd(19);
      const identities = formatIdentitiesShort(contact, 50);
      console.log(`  ${icon}   ${id}  ${name}  ${agent}  ${session}  ${identities}`);
    }
    const allowed = contacts.filter((c) => c.status === "allowed").length;
    const pending = contacts.filter((c) => c.status === "pending").length;
    const blocked = contacts.filter((c) => c.status === "blocked").length;
    const discovered = contacts.filter((c) => c.status === "discovered").length;
    console.log(
      `\n  Total: ${contacts.length} (${pageContacts.length} returned, limit ${page.limit}, offset ${page.offset}; ${allowed} allowed, ${pending} pending, ${blocked} blocked, ${discovered} discovered)`,
    );
    if (pagination.nextCommand) {
      console.log("\n  Next page:");
      console.log(`    ${pagination.nextCommand}`);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "pending", description: "List pending contacts" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "pending", risk: "low" })
  pending(
    @Option({ flags: "-a, --account <id>", description: "Filter by account" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    // Global pending contacts
    const contacts = filterVisibleContacts(getPendingContacts());
    const accountPendingContacts = listAccountPendingContacts(account).filter(canViewPendingAccountEntry);
    const pendingChats = listAccountPendingChats(account).filter(canViewPendingAccountEntry);
    const accountPending = listAccountPending(account).filter(canViewPendingAccountEntry);

    const payload = {
      filter: { account: account ?? null },
      total: contacts.length + accountPendingContacts.length,
      totalContacts: contacts.length + accountPendingContacts.length,
      totalChats: pendingChats.length,
      pendingContacts: contacts.map((contact) => serializeContact(contact)),
      accountPendingContacts: accountPendingContacts.map((entry) => ({
        ...entry,
        type: entry.chatType,
        contact: serializeContactMaybe(getContact(entry.phone)),
      })),
      pendingChats: pendingChats.map((entry) => ({
        ...entry,
        type: entry.chatType,
        contact: null,
      })),
      accountPending: accountPending.map((entry) => ({
        ...entry,
        type: entry.chatType,
        contact: entry.pendingKind === "contact" ? serializeContactMaybe(getContact(entry.phone)) : null,
      })),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (contacts.length > 0) {
      console.log(`\nPending contacts (${contacts.length}):\n`);
      console.log("  ID          NAME                 IDENTITIES                          SINCE");
      console.log("  ----------  ----------------     ---------------------------------   ----------");
      for (const contact of contacts) {
        const id = contact.id.padEnd(10);
        const name = (contact.name || "-").padEnd(16);
        const identities = formatIdentitiesShort(contact, 35).padEnd(35);
        const since = contact.created_at.split(" ")[0];
        console.log(`  ${id}  ${name}     ${identities}   ${since}`);
      }
      console.log("\nApprove: ravi contacts approve <id>");
      console.log("Block:   ravi contacts block <id>");
    }

    // Per-account pending contacts (DMs on accounts without matching routes)
    if (accountPendingContacts.length > 0) {
      console.log(`\nAccount pending contacts (${accountPendingContacts.length}):\n`);
      console.log("  ACCOUNT       NAME                  IDENTITIES                          SINCE");
      console.log("  ------------  --------------------  ---------------------------------   ----------");
      for (const entry of accountPendingContacts) {
        const acct = entry.accountId.padEnd(12);
        const contact = getContact(entry.phone);
        const name = (contact?.name || entry.name || "-").slice(0, 20).padEnd(20);
        const identities = contact
          ? formatIdentitiesShort(contact, 35).padEnd(35)
          : `phone ${entry.phone}`.slice(0, 35).padEnd(35);
        const since = new Date(entry.updatedAt).toISOString().split("T")[0];
        console.log(`  ${acct}  ${name}  ${identities}   ${since}`);
      }
      console.log("\nApprove: ravi instances pending approve <instance> <phone>");
      console.log("Add route: ravi instances routes add <instance> <pattern> <agent>");
    }

    if (pendingChats.length > 0) {
      console.log(`\nPending chats (${pendingChats.length}):\n`);
      console.log("  ACCOUNT       TYPE    NAME                  CHAT/PATTERN                       SINCE");
      console.log("  ------------  ------  --------------------  ---------------------------------  ----------");
      for (const entry of pendingChats) {
        const acct = entry.accountId.padEnd(12);
        const type = entry.chatType.padEnd(6);
        const name = (entry.name || "-").slice(0, 20).padEnd(20);
        const chat = (entry.chatId || entry.phone).slice(0, 33).padEnd(33);
        const since = new Date(entry.updatedAt).toISOString().split("T")[0];
        console.log(`  ${acct}  ${type}  ${name}  ${chat}  ${since}`);
      }
      console.log("\nApprove chat route: ravi instances pending approve <instance> <chat> --agent <agent>");
      console.log("Add route:           ravi instances routes add <instance> <pattern> <agent>");
    }

    if (contacts.length === 0 && accountPendingContacts.length === 0 && pendingChats.length === 0) {
      console.log("No pending contacts or chats.");
    }
    return payload;
  }

  @Scope("admin")
  @Command({
    name: "backfill",
    aliases: ["intake-backfill"],
    description: "Backfill canonical contacts from captured chats",
  })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "backfill", risk: "medium" })
  backfill(
    @Option({ flags: "--instance <id>", description: "Limit to one channel instance/account" }) instanceId?: string,
    @Option({ flags: "--channel <channel>", description: "Limit to one channel, e.g. whatsapp" }) channel?: string,
    @Option({ flags: "--mode <mode>", description: "Contact intake status: pending|discovered (default: pending)" })
    mode?: string,
    @Option({ flags: "--limit <n>", description: "Maximum candidates to inspect/apply" }) limit?: string,
    @Option({ flags: "--apply", description: "Write canonical contacts and actor links. Without this, runs dry-run." })
    apply?: boolean,
    @Option({ flags: "--dry-run", description: "Force preview mode even if --apply is present" }) dryRun?: boolean,
    @Option({ flags: "--create-list <name>", description: "When applying, add linked chats to this reading list" })
    createList?: string,
    @Option({ flags: "--list-owner <type:id>", description: "Owner for --create-list (default: agent:ravi-crm)" })
    listOwner?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (mode && mode !== "pending" && mode !== "discovered") {
      fail("--mode must be pending or discovered");
    }
    if (apply && dryRun) {
      fail("Use either --apply or --dry-run, not both");
    }
    const owner = parseOwnerOption(listOwner);
    const result = backfillInboundContacts({
      instanceId,
      channel,
      mode: (mode as "pending" | "discovered" | undefined) ?? "pending",
      limit,
      apply: apply === true,
      createReadingList: createList,
      readingListOwnerType: owner.ownerType,
      readingListOwnerId: owner.ownerId,
    });

    const payload = {
      action: "contacts.backfill",
      ...result,
      nextCommand: result.dryRun
        ? [
            "ravi",
            "contacts",
            "backfill",
            instanceId ? `--instance ${instanceId}` : null,
            channel ? `--channel ${channel}` : null,
            `--mode ${result.mode}`,
            createList ? `--create-list ${createList}` : null,
            listOwner ? `--list-owner ${listOwner}` : null,
            "--apply",
          ]
            .filter(Boolean)
            .join(" ")
        : null,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }

    const title = result.dryRun ? "Contact backfill dry-run" : "Contact backfill applied";
    console.log(`\n${title}`);
    console.log(`  Mode: ${result.mode}`);
    console.log(`  Filter: instance=${result.filter.instanceId ?? "*"} channel=${result.filter.channel ?? "*"}`);
    console.log(`  Candidates: ${result.totals.candidates}`);
    console.log(`  Eligible: ${result.totals.eligible}`);
    console.log(`  Skipped: ${result.totals.skipped}`);
    if (result.applied) {
      console.log(`  Contacts created: ${result.totals.contactsCreated}`);
      console.log(`  Contacts linked/existing: ${result.totals.contactsLinked}`);
      console.log(`  Platform identities created: ${result.totals.platformIdentitiesCreated}`);
      console.log(`  Messages linked: ${result.totals.messagesUpdated}`);
      console.log(`  Participants linked: ${result.totals.participantsUpdated}`);
      if (result.readingList.id) {
        console.log(
          `  Reading list: ${result.readingList.requestedName} (${result.totals.readingListMembersAdded} chats added)`,
        );
      }
    } else {
      console.log("\nApply:");
      console.log(`  ${payload.nextCommand}`);
    }

    const preview = result.items.slice(0, 10);
    if (preview.length > 0) {
      console.log("\nPreview:");
      for (const item of preview) {
        const status = item.skipReason ? `skipped:${item.skipReason}` : item.action;
        console.log(
          `  - ${status} ${item.instanceId}/${item.channel} ${item.contactIdentity} chat=${item.chatId ?? "-"}`,
        );
      }
      if (result.items.length > preview.length) {
        console.log(`  ... ${result.items.length - preview.length} more`);
      }
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "add", description: "Add/allow a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "add", risk: "medium" })
  add(
    @Arg("identity", { description: "Phone number or WhatsApp identity" }) identity: string,
    @Arg("name", { required: false, description: "Contact name" }) name?: string,
    @Option({ flags: "--agent <ids>", description: "Restrict to agent(s), comma-separated" }) agentIds?: string,
    @Option({ flags: "--kind <kind>", description: "Contact kind: person or org" }) kind?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalized = normalizePhone(identity);
    if (!normalized) {
      fail("Identity must be a phone number or WhatsApp identity. Use 'ravi contacts link' for explicit platform ids.");
    }
    if (normalized.startsWith("group:")) {
      fail("Groups/chats are not contacts. Use chat or route review surfaces for group identities.");
    }
    if (kind && kind !== "person" && kind !== "org") {
      fail("Kind must be 'person' or 'org'");
    }
    upsertContact(normalized, name ?? null, "allowed", "manual");
    const contact = getContact(normalized);
    if (contact && agentIds) {
      const agents = parseAgentIds(agentIds) ?? [];
      updateContact(contact.id, { allowedAgents: agents });
    }
    if (contact && kind) {
      setContactKind(contact.id, kind as "person" | "org");
    }
    const updated = contact ? getUpdatedContact(contact) : getContact(normalized);
    const payload = {
      status: "added" as const,
      target: identity,
      normalized,
      kind: kind ?? "person",
      contact: serializeContactMaybe(updated),
      allowedAgents: parseAgentIds(agentIds),
      changedCount: updated ? 1 : 0,
    };
    if (asJson) {
      printJson(payload);
    } else {
      const agentLabel = agentIds ? ` [agents: ${agentIds}]` : "";
      console.log(
        `✓ Contact added: ${contact?.id ?? normalized}${name ? ` (${name})` : ""} — ${formatPhone(normalized)}${agentLabel}`,
      );
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "approve", description: "Approve pending contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "approve", risk: "medium" })
  approve(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("mode", { required: false, description: "Reply mode (auto|mention)" })
    replyMode?: string,
    @Option({ flags: "--agent <ids>", description: "Restrict to agent(s), comma-separated" }) agentIds?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (replyMode && replyMode !== "auto" && replyMode !== "mention") {
      fail("Reply mode must be 'auto' or 'mention'");
    }
    failIfChatContact(contactRef);

    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }
    failIfChatContact(contactRef, contact);

    allowContact(contact.phone);
    if (replyMode) {
      setContactReplyMode(contact.phone, replyMode as ReplyMode);
    }
    if (agentIds) {
      const agents = parseAgentIds(agentIds) ?? [];
      updateContact(contact.id, { allowedAgents: agents });
    }
    emitConfigChanged();

    const updated = getUpdatedContact(contact);
    const payload = {
      status: "approved" as const,
      target: contactRef,
      contact: serializeContact(updated),
      replyMode: replyMode ?? null,
      allowedAgents: parseAgentIds(agentIds),
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      const modeInfo = replyMode ? ` (${replyMode})` : "";
      const agentLabel = agentIds ? ` [agents: ${agentIds}]` : "";
      console.log(
        `✓ Contact approved: ${contact.id}${contact.name ? ` (${contact.name})` : ""}${modeInfo}${agentLabel}`,
      );
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "remove", description: "Remove a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "remove", risk: "destructive" })
  remove(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const deleted = deleteContact(contactRef);
    const payload = {
      status: deleted ? ("removed" as const) : ("not_found" as const),
      target: contactRef,
      changedCount: deleted ? 1 : 0,
    };
    if (asJson) {
      printJson(payload);
    } else if (deleted) {
      console.log(`✓ Contact removed: ${contactRef}`);
    } else {
      console.log(`Contact not found: ${contactRef}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "allow", description: "Allow a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "allow", risk: "medium" })
  allow(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    failIfChatContact(contactRef);
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }
    failIfChatContact(contactRef, contact);
    allowContact(contact.phone);
    const updated = getUpdatedContact(contact);
    const payload = {
      status: "allowed" as const,
      target: contactRef,
      contact: serializeContact(updated),
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Contact allowed: ${contact.id} (${contact.name || formatPhone(contact.phone)})`);
    }
    emitConfigChanged();
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "block", description: "Block a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "block", risk: "destructive" })
  block(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    failIfChatContact(contactRef);
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }
    failIfChatContact(contactRef, contact);
    blockContact(contact.phone);
    const updated = getUpdatedContact(contact);
    const payload = {
      status: "blocked" as const,
      target: contactRef,
      contact: serializeContact(updated),
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✗ Contact blocked: ${contact.id} (${contact.name || formatPhone(contact.phone)})`);
    }
    emitConfigChanged();
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set contact property" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "set", risk: "medium" })
  set(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("key", { description: "Property key" }) key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    let jsonValue: unknown = value;

    if (key === "agent") {
      fail("agent is no longer set on contacts. Use 'ravi instances routes add <instance> <pattern> <agent>' instead.");
    } else if (key === "mode") {
      if (value !== "auto" && value !== "mention") {
        fail("Mode must be 'auto' or 'mention'");
      }
      setContactReplyMode(contact.phone, value as ReplyMode);
      if (!asJson) console.log(`✓ Mode set: ${contact.id} → ${value}`);
    } else if (key === "email") {
      jsonValue = value === "-" ? null : value;
      updateContact(contact.id, { email: jsonValue as string | null });
      if (!asJson) console.log(`✓ Email set: ${contact.id} → ${value}`);
    } else if (key === "name") {
      jsonValue = value === "-" ? null : value;
      updateContact(contact.id, { name: jsonValue as string | null });
      if (!asJson) console.log(`✓ Name set: ${contact.id} → ${value}`);
    } else if (key === "tags") {
      try {
        const tags = JSON.parse(value);
        if (!Array.isArray(tags)) fail("Tags must be a JSON array");
        jsonValue = tags;
        updateContact(contact.id, { tags });
        if (!asJson) console.log(`✓ Tags set: ${contact.id} → ${value}`);
      } catch {
        fail('Tags must be a valid JSON array, e.g. \'["lead","vip"]\'');
      }
    } else if (key === "notes") {
      try {
        const notes = JSON.parse(value);
        if (typeof notes !== "object" || Array.isArray(notes)) fail("Notes must be a JSON object");
        jsonValue = notes;
        updateContact(contact.id, { notes });
        if (!asJson) console.log(`✓ Notes set: ${contact.id}`);
      } catch {
        fail('Notes must be a valid JSON object, e.g. \'{"empresa":"Acme"}\'');
      }
    } else if (key === "opt-out" || key === "optout") {
      const boolValue = value === "true" || value === "yes" || value === "1";
      jsonValue = boolValue;
      setOptOut(contact.phone, boolValue);
      if (!asJson) console.log(`✓ Opt-out set: ${contact.id} → ${boolValue ? "yes" : "no"}`);
    } else if (key === "source") {
      const validSources = ["inbound", "outbound", "manual", "discovered"];
      if (value !== "-" && !validSources.includes(value)) {
        fail(`Source must be one of: ${validSources.join(", ")} (or '-' to clear)`);
      }
      jsonValue = value === "-" ? null : (value as ContactSource);
      updateContact(contact.id, { source: jsonValue as ContactSource | null });
      if (!asJson) console.log(`✓ Source set: ${contact.id} → ${value}`);
    } else if (key === "allowed-agents") {
      if (value === "-" || value === "null") {
        jsonValue = null;
        updateContact(contact.id, { allowedAgents: null });
        if (!asJson) console.log(`✓ Allowed agents cleared: ${contact.id} → (all)`);
      } else {
        try {
          const agents = JSON.parse(value);
          if (!Array.isArray(agents) || !agents.every((a: unknown) => typeof a === "string")) {
            fail("allowed-agents must be a JSON array of strings");
          }
          jsonValue = agents;
          updateContact(contact.id, { allowedAgents: agents });
          if (!asJson) console.log(`✓ Allowed agents set: ${contact.id} → ${agents.join(", ")}`);
        } catch {
          fail("allowed-agents must be a valid JSON array, e.g. '[\"main\",\"sentinel\"]' (or '-' to clear)");
        }
      }
    } else {
      fail(`Unknown key: ${key}. Keys: agent, mode, email, name, tags, notes, opt-out, source, allowed-agents`);
    }

    const payload = {
      status: "updated" as const,
      target: contactRef,
      key,
      value: jsonValue,
      contact: serializeContact(getUpdatedContact(contact)),
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "get", description: "Show canonical contact details", aliases: ["show"] })
  @CommandAccess({ kind: "read", resource: "contacts", action: "get", risk: "low" })
  get(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const { details, contact } = getVisibleContactDetails(contactRef, { includeDuplicateCandidates: true });

    if (!contact && !details) {
      const payload = { found: false as const, target: contactRef, contact: null };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`\nContact not found: ${contactRef}`);
      }
      return payload;
    }

    const payload = {
      found: true as const,
      target: contactRef,
      contact: details?.contact ?? null,
      platformIdentities: details?.platformIdentities ?? [],
      policy: details?.policy ?? null,
      duplicateCandidates: details?.duplicateCandidates ?? [],
      routeAgent: contact ? getRouteAgent(contact) : null,
      sessionName: contact ? getSessionName(contact) : null,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (!contact && details) {
      console.log(`\nContact: ${details.contact.id}`);
      printInspectionField("Name", details.contact.displayName || "-", CONTACT_DB_META, { labelWidth: 15 });
      printInspectionField("Kind", details.contact.kind, CONTACT_DB_META, { labelWidth: 15 });
      printInspectionField("Email", details.contact.primaryEmail || "-", CONTACT_DB_META, { labelWidth: 15 });
      printInspectionBlock(
        `Platform identities (${details.platformIdentities.length})`,
        CONTACT_DB_META,
        details.platformIdentities.length > 0
          ? details.platformIdentities.map((id) => {
              const primary = id.isPrimary ? " ★" : "";
              return `${platformIcon(id.channel)} ${id.channel.padEnd(16)} ${formatIdentityValue(
                id.channel,
                id.normalizedPlatformUserId,
              )}${primary}`;
            })
          : "(none)",
        { labelWidth: 15 },
      );
      return payload;
    }

    if (!contact) return payload;
    console.log(`\nContact: ${contact.id}`);
    printInspectionField("Name", contact.name || "-", CONTACT_DB_META, { labelWidth: 15 });
    printInspectionField("Email", contact.email || "-", CONTACT_DB_META, { labelWidth: 15 });
    printInspectionField("Status", statusText(contact.status), CONTACT_DB_META, { labelWidth: 15 });
    printInspectionField(
      "Allowed",
      contact.allowedAgents?.length ? contact.allowedAgents.join(", ") : "(all)",
      CONTACT_DB_META,
      { labelWidth: 15 },
    );
    printInspectionField("Agent", getRouteAgent(contact) || "-", ROUTE_RESOLVER_META, { labelWidth: 15 });
    printInspectionField("Session", getSessionName(contact) || "-", SESSION_LOOKUP_META, { labelWidth: 15 });
    printInspectionField("Mode", contact.reply_mode || "auto", CONTACT_DB_META, { labelWidth: 15 });
    printInspectionField("Tags", contact.tags.length > 0 ? contact.tags.join(", ") : "-", CONTACT_TAGS_META, {
      labelWidth: 15,
    });
    printInspectionField(
      "Notes",
      Object.keys(contact.notes).length > 0 ? JSON.stringify(contact.notes) : "-",
      CONTACT_DB_META,
      { labelWidth: 15 },
    );
    printInspectionField("Opt-out", contact.opt_out ? "yes" : "no", CONTACT_DB_META, { labelWidth: 15 });
    printInspectionField("Source", contact.source || "-", CONTACT_DB_META, { labelWidth: 15 });
    printInspectionField("Interactions", contact.interaction_count, CONTACT_DB_META, { labelWidth: 15 });
    if (contact.last_inbound_at) {
      printInspectionField("Last inbound", contact.last_inbound_at, CONTACT_DB_META, { labelWidth: 15 });
    }
    if (contact.last_outbound_at) {
      printInspectionField("Last outbound", contact.last_outbound_at, CONTACT_DB_META, { labelWidth: 15 });
    }
    printInspectionField("Created", contact.created_at, CONTACT_DB_META, { labelWidth: 15 });
    printInspectionField("Updated", contact.updated_at, CONTACT_DB_META, { labelWidth: 15 });
    printInspectionBlock(
      `Identities (${contact.identities.length})`,
      CONTACT_DB_META,
      contact.identities.length > 0
        ? contact.identities.map((id) => {
            const primary = id.isPrimary ? " ★" : "";
            return `${platformIcon(id.platform)} ${id.platform.padEnd(16)} ${formatIdentityValue(
              id.platform,
              id.value,
            )}${primary}`;
          })
        : "(none)",
      { labelWidth: 15 },
    );
    return payload;
  }

  @Scope("open")
  @Command({ name: "info", description: "Show contact details with all identities" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "info", risk: "low" })
  info(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.get(contactRef, asJson);
  }

  @Scope("open")
  @Command({ name: "check", description: "Check contact status (alias for info)" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "check", risk: "low" })
  check(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.get(contactRef, asJson);
  }

  @Scope("open")
  @Command({ name: "timeline", description: "Show contact timeline events" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "timeline", risk: "low" })
  timeline(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching events to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--scope <type:id>", description: "Filter by scoped context" }) scope?: string,
    @Option({ flags: "--event <type>", description: "Filter by event type" }) eventType?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const scopeFilter = parseScopeOption(scope);
    try {
      assertCanReadContactTimeline(contactRef);
      const pageLimit = parseCliListLimit(limit);
      const pageOffset = parseCliListOffset(offset);
      const page = listContactEvents(contactRef, {
        limit: pageLimit,
        offset: pageOffset,
        ...scopeFilter,
        eventType: eventType?.trim() || null,
      });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "contacts", "timeline", contactRef],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: ["--scope", scope?.trim() || null, "--event", eventType?.trim() || null],
      });
      const payload = {
        contactId: page.contactId,
        target: contactRef,
        total: page.total,
        pagination,
        items: page.items.map(serializeContactEvent),
        events: page.items.map(serializeContactEvent),
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (page.items.length === 0) {
        console.log(`No timeline events found for: ${contactRef}`);
        return payload;
      }
      console.log(
        `\nContact timeline (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
      );
      for (const event of page.items) {
        console.log(`- ${event.createdAt} :: ${event.eventType} :: ${formatContactEventScope(event)}`);
        if (event.source) console.log(`  source: ${event.source}`);
        if (event.payload !== null) console.log(`  payload: ${JSON.stringify(event.payload)}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("open")
  @Command({ name: "messages", description: "Show messages attributed to a contact" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "messages", risk: "low" })
  messages(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching messages to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertCanReadContactTimeline(contactRef);
      const details = resolveContactDetailsOrFail(contactRef);
      const page = dbListMessageMetaByContactId(details.contact.id, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "contacts", "messages", contactRef],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
      });
      const payload = {
        target: contactRef,
        contactId: details.contact.id,
        total: page.total,
        pagination,
        items: page.items.map(serializeContactMessage),
        messages: page.items.map(serializeContactMessage),
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (page.items.length === 0) {
        console.log(`No attributed messages found for: ${contactRef}`);
        return payload;
      }

      console.log(
        `\nContact messages (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
      );
      for (const message of page.items) {
        const label = message.transcription ?? message.mediaType ?? message.messageId;
        console.log(`- ${formatMillis(message.createdAt)} :: ${message.chatId} :: ${label}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("open")
  @Command({ name: "activity", description: "Show session activity attributed to a contact" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "activity", risk: "low" })
  activity(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching events to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--raw", description: "Include low-level runtime/tool/adapter events" }) raw?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertCanReadContactTimeline(contactRef);
      const details = resolveContactDetailsOrFail(contactRef);
      const page = listSessionEventsByContactId(details.contact.id, { limit, offset, includeLowLevel: Boolean(raw) });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "contacts", "activity", contactRef],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: [raw ? "--raw" : null],
      });
      const payload = {
        target: contactRef,
        contactId: details.contact.id,
        filter: { raw: Boolean(raw) },
        total: page.total,
        pagination,
        items: page.items.map(serializeContactActivityEvent),
        events: page.items.map(serializeContactActivityEvent),
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (page.items.length === 0) {
        console.log(`No attributed activity found for: ${contactRef}`);
        return payload;
      }

      console.log(
        `\nContact activity (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
      );
      for (const event of page.items) {
        const session = event.sessionName ?? event.sessionKey;
        const preview = event.preview ? ` :: ${event.preview}` : "";
        console.log(`- ${formatMillis(event.timestamp)} :: ${session} :: ${event.eventType}${preview}`);
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("open")
  @Command({ name: "sessions", description: "Show session summaries attributed to a contact" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "sessions", risk: "low" })
  sessions(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching sessions to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      assertCanReadContactTimeline(contactRef);
      const details = resolveContactDetailsOrFail(contactRef);
      const page = listContactSessionSummaries(details.contact.id, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "contacts", "sessions", contactRef],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
      });
      const payload = {
        target: contactRef,
        contactId: details.contact.id,
        total: page.total,
        pagination,
        items: page.items.map(serializeContactSessionSummary),
        sessions: page.items.map(serializeContactSessionSummary),
      };
      if (asJson) {
        printJson(payload);
        return payload;
      }

      if (page.items.length === 0) {
        console.log(`No attributed sessions found for: ${contactRef}`);
        return payload;
      }

      console.log(
        `\nContact sessions (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
      );
      for (const session of page.items) {
        const name = session.sessionName ?? session.sessionKey;
        const latest = session.latestEventType ? ` latest=${session.latestEventType}` : "";
        console.log(
          `- ${formatMillis(session.lastSeenAt)} :: ${name} :: events=${session.eventCount} messages=${session.messageCount}${latest}`,
        );
      }
      if (pagination.nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${pagination.nextCommand}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("open")
  @Command({ name: "profile", description: "Show a contact profile card" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "profile", risk: "low" })
  profile(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Evidence rows per section (default: 10, max: 50)" }) limit?: string,
    @Option({ flags: "--include-crm", description: "Include CRM profile/account/opportunity/task summary" })
    includeCrm?: boolean,
  ) {
    try {
      assertCanReadContactTimeline(contactRef);
      const evidenceLimit = parseCliListLimit(limit, { defaultLimit: 10, maxLimit: 50 });
      const details = resolveContactDetailsOrFail(contactRef, { includeDuplicateCandidates: true });
      const metadata = listContactMetadata(details.contact.id, {});
      const timeline = listContactEvents(details.contact.id, { limit: evidenceLimit });
      const messages = dbListMessageMetaByContactId(details.contact.id, { limit: evidenceLimit });
      const activity = listSessionEventsByContactId(details.contact.id, { limit: evidenceLimit });
      const sessions = listContactSessionSummaries(details.contact.id, { limit: evidenceLimit });
      const contactRecord = getContact(details.contact.id);
      const tags = details.policy?.tags ?? contactRecord?.tags ?? [];
      const summary = metadataValue(metadata, "profile.summary");
      const headline = metadataValue(metadata, "profile.headline");
      const preferredName = metadataValue(metadata, "profile.preferred_name");
      const language = metadataValue(metadata, "profile.language");
      const preferences = metadataValue(metadata, "communication.preferences");
      const openLoops = metadataValue(metadata, "context.open_loops");
      const currentFocus = metadataValue(metadata, "context.current_focus");
      const recentTopics = metadataValue(metadata, "context.recent_topics");
      const crm = includeCrm ? getCrmContactProfile(details.contact.id) : null;

      const payload = {
        target: contactRef,
        contactId: details.contact.id,
        card: {
          contact: details.contact,
          policy: details.policy,
          platformIdentities: details.platformIdentities,
          duplicateCandidates: details.duplicateCandidates,
          header: {
            displayName: details.contact.displayName ?? contactRecord?.name ?? details.contact.id,
            preferredName: preferredName ?? null,
            headline: headline ?? null,
            kind: details.contact.kind,
            status: details.policy?.status ?? contactRecord?.status ?? null,
            tags,
            primaryPhone: details.contact.primaryPhone,
            primaryEmail: details.contact.primaryEmail,
            avatarUrl: details.contact.avatarUrl,
            lastInboundAt: details.policy?.lastInboundAt ?? contactRecord?.last_inbound_at ?? null,
            lastOutboundAt: details.policy?.lastOutboundAt ?? contactRecord?.last_outbound_at ?? null,
            interactionCount: details.policy?.interactionCount ?? contactRecord?.interaction_count ?? 0,
          },
          summary: summary ?? null,
          preferences: {
            language: language ?? null,
            communication: preferences ?? null,
          },
          focus: {
            current: currentFocus ?? null,
            recentTopics: recentTopics ?? null,
            openLoops: openLoops ?? null,
          },
          crm: crm
            ? {
                profile: crm.profile,
                accountMemberships: crm.accountMemberships,
                opportunities: crm.opportunities,
                tasks: crm.tasks,
                nextActions: crm.nextActions,
              }
            : null,
        },
        crm,
        metadata: metadata.map(serializeContactContextEntry),
        timeline: {
          total: timeline.total,
          limit: timeline.limit,
          offset: timeline.offset,
          items: timeline.items.map(serializeContactEvent),
        },
        messages: {
          total: messages.total,
          limit: messages.limit,
          offset: messages.offset,
          items: messages.items.map(serializeContactMessage),
        },
        sessions: {
          total: sessions.total,
          limit: sessions.limit,
          offset: sessions.offset,
          items: sessions.items.map(serializeContactSessionSummary),
        },
        activity: {
          total: activity.total,
          limit: activity.limit,
          offset: activity.offset,
          items: activity.items.map(serializeContactActivityEvent),
        },
      };

      if (asJson) {
        printJson(payload);
        return payload;
      }

      console.log(`\nContact profile: ${payload.card.header.displayName}\n`);
      console.log(`  id: ${details.contact.id}`);
      console.log(`  status: ${payload.card.header.status ?? "-"}`);
      console.log(`  tags: ${tags.length ? tags.join(", ") : "-"}`);
      console.log(`  identities: ${details.platformIdentities.length}`);
      console.log(`  last inbound: ${payload.card.header.lastInboundAt ?? "-"}`);
      console.log(`  last outbound: ${payload.card.header.lastOutboundAt ?? "-"}`);
      if (payload.card.summary) console.log(`\nSummary:\n  ${String(payload.card.summary)}`);
      console.log(
        `\nEvidence: ${sessions.total} sessions, ${messages.total} messages, ${activity.total} activity events, ${timeline.total} timeline events, ${metadata.length} metadata entries.`,
      );
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "note", description: "Append a note to a contact timeline" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "note", risk: "low" })
  note(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("text", { description: "Note text" }) text: string,
    @Option({ flags: "--source <source>", description: "Event source (default: cli)" }) source?: string,
    @Option({ flags: "--scope <type:id>", description: "Scoped context for this note" }) scope?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const scopeInput = parseScopeOption(scope);
    try {
      const event = addContactNote(contactRef, text, {
        ...scopeInput,
        source: source?.trim() || "cli",
        actorType: "user",
        confidence: 1,
      });
      const payload = {
        status: "note_added" as const,
        target: contactRef,
        event: serializeContactEvent(event),
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Note added: ${event.contactId} ${formatContactEventScope(event)}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("open")
  @Command({ name: "find", description: "Find contacts by tag or search query" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "find", risk: "low" })
  find(
    @Arg("query", { description: "Tag name (with --tag) or search query" }) query: string,
    @Option({ flags: "--tag", description: "Search by tag" }) byTag?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contacts = filterVisibleContacts(byTag ? findContactsByTag(query) : searchContacts(query));
    const payload = {
      query,
      byTag: Boolean(byTag),
      total: contacts.length,
      contacts: contacts.map((contact) => serializeContact(contact)),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (contacts.length === 0) {
      console.log(`No contacts found for: ${query}`);
      return payload;
    }

    console.log(`\nFound ${contacts.length} contact(s):\n`);
    console.log("  ST  ID          NAME                 IDENTITIES");
    console.log("  --  ----------  ----------------     ---------------------------");
    for (const contact of contacts) {
      const icon = statusIcon(contact.status);
      const id = contact.id.padEnd(10);
      const name = (contact.name || "-").padEnd(16);
      const identities = formatIdentitiesShort(contact, 40);
      console.log(`  ${icon}   ${id}  ${name}     ${identities}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "tag", description: "Add a tag to a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "tag", risk: "medium" })
  tag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("tag", { description: "Tag to add" }) tag: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    addContactTag(contact.phone, tag);
    const payload = {
      status: "tag_added" as const,
      target: contactRef,
      tag,
      contact: serializeContact(getUpdatedContact(contact)),
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Tag added: ${contact.id} +${tag}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "untag", description: "Remove a tag from a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "untag", risk: "medium" })
  untag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("tag", { description: "Tag to remove" }) tag: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    removeContactTag(contact.phone, tag);
    const payload = {
      status: "tag_removed" as const,
      target: contactRef,
      tag,
      contact: serializeContact(getUpdatedContact(contact)),
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Tag removed: ${contact.id} -${tag}`);
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "link", description: "Link a platform identity to a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "link", risk: "medium" })
  link(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--channel <channel>", description: "Channel, e.g. phone, whatsapp, telegram, email" })
    channel?: string,
    @Option({ flags: "--id <platformUserId>", description: "Platform user ID" }) platformUserId?: string,
    @Option({ flags: "--instance <id>", description: "Channel instance ID" }) instanceId?: string,
    @Option({ flags: "--reason <text>", description: "Reason for the link audit event" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!channel) fail("--channel is required");
    if (!platformUserId) fail("--id is required");

    try {
      const details = linkContactIdentity(contactRef, {
        channel,
        platformUserId,
        instanceId,
        reason: reason ?? null,
      });
      const payload = {
        status: "linked" as const,
        target: contactRef,
        identity: { channel, platformUserId, instanceId: instanceId ?? "" },
        contact: details.contact,
        platformIdentities: details.platformIdentities,
        policy: details.policy,
        duplicateCandidates: details.duplicateCandidates,
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Identity linked: ${details.contact.id} ${platformIcon(channel)} ${platformUserId}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "unlink", description: "Unlink a platform identity from its contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "unlink", risk: "medium" })
  unlink(
    @Arg("platformIdentity", { description: "Platform identity ID or value" }) platformIdentityRef: string,
    @Option({ flags: "--reason <text>", description: "Reason for the unlink audit event" }) reason?: string,
    @Option({ flags: "--channel <channel>", description: "Disambiguate identity value by channel" }) channel?: string,
    @Option({ flags: "--instance <id>", description: "Disambiguate identity value by instance id" })
    instanceId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = unlinkContactIdentity(platformIdentityRef, reason ?? null, { channel, instanceId });
    const payload = {
      status: details ? ("unlinked" as const) : ("not_found" as const),
      platformIdentity: platformIdentityRef,
      filter: { channel: channel ?? null, instanceId: instanceId ?? null },
      contact: details?.contact ?? null,
      platformIdentities: details?.platformIdentities ?? [],
      policy: details?.policy ?? null,
      duplicateCandidates: details?.duplicateCandidates ?? [],
      changedCount: details ? 1 : 0,
    };
    if (asJson) {
      printJson(payload);
    } else if (!details) {
      console.log(`Platform identity not found: ${platformIdentityRef}`);
    } else {
      console.log(`✓ Identity unlinked: ${platformIdentityRef}`);
    }
    return payload;
  }

  @Scope("open")
  @Command({ name: "duplicates", description: "Find likely duplicate contacts" })
  @CommandAccess({ kind: "read", resource: "contacts", action: "duplicates", risk: "low" })
  duplicates(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const scopeCtx = getScopeContext();
    const duplicateContacts = listDuplicateContacts()
      .filter((entry) => !isScopeEnforced(scopeCtx) || canReadCanonicalContact(scopeCtx, entry.contact.id))
      .map((entry) => ({
        ...entry,
        duplicateCandidates: isScopeEnforced(scopeCtx)
          ? entry.duplicateCandidates.filter((candidate) => canReadCanonicalContact(scopeCtx, candidate.contact.id))
          : entry.duplicateCandidates,
      }))
      .filter((entry) => entry.duplicateCandidates.length > 0);
    const payload = {
      total: duplicateContacts.length,
      duplicateContacts,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }

    if (duplicateContacts.length === 0) {
      console.log("No duplicate contact candidates found.");
      return payload;
    }

    console.log(`\nDuplicate contact candidates (${duplicateContacts.length}):\n`);
    for (const entry of duplicateContacts) {
      console.log(`  ${entry.contact.id} ${entry.contact.displayName ?? "-"}`);
      for (const candidate of entry.duplicateCandidates) {
        console.log(
          `    -> ${candidate.contact.id} ${candidate.contact.displayName ?? "-"} (${candidate.reasons.join(", ")})`,
        );
      }
    }
    return payload;
  }

  @Scope("writeContacts")
  @Command({ name: "merge", description: "Merge two contacts (move identities from source to target)" })
  @CommandAccess({ kind: "mutate", resource: "contacts", action: "merge", risk: "medium" })
  merge(
    @Arg("source", { description: "Source contact ID (will be deleted)" }) sourceRef: string,
    @Arg("target", { description: "Target contact ID" }) targetRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const target = getContact(targetRef);
    const source = getContact(sourceRef);
    if (!target) fail(`Target not found: ${targetRef}`);
    if (!source) fail(`Source not found: ${sourceRef}`);

    try {
      const result = mergeContacts(target.id, source.id);
      const payload = {
        status: "merged" as const,
        target: targetRef,
        source: sourceRef,
        merged: result.merged,
        targetContact: serializeContact(getUpdatedContact(target)),
        sourceContact: serializeContact(source),
        changedCount: result.merged,
      };
      if (asJson) {
        printJson(payload);
      } else {
        console.log(`✓ Merged: ${source.id} → ${target.id} (${result.merged} identities moved)`);
      }
      emitConfigChanged();
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }
}

@Group({
  name: "contacts.metadata",
  description: "Scoped contact metadata",
})
export class ContactsMetadataCommands {
  @Scope("open")
  @Command({ name: "list", description: "List current scoped metadata for a contact" })
  @CommandAccess({ kind: "read", resource: "contacts.metadata", action: "list", risk: "low" })
  list(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--scope <type:id>", description: "Filter by scoped context" }) scope?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of matching metadata entries to skip (default: 0)" })
    offset?: string,
  ) {
    const scopeInput = parseScopeOption(scope);
    try {
      assertCanReadContactTimeline(contactRef);
      const entries = listContactMetadata(contactRef, scopeInput);
      const page = paginateCliItems(entries, { limit, offset });
      const pagination = buildCliOffsetPagination({
        baseCommand: ["ravi", "contacts", "metadata", "list", contactRef],
        limit: page.limit,
        offset: page.offset,
        returned: page.items.length,
        total: page.total,
        options: ["--scope", scope?.trim() || null],
      });
      const payload = {
        target: contactRef,
        total: page.total,
        pagination,
        items: page.items.map(serializeContactContextEntry),
        metadata: page.items.map(serializeContactContextEntry),
      };
      if (asJson) {
        printJson(payload);
      } else if (page.items.length === 0) {
        console.log(`No contact metadata found for: ${contactRef}`);
      } else {
        console.log(
          `\nContact metadata (${page.items.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
        );
        for (const entry of page.items) {
          const scopeLabel = entry.scopeType === "global" ? "global" : `${entry.scopeType}:${entry.scopeId ?? "-"}`;
          console.log(`- ${scopeLabel} :: ${entry.key} = ${JSON.stringify(entry.value)}`);
        }
        if (pagination.nextCommand) {
          console.log("\nNext page:");
          console.log(`  ${pagination.nextCommand}`);
        }
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set scoped metadata for a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts.metadata", action: "set", risk: "medium" })
  set(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("key", { description: "Namespaced metadata key" }) key: string,
    @Arg("value", { description: "JSON value" }) value: string,
    @Option({ flags: "--scope <type:id>", description: "Scoped context, e.g. project:ravi-web" }) scope?: string,
    @Option({ flags: "--source <source>", description: "Event source (default: cli)" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const scopeInput = parseScopeOption(scope);
    const jsonValue = parseJsonArgument(value);
    try {
      const entry = setContactMetadata(contactRef, key, jsonValue, {
        ...scopeInput,
        source: source?.trim() || "cli",
        actorType: "user",
        confidence: 1,
      });
      const payload = {
        status: "metadata_set" as const,
        target: contactRef,
        metadata: serializeContactContextEntry(entry),
        changedCount: 1,
      };
      if (asJson) {
        printJson(payload);
      } else {
        const scopeLabel = entry.scopeType === "global" ? "global" : `${entry.scopeType}:${entry.scopeId ?? "-"}`;
        console.log(`✓ Metadata set: ${entry.contactId} ${scopeLabel} ${entry.key}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "remove", description: "Remove scoped metadata from a contact" })
  @CommandAccess({ kind: "mutate", resource: "contacts.metadata", action: "remove", risk: "destructive" })
  remove(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("key", { description: "Namespaced metadata key" }) key: string,
    @Option({ flags: "--scope <type:id>", description: "Scoped context, e.g. project:ravi-web" }) scope?: string,
    @Option({ flags: "--source <source>", description: "Event source (default: cli)" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const scopeInput = parseScopeOption(scope);
    try {
      const result = removeContactMetadata(contactRef, key, {
        ...scopeInput,
        source: source?.trim() || "cli",
        actorType: "user",
        confidence: 1,
      });
      const payload = {
        status: result.removed ? ("metadata_removed" as const) : ("not_found" as const),
        target: contactRef,
        key,
        previous: result.previous ? serializeContactContextEntry(result.previous) : null,
        event: result.event ? serializeContactEvent(result.event) : null,
        changedCount: result.removed ? 1 : 0,
      };
      if (asJson) {
        printJson(payload);
      } else if (result.removed) {
        console.log(`✓ Metadata removed: ${contactRef} ${key}`);
      } else {
        console.log(`Metadata not found: ${contactRef} ${key}`);
      }
      return payload;
    } catch (err: any) {
      fail(err.message);
    }
  }
}

declareCommandReturns(ContactsCommands, {
  activity: commandEnvelopeReturnSchema,
  add: commandEnvelopeReturnSchema,
  allow: commandEnvelopeReturnSchema,
  approve: commandEnvelopeReturnSchema,
  backfill: commandEnvelopeReturnSchema,
  block: commandEnvelopeReturnSchema,
  check: commandEnvelopeReturnSchema,
  duplicates: commandEnvelopeReturnSchema,
  find: commandEnvelopeReturnSchema,
  get: commandEnvelopeReturnSchema,
  info: commandEnvelopeReturnSchema,
  link: commandEnvelopeReturnSchema,
  list: commandEnvelopeReturnSchema,
  merge: commandEnvelopeReturnSchema,
  messages: commandEnvelopeReturnSchema,
  note: commandEnvelopeReturnSchema,
  pending: commandEnvelopeReturnSchema,
  profile: commandEnvelopeReturnSchema,
  remove: commandEnvelopeReturnSchema,
  sessions: commandEnvelopeReturnSchema,
  set: commandEnvelopeReturnSchema,
  tag: commandEnvelopeReturnSchema,
  timeline: commandEnvelopeReturnSchema,
  unlink: commandEnvelopeReturnSchema,
  untag: commandEnvelopeReturnSchema,
});

declareCommandReturns(ContactsMetadataCommands, {
  list: commandEnvelopeReturnSchema,
  remove: commandEnvelopeReturnSchema,
  set: commandEnvelopeReturnSchema,
});
