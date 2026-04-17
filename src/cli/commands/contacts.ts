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
  mergeContacts,
  setGroupTag,
  removeGroupTag,
  type Contact,
  type ContactStatus,
  type ReplyMode,
  type ContactSource,
  listAccountPending,
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
    case "whatsapp_lid":
      return "🆔";
    case "whatsapp_group":
      return "👥";
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
  return contact.identities.map((i) => `${platformIcon(i.platform)} ${formatPhone(i.value)}`).join(" | ");
}

function formatIdentitiesShort(contact: Contact, maxLen = 40): string {
  const full = formatIdentities(contact);
  if (full.length <= maxLen) return full;
  return full.slice(0, maxLen - 1) + "…";
}

@Group({
  name: "contacts",
  description: "Contact management",
})
export class ContactsCommands {
  @Scope("open")
  @Command({ name: "list", description: "List all contacts" })
  list(@Option({ flags: "--status <status>", description: "Filter by status" }) filterStatus?: string) {
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
  pending(@Option({ flags: "-a, --account <id>", description: "Filter by account" }) account?: string) {
    // Global pending contacts
    const contacts = getPendingContacts();
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

    // Per-account pending (unrouted messages on accounts without matching routes)
    const accountPending = listAccountPending(account);
    if (accountPending.length > 0) {
      console.log(`\nAccount pending (${accountPending.length}):\n`);
      console.log("  ACCOUNT       NAME                  IDENTITIES                          SINCE");
      console.log("  ------------  --------------------  ---------------------------------   ----------");
      for (const entry of accountPending) {
        const acct = entry.accountId.padEnd(12);
        const contact = getContact(entry.phone);
        const icon = entry.isGroup ? "👥" : "📱";
        const name = (contact?.name || entry.name || "-").slice(0, 20).padEnd(20);
        const identities = contact
          ? formatIdentitiesShort(contact, 35).padEnd(35)
          : `${icon} ${entry.phone}`.slice(0, 35).padEnd(35);
        const since = new Date(entry.updatedAt).toISOString().split("T")[0];
        console.log(`  ${acct}  ${name}  ${identities}   ${since}`);
      }
      console.log("\nAdd route: ravi instances routes add <instance> <pattern> <agent>");
    }

    if (contacts.length === 0 && accountPending.length === 0) {
      console.log("No pending contacts.");
    }
  }

  @Scope("writeContacts")
  @Command({ name: "add", description: "Add/allow a contact" })
  add(
    @Arg("identity", { description: "Phone number, LID, or group ID" }) identity: string,
    @Arg("name", { required: false, description: "Contact name" }) name?: string,
    @Option({ flags: "--agent <ids>", description: "Restrict to agent(s), comma-separated" }) agentIds?: string,
  ) {
    const normalized = normalizePhone(identity);
    upsertContact(normalized, name ?? null, "allowed", "manual");
    const contact = getContact(normalized);
    if (contact && agentIds) {
      const agents = agentIds
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      updateContact(contact.id, { allowedAgents: agents });
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
  ) {
    if (replyMode && replyMode !== "auto" && replyMode !== "mention") {
      fail("Reply mode must be 'auto' or 'mention'");
    }

    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    allowContact(contact.phone);
    if (replyMode) {
      setContactReplyMode(contact.phone, replyMode as ReplyMode);
    }
    if (agentIds) {
      const agents = agentIds
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean);
      updateContact(contact.id, { allowedAgents: agents });
    }
    emitConfigChanged();

    const modeInfo = replyMode ? ` (${replyMode})` : "";
    const agentLabel = agentIds ? ` [agents: ${agentIds}]` : "";
    console.log(`✓ Contact approved: ${contact.id}${contact.name ? ` (${contact.name})` : ""}${modeInfo}${agentLabel}`);
  }

  @Scope("writeContacts")
  @Command({ name: "remove", description: "Remove a contact" })
  remove(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    const deleted = deleteContact(contactRef);
    if (deleted) {
      console.log(`✓ Contact removed: ${contactRef}`);
    } else {
      console.log(`Contact not found: ${contactRef}`);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "allow", description: "Allow a contact" })
  allow(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }
    allowContact(contact.phone);
    console.log(`✓ Contact allowed: ${contact.id} (${contact.name || formatPhone(contact.phone)})`);
    emitConfigChanged();
  }

