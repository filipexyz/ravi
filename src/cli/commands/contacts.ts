/**
 * Contacts Commands - Contact management CLI (v2 with identities)
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { notif } from "../../notif.js";

/** Notify gateway that config changed */
function emitConfigChanged() {
  notif.emit("ravi.config.changed", {}).catch(() => {});
}
import {
  getAllContacts,
  getContact,
  getContactById,
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
  getContactIdentities,
  type Contact,
  type ContactStatus,
  type ReplyMode,
  type ContactSource,
} from "../../contacts.js";
import { dbGetRoute } from "../../router/router-db.js";
import { findSessionByChatId } from "../../router/sessions.js";

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

/** Lookup agent from routes table by checking all contact identities */
function getRouteAgent(contact: Contact): string | null {
  for (const id of contact.identities) {
    const route = dbGetRoute(id.value.toLowerCase());
    if (route) return route.agent;
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
    case "phone": return "📱";
    case "whatsapp_lid": return "🆔";
    case "whatsapp_group": return "👥";
    case "matrix": return "🔗";
    case "telegram": return "✈️";
    default: return "•";
  }
}

function formatIdentities(contact: Contact): string {
  if (contact.identities.length === 0) return "-";
  return contact.identities
    .map(i => `${platformIcon(i.platform)} ${formatPhone(i.value)}`)
    .join(" | ");
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
  @Command({ name: "list", description: "List all contacts" })
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) filterStatus?: string
  ) {
    const contacts = filterStatus
      ? getAllContacts().filter(c => c.status === filterStatus)
      : getAllContacts();

    if (contacts.length === 0) {
      console.log("No contacts registered.");
      console.log("\nAdd a contact: ravi contacts add <phone> [name]");
      return;
    }

    console.log("\nContacts:\n");
    console.log("  ST  ID          NAME                  AGENT           SESSION              IDENTITIES");
    console.log("  --  ----------  --------------------  --------------  -------------------  ---------------------------");
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
      `\n  Total: ${contacts.length} (${allowed} allowed, ${pending} pending, ${blocked} blocked, ${discovered} discovered)`
    );
  }

  @Command({ name: "pending", description: "List pending contacts" })
  pending() {
    const contacts = getPendingContacts();
    if (contacts.length === 0) {
      console.log("No pending contacts.");
      return;
    }

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

  @Command({ name: "add", description: "Add/allow a contact" })
  add(
    @Arg("identity", { description: "Phone number, LID, or group ID" }) identity: string,
    @Arg("name", { required: false, description: "Contact name" }) name?: string
  ) {
    const normalized = normalizePhone(identity);
    upsertContact(normalized, name ?? null, "allowed", "manual");
    const contact = getContact(normalized);
    console.log(
      `✓ Contact added: ${contact?.id ?? normalized}${name ? ` (${name})` : ""} — ${formatPhone(normalized)}`
    );
  }

  @Command({ name: "approve", description: "Approve pending contact" })
  approve(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("mode", { required: false, description: "Reply mode (auto|mention)" })
    replyMode?: string
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
    emitConfigChanged();

    const modeInfo = replyMode ? ` (${replyMode})` : "";
    console.log(
      `✓ Contact approved: ${contact.id}${contact.name ? ` (${contact.name})` : ""}${modeInfo}`
    );
  }

  @Command({ name: "remove", description: "Remove a contact" })
  remove(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    const deleted = deleteContact(contactRef);
    if (deleted) {
      console.log(`✓ Contact removed: ${contactRef}`);
    } else {
      console.log(`Contact not found: ${contactRef}`);
    }
  }

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

  @Command({ name: "set", description: "Set contact property" })
  set(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("key", { description: "Property key" }) key: string,
    @Arg("value", { description: "Property value" }) value: string
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    if (key === "agent") {
      fail("agent is no longer set on contacts. Use 'ravi routes add <pattern> <agent>' instead.");
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
        fail("Tags must be a valid JSON array, e.g. '[\"lead\",\"vip\"]'");
      }
    } else if (key === "notes") {
      try {
        const notes = JSON.parse(value);
        if (typeof notes !== "object" || Array.isArray(notes)) fail("Notes must be a JSON object");
        updateContact(contact.id, { notes });
        console.log(`✓ Notes set: ${contact.id}`);
      } catch {
        fail("Notes must be a valid JSON object, e.g. '{\"empresa\":\"Acme\"}'");
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
      updateContact(contact.id, { source: value === "-" ? null : value as ContactSource });
      console.log(`✓ Source set: ${contact.id} → ${value}`);
    } else {
      fail(`Unknown key: ${key}. Keys: agent, mode, email, name, tags, notes, opt-out, source`);
    }
  }

  @Command({ name: "info", description: "Show contact details with all identities" })
  info(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    const contact = getContact(contactRef);

    if (!contact) {
      console.log(`\nContact not found: ${contactRef}`);
      return;
    }

    console.log(`\nContact: ${contact.id}`);
    console.log(`  Name:    ${contact.name || "-"}`);
    console.log(`  Email:   ${contact.email || "-"}`);
    console.log(`  Status:  ${statusText(contact.status)}`);
    console.log(`  Agent:   ${getRouteAgent(contact) || "-"} (via route)`);
    console.log(`  Session: ${getSessionName(contact) || "-"}`);
    console.log(`  Mode:    ${contact.reply_mode || "auto"}`);
    console.log(`  Tags:    ${contact.tags.length > 0 ? contact.tags.join(", ") : "-"}`);
    console.log(`  Notes:   ${Object.keys(contact.notes).length > 0 ? JSON.stringify(contact.notes) : "-"}`);
    console.log(`  Opt-out: ${contact.opt_out ? "yes" : "no"}`);
    console.log(`  Source:  ${contact.source || "-"}`);
    console.log(`  Interactions: ${contact.interaction_count}`);
    if (contact.last_inbound_at) console.log(`  Last inbound:  ${contact.last_inbound_at}`);
    if (contact.last_outbound_at) console.log(`  Last outbound: ${contact.last_outbound_at}`);
    console.log(`  Created: ${contact.created_at}`);
    console.log(`  Updated: ${contact.updated_at}`);

    console.log(`\n  Identities (${contact.identities.length}):`);
    for (const id of contact.identities) {
      const primary = id.isPrimary ? " ★" : "";
      console.log(`    ${platformIcon(id.platform)} ${id.platform.padEnd(16)} ${formatPhone(id.value)}${primary}`);
    }
  }

  @Command({ name: "check", description: "Check contact status (alias for info)" })
  check(@Arg("contact", { description: "Contact ID or identity" }) contactRef: string) {
    this.info(contactRef);
  }

  @Command({ name: "find", description: "Find contacts by tag or search query" })
  find(
    @Arg("query", { description: "Tag name (with --tag) or search query" }) query: string,
    @Option({ flags: "--tag", description: "Search by tag" }) byTag?: boolean
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

  @Command({ name: "tag", description: "Add a tag to a contact" })
  tag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("tag", { description: "Tag to add" }) tag: string
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    addContactTag(contact.phone, tag);
    console.log(`✓ Tag added: ${contact.id} +${tag}`);
  }

  @Command({ name: "untag", description: "Remove a tag from a contact" })
  untag(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("tag", { description: "Tag to remove" }) tag: string
  ) {
    const contact = getContact(contactRef);
    if (!contact) {
      fail(`Contact not found: ${contactRef}`);
    }

    removeContactTag(contact.phone, tag);
    console.log(`✓ Tag removed: ${contact.id} -${tag}`);
  }

  @Command({ name: "identity-add", description: "Add an identity to a contact" })
  identityAdd(
    @Arg("contact", { description: "Contact ID or identity" }) contactRef: string,
    @Arg("platform", { description: "Platform (phone, whatsapp_lid, whatsapp_group, matrix, telegram)" }) platform: string,
    @Arg("value", { description: "Identity value" }) value: string
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

  @Command({ name: "identity-remove", description: "Remove an identity" })
  identityRemove(
    @Arg("platform", { description: "Platform" }) platform: string,
    @Arg("value", { description: "Identity value" }) value: string
  ) {
    removeContactIdentity(platform, value);
    console.log(`✓ Identity removed: ${platformIcon(platform)} ${formatPhone(value)}`);
  }

  @Command({ name: "merge", description: "Merge two contacts (move identities from source to target)" })
  merge(
    @Arg("target", { description: "Target contact ID" }) targetRef: string,
    @Arg("source", { description: "Source contact ID (will be deleted)" }) sourceRef: string
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
