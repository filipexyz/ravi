/**
 * Contacts Commands - Contact management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
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
  type ContactStatus,
  type ReplyMode,
} from "../../contacts.js";

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

@Group({
  name: "contacts",
  description: "Contact management",
})
export class ContactsCommands {
  @Command({ name: "list", description: "List all contacts" })
  list() {
    const contacts = getAllContacts();
    if (contacts.length === 0) {
      console.log("No contacts registered.");
      console.log("\nAdd a contact: ravi contacts add <phone> [name]");
      return;
    }

    console.log("\nContacts:\n");
    console.log("  ST  PHONE                  NAME");
    console.log("  --  --------------------   ----------------");
    for (const contact of contacts) {
      const icon = statusIcon(contact.status);
      const phone = formatPhone(contact.phone).padEnd(20);
      const name = contact.name || "-";
      console.log(`  ${icon}   ${phone}   ${name}`);
    }
    const allowed = contacts.filter((c) => c.status === "allowed").length;
    const pending = contacts.filter((c) => c.status === "pending").length;
    const blocked = contacts.filter((c) => c.status === "blocked").length;
    console.log(
      `\n  Total: ${contacts.length} (${allowed} allowed, ${pending} pending, ${blocked} blocked)`
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
    console.log("  PHONE                  NAME                 SINCE");
    console.log("  --------------------   ----------------     ----------");
    for (const contact of contacts) {
      const phone = formatPhone(contact.phone).padEnd(20);
      const name = (contact.name || "-").padEnd(16);
      const since = contact.created_at.split(" ")[0];
      console.log(`  ${phone}   ${name}     ${since}`);
    }
    console.log("\nApprove: ravi contacts approve <phone>");
    console.log("Block:   ravi contacts block <phone>");
  }

  @Command({ name: "add", description: "Add/allow a contact" })
  add(
    @Arg("phone", { description: "Phone number" }) phone: string,
    @Arg("name", { required: false, description: "Contact name" }) name?: string
  ) {
    const normalized = normalizePhone(phone);
    upsertContact(normalized, name ?? null, "allowed");
    console.log(
      `✓ Contact added: ${formatPhone(normalized)}${name ? ` (${name})` : ""}`
    );
  }

  @Command({ name: "approve", description: "Approve pending contact" })
  approve(
    @Arg("phone", { description: "Phone number" }) phone: string,
    @Arg("agent", { required: false, description: "Agent ID" }) agentId?: string,
    @Arg("mode", { required: false, description: "Reply mode (auto|mention)" })
    replyMode?: string
  ) {
    if (replyMode && replyMode !== "auto" && replyMode !== "mention") {
      fail("Reply mode must be 'auto' or 'mention'");
    }

    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);
    if (!contact) {
      fail(`Contact not found: ${formatPhone(normalized)}`);
    }

    allowContact(normalized, agentId);
    if (replyMode) {
      setContactReplyMode(normalized, replyMode as ReplyMode);
    }

    const agentInfo = agentId ? ` → agent:${agentId}` : "";
    const modeInfo = replyMode ? ` (${replyMode})` : "";
    console.log(
      `✓ Contact approved: ${formatPhone(normalized)}${contact.name ? ` (${contact.name})` : ""}${agentInfo}${modeInfo}`
    );
  }

  @Command({ name: "remove", description: "Remove a contact" })
  remove(@Arg("phone", { description: "Phone number" }) phone: string) {
    const normalized = normalizePhone(phone);
    const deleted = deleteContact(normalized);
    if (deleted) {
      console.log(`✓ Contact removed: ${formatPhone(normalized)}`);
    } else {
      console.log(`Contact not found: ${formatPhone(normalized)}`);
    }
  }

  @Command({ name: "allow", description: "Allow a contact" })
  allow(@Arg("phone", { description: "Phone number" }) phone: string) {
    const normalized = normalizePhone(phone);
    allowContact(normalized);
    console.log(`✓ Contact allowed: ${formatPhone(normalized)}`);
  }

  @Command({ name: "block", description: "Block a contact" })
  block(@Arg("phone", { description: "Phone number" }) phone: string) {
    const normalized = normalizePhone(phone);
    blockContact(normalized);
    console.log(`✗ Contact blocked: ${formatPhone(normalized)}`);
  }

  @Command({ name: "set", description: "Set contact property" })
  set(
    @Arg("phone", { description: "Phone number" }) phone: string,
    @Arg("key", { description: "Property key (agent, mode)" }) key: string,
    @Arg("value", { description: "Property value" }) value: string
  ) {
    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);
    if (!contact) {
      fail(`Contact not found: ${formatPhone(normalized)}`);
    }

    if (key === "agent") {
      allowContact(normalized, value);
      console.log(`✓ Agent set: ${formatPhone(normalized)} → ${value}`);
    } else if (key === "mode") {
      if (value !== "auto" && value !== "mention") {
        fail("Mode must be 'auto' or 'mention'");
      }
      setContactReplyMode(normalized, value as ReplyMode);
      console.log(`✓ Mode set: ${formatPhone(normalized)} → ${value}`);
    } else if (key === "email") {
      updateContact(normalized, { email: value === "-" ? null : value });
      console.log(`✓ Email set: ${formatPhone(normalized)} → ${value}`);
    } else if (key === "name") {
      updateContact(normalized, { name: value === "-" ? null : value });
      console.log(`✓ Name set: ${formatPhone(normalized)} → ${value}`);
    } else if (key === "tags") {
      try {
        const tags = JSON.parse(value);
        if (!Array.isArray(tags)) fail("Tags must be a JSON array");
        updateContact(normalized, { tags });
        console.log(`✓ Tags set: ${formatPhone(normalized)} → ${value}`);
      } catch {
        fail("Tags must be a valid JSON array, e.g. '[\"lead\",\"vip\"]'");
      }
    } else if (key === "notes") {
      try {
        const notes = JSON.parse(value);
        if (typeof notes !== "object" || Array.isArray(notes)) fail("Notes must be a JSON object");
        updateContact(normalized, { notes });
        console.log(`✓ Notes set: ${formatPhone(normalized)}`);
      } catch {
        fail("Notes must be a valid JSON object, e.g. '{\"empresa\":\"Acme\"}'");
      }
    } else if (key === "opt-out" || key === "optout") {
      const boolValue = value === "true" || value === "yes" || value === "1";
      setOptOut(normalized, boolValue);
      console.log(`✓ Opt-out set: ${formatPhone(normalized)} → ${boolValue ? "yes" : "no"}`);
    } else {
      fail(`Unknown key: ${key}. Keys: agent, mode, email, name, tags, notes, opt-out`);
    }
  }

  @Command({ name: "check", description: "Check contact status" })
  check(@Arg("phone", { description: "Phone number" }) phone: string) {
    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);

    if (contact) {
      console.log(`\nContact: ${formatPhone(normalized)}`);
      console.log(`  Name:    ${contact.name || "-"}`);
      console.log(`  Email:   ${contact.email || "-"}`);
      console.log(`  Status:  ${statusText(contact.status)}`);
      console.log(`  Agent:   ${contact.agent_id || "-"}`);
      console.log(`  Mode:    ${contact.reply_mode || "auto"}`);
      console.log(`  Tags:    ${contact.tags.length > 0 ? contact.tags.join(", ") : "-"}`);
      console.log(`  Notes:   ${Object.keys(contact.notes).length > 0 ? JSON.stringify(contact.notes) : "-"}`);
      console.log(`  Opt-out: ${contact.opt_out ? "yes" : "no"}`);
      console.log(`  Interactions: ${contact.interaction_count}`);
      if (contact.last_inbound_at) console.log(`  Last inbound:  ${contact.last_inbound_at}`);
      if (contact.last_outbound_at) console.log(`  Last outbound: ${contact.last_outbound_at}`);
      console.log(`  Created: ${contact.created_at}`);
      console.log(`  Updated: ${contact.updated_at}`);
    } else {
      console.log(`\nContact not found: ${formatPhone(normalized)}`);
      console.log(`  Status: \x1b[31m✗ Not allowed\x1b[0m (unknown)`);
    }
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
    console.log("  ST  PHONE                  NAME                 TAGS");
    console.log("  --  --------------------   ----------------     ----");
    for (const contact of contacts) {
      const icon = statusIcon(contact.status);
      const phone = formatPhone(contact.phone).padEnd(20);
      const name = (contact.name || "-").padEnd(16);
      const tags = contact.tags.length > 0 ? contact.tags.join(", ") : "-";
      console.log(`  ${icon}   ${phone}   ${name}     ${tags}`);
    }
  }

  @Command({ name: "tag", description: "Add a tag to a contact" })
  tag(
    @Arg("phone", { description: "Phone number" }) phone: string,
    @Arg("tag", { description: "Tag to add" }) tag: string
  ) {
    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);
    if (!contact) {
      fail(`Contact not found: ${formatPhone(normalized)}`);
    }

    addContactTag(normalized, tag);
    console.log(`✓ Tag added: ${formatPhone(normalized)} +${tag}`);
  }

  @Command({ name: "untag", description: "Remove a tag from a contact" })
  untag(
    @Arg("phone", { description: "Phone number" }) phone: string,
    @Arg("tag", { description: "Tag to remove" }) tag: string
  ) {
    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);
    if (!contact) {
      fail(`Contact not found: ${formatPhone(normalized)}`);
    }

    removeContactTag(normalized, tag);
    console.log(`✓ Tag removed: ${formatPhone(normalized)} -${tag}`);
  }
}
