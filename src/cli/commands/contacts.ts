/**
 * Contacts Commands - Contact management CLI (v2 with identities)
 */

import "reflect-metadata";
import { Group, Command, Scope, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
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
  addContactIdentity,
  removeContactIdentity,
  linkContactIdentity,
  unlinkContactIdentity,
  mergeContacts,
  getContactDetails,
  setContactKind,
  listDuplicateContacts,
  setGroupTag,
  removeGroupTag,
  type Contact,
  type ContactStatus,
  type ReplyMode,
  type ContactSource,
  listAccountPending,
  listAccountPendingContacts,
  listAccountPendingChats,
} from "../../contacts.js";
import { dbListRoutes } from "../../router/router-db.js";
import { findSessionByChatId } from "../../router/sessions.js";
import { getScopeContext, isScopeEnforced, canAccessContact } from "../../permissions/scope.js";
import { printInspectionBlock, printInspectionField } from "../inspection-output.js";

const CONTACT_DB_META = { source: "contact-db", freshness: "persisted" } as const;
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
    case "whatsapp_lid":
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
  if (platform === "phone" || platform === "whatsapp" || platform === "whatsapp_lid" || platform === "whatsapp_group") {
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

function summarizeContacts(contacts: Contact[]) {
  return {
    total: contacts.length,
    allowed: contacts.filter((c) => c.status === "allowed").length,
    pending: contacts.filter((c) => c.status === "pending").length,
    blocked: contacts.filter((c) => c.status === "blocked").length,
    discovered: contacts.filter((c) => c.status === "discovered").length,
  };
}

@Group({
  name: "contacts",
  description: "Contact management",
})
export class ContactsCommands {
  @Scope("open")
  @Command({ name: "list", description: "List all contacts" })
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) filterStatus?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    let contacts = filterStatus ? getAllContacts().filter((c) => c.status === filterStatus) : getAllContacts();

    // Scope isolation: filter contacts by agent scope (via REBAC)
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx)) {
      contacts = contacts.filter((c) => {
        // Find the agent that owns this contact's session (via route)
        const contactAgent = getRouteAgent(c);
        const contactSessions = contactAgent ? [{ agentId: contactAgent }] : [];
        return canAccessContact(scopeCtx, c, null, contactSessions);
      });
    }

    if (asJson) {
      printJson({
        filter: { status: filterStatus ?? null },
        counts: summarizeContacts(contacts),
        contacts: contacts.map((contact) => serializeContact(contact)),
      });
      return;
    }

    if (contacts.length === 0) {
      console.log("No contacts registered.");
      console.log("\nAdd a contact: ravi contacts add <phone> [name]");
      return;
    }

    console.log("\nContacts:\n");
    console.log("  ST  ID          NAME                  AGENT           SESSION              IDENTITIES");
    console.log(
      "  --  ----------  --------------------  --------------  -------------------  ---------------------------",
    );
    for (const contact of contacts) {
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
      `\n  Total: ${contacts.length} (${allowed} allowed, ${pending} pending, ${blocked} blocked, ${discovered} discovered)`,
    );
  }

  @Scope("open")
  @Command({ name: "pending", description: "List pending contacts" })
  pending(
    @Option({ flags: "-a, --account <id>", description: "Filter by account" }) account?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    // Global pending contacts
    const contacts = getPendingContacts();
    const accountPendingContacts = listAccountPendingContacts(account);
    const pendingChats = listAccountPendingChats(account);
    const legacyAccountPending = listAccountPending(account);

    if (asJson) {
      printJson({
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
        accountPending: legacyAccountPending.map((entry) => ({
          ...entry,
          type: entry.chatType,
          contact: entry.pendingKind === "contact" ? serializeContactMaybe(getContact(entry.phone)) : null,
        })),
      });
      return;
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
  }

  @Scope("writeContacts")
  @Command({ name: "add", description: "Add/allow a contact" })
  add(
    @Arg("identity", { description: "Phone number or LID" }) identity: string,
    @Arg("name", { required: false, description: "Contact name" }) name?: string,
    @Option({ flags: "--agent <ids>", description: "Restrict to agent(s), comma-separated" }) agentIds?: string,
    @Option({ flags: "--kind <kind>", description: "Contact kind: person or org" }) kind?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalized = normalizePhone(identity);
    if (!normalized) {
      fail("Identity must be a phone number or WhatsApp LID. Use 'ravi contacts link' for explicit platform ids.");
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
    if (asJson) {
      printJson({
        status: "added",
        target: identity,
        normalized,
        kind: kind ?? "person",
        contact: serializeContactMaybe(updated),
        allowedAgents: parseAgentIds(agentIds),
        changedCount: updated ? 1 : 0,
      });
      return;
    }
    const agentLabel = agentIds ? ` [agents: ${agentIds}]` : "";
    console.log(
      `✓ Contact added: ${contact?.id ?? normalized}${name ? ` (${name})` : ""} — ${formatPhone(normalized)}${agentLabel}`,
    );
  }

  @Scope("writeContacts")
  @Command({ name: "approve", description: "Approve pending contact" })
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
    if (asJson) {
      printJson({
        status: "approved",
        target: contactRef,
        contact: serializeContact(updated),
        replyMode: replyMode ?? null,
        allowedAgents: parseAgentIds(agentIds),
        changedCount: 1,
      });
      return;
    }

    const modeInfo = replyMode ? ` (${replyMode})` : "";
    const agentLabel = agentIds ? ` [agents: ${agentIds}]` : "";
    console.log(`✓ Contact approved: ${contact.id}${contact.name ? ` (${contact.name})` : ""}${modeInfo}${agentLabel}`);
  }

  @Scope("writeContacts")
  @Command({ name: "remove", description: "Remove a contact" })
  remove(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const deleted = deleteContact(contactRef);
    if (asJson) {
      printJson({
        status: deleted ? "removed" : "not_found",
        target: contactRef,
        changedCount: deleted ? 1 : 0,
      });
      return;
    }
    if (deleted) {
      console.log(`✓ Contact removed: ${contactRef}`);
    } else {
      console.log(`Contact not found: ${contactRef}`);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "allow", description: "Allow a contact" })
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
    if (asJson) {
      printJson({
        status: "allowed",
        target: contactRef,
        contact: serializeContact(updated),
        changedCount: 1,
      });
      emitConfigChanged();
      return;
    }
    console.log(`✓ Contact allowed: ${contact.id} (${contact.name || formatPhone(contact.phone)})`);
    emitConfigChanged();
  }

  @Scope("writeContacts")
  @Command({ name: "block", description: "Block a contact" })
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
    if (asJson) {
      printJson({
        status: "blocked",
        target: contactRef,
        contact: serializeContact(updated),
        changedCount: 1,
      });
      emitConfigChanged();
      return;
    }
    console.log(`✗ Contact blocked: ${contact.id} (${contact.name || formatPhone(contact.phone)})`);
    emitConfigChanged();
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set contact property" })
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

    if (asJson) {
      printJson({
        status: "updated",
        target: contactRef,
        key,
        value: jsonValue,
        contact: serializeContact(getUpdatedContact(contact)),
        changedCount: 1,
      });
    }
  }

  @Scope("open")
  @Command({ name: "get", description: "Show canonical contact details", aliases: ["show"] })
  get(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = getContactDetails(contactRef);
    const contact = details?.legacyContact ?? getContact(contactRef);

    if (!contact && !details) {
      if (asJson) {
        printJson({ found: false, target: contactRef, contact: null });
        return;
      }
      console.log(`\nContact not found: ${contactRef}`);
      return;
    }

    if (asJson) {
      printJson({
        found: true,
        target: contactRef,
        contact: details?.contact ?? null,
        platformIdentities: details?.platformIdentities ?? [],
        policy: details?.policy ?? null,
        duplicateCandidates: details?.duplicateCandidates ?? [],
        legacyContact: contact ? serializeContact(contact) : null,
        routeAgent: contact ? getRouteAgent(contact) : null,
        sessionName: contact ? getSessionName(contact) : null,
      });
      return;
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
      return;
    }

    if (!contact) return;
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
    printInspectionField("Tags", contact.tags.length > 0 ? contact.tags.join(", ") : "-", CONTACT_DB_META, {
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
  }

  @Scope("open")
  @Command({ name: "info", description: "Show contact details with all identities" })
  info(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    this.get(contactRef, asJson);
  }

  @Scope("open")
  @Command({ name: "check", description: "Check contact status (alias for info)" })
  check(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    this.get(contactRef, asJson);
  }

  @Scope("open")
  @Command({ name: "find", description: "Find contacts by tag or search query" })
  find(
    @Arg("query", { description: "Tag name (with --tag) or search query" }) query: string,
    @Option({ flags: "--tag", description: "Search by tag" }) byTag?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contacts = byTag ? findContactsByTag(query) : searchContacts(query);

    if (asJson) {
      printJson({
        query,
        byTag: Boolean(byTag),
        total: contacts.length,
        contacts: contacts.map((contact) => serializeContact(contact)),
      });
      return;
    }

    if (contacts.length === 0) {
      console.log(`No contacts found for: ${query}`);
      return;
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
  }

  @Scope("writeContacts")
  @Command({ name: "tag", description: "Add a tag to a contact" })
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
    if (asJson) {
      printJson({
        status: "tag_added",
        target: contactRef,
        tag,
        contact: serializeContact(getUpdatedContact(contact)),
        changedCount: 1,
      });
      return;
    }
    console.log(`✓ Tag added: ${contact.id} +${tag}`);
  }

  @Scope("writeContacts")
  @Command({ name: "untag", description: "Remove a tag from a contact" })
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
    if (asJson) {
      printJson({
        status: "tag_removed",
        target: contactRef,
        tag,
        contact: serializeContact(getUpdatedContact(contact)),
        changedCount: 1,
      });
      return;
    }
    console.log(`✓ Tag removed: ${contact.id} -${tag}`);
  }

  @Scope("writeContacts")
  @Command({ name: "group-tag", description: "Set a contact's tag in a specific group" })
  groupTag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("group", { description: "Group contact ID or identity" }) groupRef: string,
    @Arg("tag", { description: "Tag label" }) tag: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }
    const group = getContact(groupRef);
    if (!group) {
      fail(`Group not found: ${groupRef}`);
    }

    setGroupTag(contact.id, group.id, tag);
    if (asJson) {
      printJson({
        status: "group_tag_set",
        target: contactRef,
        groupRef,
        tag,
        contact: serializeContact(getUpdatedContact(contact)),
        group: serializeContact(getUpdatedContact(group)),
        changedCount: 1,
      });
      return;
    }
    console.log(`✓ Group tag set: ${contact.name ?? contact.id} = "${tag}" in ${group.name ?? group.id}`);
  }

  @Scope("writeContacts")
  @Command({ name: "group-untag", description: "Remove a contact's tag from a specific group" })
  groupUntag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("group", { description: "Group contact ID or identity" }) groupRef: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }
    const group = getContact(groupRef);
    if (!group) {
      fail(`Group not found: ${groupRef}`);
    }

    removeGroupTag(contact.id, group.id);
    if (asJson) {
      printJson({
        status: "group_tag_removed",
        target: contactRef,
        groupRef,
        contact: serializeContact(getUpdatedContact(contact)),
        group: serializeContact(getUpdatedContact(group)),
        changedCount: 1,
      });
      return;
    }
    console.log(`✓ Group tag removed: ${contact.name ?? contact.id} in ${group.name ?? group.id}`);
  }

  @Scope("writeContacts")
  @Command({ name: "link", description: "Link a platform identity to a contact" })
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
      if (asJson) {
        printJson({
          status: "linked",
          target: contactRef,
          identity: { channel, platformUserId, instanceId: instanceId ?? "" },
          contact: details.contact,
          platformIdentities: details.platformIdentities,
          policy: details.policy,
          duplicateCandidates: details.duplicateCandidates,
          changedCount: 1,
        });
        return;
      }
      console.log(`✓ Identity linked: ${details.contact.id} ${platformIcon(channel)} ${platformUserId}`);
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "identity-add", description: "Add an identity to a contact (legacy alias for link)" })
  identityAdd(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("platform", { description: "Platform (phone, whatsapp_lid, telegram, email)" })
    platform: string,
    @Arg("value", { description: "Identity value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    try {
      addContactIdentity(contact.id, platform, value);
      if (asJson) {
        printJson({
          status: "identity_added",
          target: contactRef,
          identity: { platform, value },
          contact: serializeContact(getUpdatedContact(contact)),
          changedCount: 1,
        });
        return;
      }
      console.log(`✓ Identity added: ${contact.id} ${platformIcon(platform)} ${formatIdentityValue(platform, value)}`);
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "unlink", description: "Unlink a platform identity from its contact" })
  unlink(
    @Arg("platformIdentity", { description: "Platform identity ID or value" }) platformIdentityRef: string,
    @Option({ flags: "--reason <text>", description: "Reason for the unlink audit event" }) reason?: string,
    @Option({ flags: "--channel <channel>", description: "Disambiguate identity value by channel" }) channel?: string,
    @Option({ flags: "--instance <id>", description: "Disambiguate identity value by instance id" })
    instanceId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const details = unlinkContactIdentity(platformIdentityRef, reason ?? null, { channel, instanceId });
    if (asJson) {
      printJson({
        status: details ? "unlinked" : "not_found",
        platformIdentity: platformIdentityRef,
        filter: { channel: channel ?? null, instanceId: instanceId ?? null },
        contact: details?.contact ?? null,
        platformIdentities: details?.platformIdentities ?? [],
        policy: details?.policy ?? null,
        duplicateCandidates: details?.duplicateCandidates ?? [],
        changedCount: details ? 1 : 0,
      });
      return;
    }
    if (!details) {
      console.log(`Platform identity not found: ${platformIdentityRef}`);
      return;
    }
    console.log(`✓ Identity unlinked: ${platformIdentityRef}`);
  }

  @Scope("writeContacts")
  @Command({ name: "identity-remove", description: "Remove an identity (legacy alias for unlink)" })
  identityRemove(
    @Arg("platform", { description: "Platform" }) platform: string,
    @Arg("value", { description: "Identity value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const contact = getContact(value);
    removeContactIdentity(platform, value);
    if (asJson) {
      printJson({
        status: "identity_removed",
        identity: { platform, value },
        contactId: contact?.id ?? null,
        changedCount: 1,
      });
      return;
    }
    console.log(`✓ Identity removed: ${platformIcon(platform)} ${formatIdentityValue(platform, value)}`);
  }

  @Scope("open")
  @Command({ name: "duplicates", description: "Find likely duplicate contacts" })
  duplicates(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const duplicateContacts = listDuplicateContacts();
    if (asJson) {
      printJson({
        total: duplicateContacts.length,
        duplicateContacts,
      });
      return;
    }

    if (duplicateContacts.length === 0) {
      console.log("No duplicate contact candidates found.");
      return;
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
  }

  @Scope("writeContacts")
  @Command({ name: "merge", description: "Merge two contacts (move identities from source to target)" })
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
      if (asJson) {
        printJson({
          status: "merged",
          target: targetRef,
          source: sourceRef,
          merged: result.merged,
          targetContact: serializeContact(getUpdatedContact(target)),
          sourceContact: serializeContact(source),
          changedCount: result.merged,
        });
        emitConfigChanged();
        return;
      }
      console.log(`✓ Merged: ${source.id} → ${target.id} (${result.merged} identities moved)`);
      emitConfigChanged();
    } catch (err: any) {
      fail(err.message);
    }
  }
}