  @Scope("writeContacts")
  @Command({ name: "block", description: "Block a contact" })
  block(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }
    blockContact(contact.phone);
    console.log(`✗ Contact blocked: ${contact.id} (${contact.name || formatPhone(contact.phone)})`);
    emitConfigChanged();
  }

  @Scope("writeContacts")
  @Command({ name: "set", description: "Set contact property" })
  set(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("key", { description: "Property key" }) key: string,
    @Arg("value", { description: "Property value" }) value: string,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    if (key === "agent") {
      fail("agent is no longer set on contacts. Use 'ravi instances routes add <instance> <pattern> <agent>' instead.");
    } else if (key === "mode") {
      if (value !== "auto" && value !== "mention") {
        fail("Mode must be 'auto' or 'mention'");
      }
      setContactReplyMode(contact.phone, value as ReplyMode);
      console.log(`✓ Mode set: ${contact.id} → ${value}`);
    } else if (key === "email") {
      updateContact(contact.id, { email: value === "-" ? null : value });
      console.log(`✓ Email set: ${contact.id} → ${value}`);
    } else if (key === "name") {
      updateContact(contact.id, { name: value === "-" ? null : value });
      console.log(`✓ Name set: ${contact.id} → ${value}`);
    } else if (key === "tags") {
      try {
        const tags = JSON.parse(value);
        if (!Array.isArray(tags)) fail("Tags must be a JSON array");
        updateContact(contact.id, { tags });
        console.log(`✓ Tags set: ${contact.id} → ${value}`);
      } catch {
        fail('Tags must be a valid JSON array, e.g. \'["lead","vip"]\'');
      }
    } else if (key === "notes") {
      try {
        const notes = JSON.parse(value);
        if (typeof notes !== "object" || Array.isArray(notes)) fail("Notes must be a JSON object");
        updateContact(contact.id, { notes });
        console.log(`✓ Notes set: ${contact.id}`);
      } catch {
        fail('Notes must be a valid JSON object, e.g. \'{"empresa":"Acme"}\'');
      }
    } else if (key === "opt-out" || key === "optout") {
      const boolValue = value === "true" || value === "yes" || value === "1";
      setOptOut(contact.phone, boolValue);
      console.log(`✓ Opt-out set: ${contact.id} → ${boolValue ? "yes" : "no"}`);
    } else if (key === "source") {
      const validSources = ["inbound", "outbound", "manual", "discovered"];
      if (value !== "-" && !validSources.includes(value)) {
        fail(`Source must be one of: ${validSources.join(", ")} (or '-' to clear)`);
      }
      updateContact(contact.id, { source: value === "-" ? null : (value as ContactSource) });
      console.log(`✓ Source set: ${contact.id} → ${value}`);
    } else if (key === "allowed-agents") {
      if (value === "-" || value === "null") {
        updateContact(contact.id, { allowedAgents: null });
        console.log(`✓ Allowed agents cleared: ${contact.id} → (all)`);
      } else {
        try {
          const agents = JSON.parse(value);
          if (!Array.isArray(agents) || !agents.every((a: unknown) => typeof a === "string")) {
            fail("allowed-agents must be a JSON array of strings");
          }
          updateContact(contact.id, { allowedAgents: agents });
          console.log(`✓ Allowed agents set: ${contact.id} → ${agents.join(", ")}`);
        } catch {
          fail("allowed-agents must be a valid JSON array, e.g. '[\"main\",\"sentinel\"]' (or '-' to clear)");
        }
      }
    } else {
      fail(`Unknown key: ${key}. Keys: agent, mode, email, name, tags, notes, opt-out, source, allowed-agents`);
    }
  }

  @Scope("open")
  @Command({ name: "info", description: "Show contact details with all identities" })
  info(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    const contact = getContact(contactRef);

    if (!contact) {
      console.log(`\nContact not found: ${contactRef}`);
      return;
    }

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
            return `${platformIcon(id.platform)} ${id.platform.padEnd(16)} ${formatPhone(id.value)}${primary}`;
          })
        : "(none)",
      { labelWidth: 15 },
    );
  }

  @Scope("open")
  @Command({ name: "check", description: "Check contact status (alias for info)" })
  check(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    this.info(contactRef);
  }

  @Scope("open")
  @Command({ name: "find", description: "Find contacts by tag or search query" })
  find(
    @Arg("query", { description: "Tag name (with --tag) or search query" }) query: string,
    @Option({ flags: "--tag", description: "Search by tag" }) byTag?: boolean,
  ) {
    const contacts = byTag ? findContactsByTag(query) : searchContacts(query);

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
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    addContactTag(contact.phone, tag);
    console.log(`✓ Tag added: ${contact.id} +${tag}`);
  }

  @Scope("writeContacts")
  @Command({ name: "untag", description: "Remove a tag from a contact" })
  untag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("tag", { description: "Tag to remove" }) tag: string,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    removeContactTag(contact.phone, tag);
    console.log(`✓ Tag removed: ${contact.id} -${tag}`);
  }

  @Scope("writeContacts")
  @Command({ name: "group-tag", description: "Set a contact's tag in a specific group" })
  groupTag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("group", { description: "Group contact ID or identity" }) groupRef: string,
    @Arg("tag", { description: "Tag label" }) tag: string,
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
    console.log(`✓ Group tag set: ${contact.name ?? contact.id} = "${tag}" in ${group.name ?? group.id}`);
  }

  @Scope("writeContacts")
  @Command({ name: "group-untag", description: "Remove a contact's tag from a specific group" })
  groupUntag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("group", { description: "Group contact ID or identity" }) groupRef: string,
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
    console.log(`✓ Group tag removed: ${contact.name ?? contact.id} in ${group.name ?? group.id}`);
  }

  @Scope("writeContacts")
  @Command({ name: "identity-add", description: "Add an identity to a contact" })
  identityAdd(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("platform", { description: "Platform (phone, whatsapp_lid, whatsapp_group, matrix, telegram)" })
    platform: string,
    @Arg("value", { description: "Identity value" }) value: string,
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    try {
      addContactIdentity(contact.id, platform, value);
      console.log(`✓ Identity added: ${contact.id} ${platformIcon(platform)} ${formatPhone(value)}`);
    } catch (err: any) {
      fail(err.message);
    }
  }

  @Scope("writeContacts")
  @Command({ name: "identity-remove", description: "Remove an identity" })
  identityRemove(
    @Arg("platform", { description: "Platform" }) platform: string,
    @Arg("value", { description: "Identity value" }) value: string,
  ) {
    removeContactIdentity(platform, value);
    console.log(`✓ Identity removed: ${platformIcon(platform)} ${formatPhone(value)}`);
  }

  @Scope("writeContacts")
  @Command({ name: "merge", description: "Merge two contacts (move identities from source to target)" })
  merge(
    @Arg("target", { description: "Target contact ID" }) targetRef: string,
    @Arg("source", { description: "Source contact ID (will be deleted)" }) sourceRef: string,
  ) {
    const target = getContact(targetRef);
    const source = getContact(sourceRef);
    if (!target) fail(`Target not found: ${targetRef}`);
    if (!source) fail(`Source not found: ${sourceRef}`);

    try {
      const result = mergeContacts(target.id, source.id);
      console.log(`✓ Merged: ${source.id} → ${target.id} (${result.merged} identities moved)`);
      emitConfigChanged();
    } catch (err: any) {
      fail(err.message);
    }
  }
}
