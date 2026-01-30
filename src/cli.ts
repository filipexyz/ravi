#!/usr/bin/env tsx
/**
 * Ravi Bot CLI - Contact management
 *
 * Usage:
 *   npm run cli -- <command> [args]
 */

import {
  getAllContacts,
  getContact,
  getPendingContacts,
  upsertContact,
  deleteContact,
  allowContact,
  blockContact,
  isAllowed,
  normalizePhone,
  type ContactStatus,
} from "./contacts.js";

const [, , command, ...args] = process.argv;

function printUsage() {
  console.log(`
Ravi Bot CLI - Contact Management

Usage:
  npm run cli -- <command> [args]

Commands:
  list                    List all contacts
  pending                 List pending contacts (awaiting approval)
  add <phone> [name]      Add/allow a contact
  approve <phone>         Approve a pending contact
  remove <phone>          Remove a contact
  allow <phone>           Allow a contact
  block <phone>           Block a contact
  check <phone>           Check contact status

Examples:
  npm run cli -- list
  npm run cli -- pending
  npm run cli -- add 5511999999999 "João Silva"
  npm run cli -- approve 5511888888888
  npm run cli -- block 5511777777777
`);
}

function formatPhone(phone: string): string {
  // LID format
  if (phone.startsWith("lid:")) {
    return `LID:${phone.slice(4)}`;
  }

  // Brazilian mobile (13 digits: 55 + 2 DDD + 9 + 8 digits)
  if (phone.length === 13 && phone.startsWith("55")) {
    return `+${phone.slice(0, 2)} (${phone.slice(2, 4)}) ${phone.slice(4, 9)}-${phone.slice(9)}`;
  }

  // Brazilian landline (12 digits: 55 + 2 DDD + 8 digits)
  if (phone.length === 12 && phone.startsWith("55")) {
    return `+${phone.slice(0, 2)} (${phone.slice(2, 4)}) ${phone.slice(4, 8)}-${phone.slice(8)}`;
  }

  // Other international
  if (phone.length >= 10) {
    return `+${phone}`;
  }

  return phone;
}

function statusIcon(status: ContactStatus): string {
  switch (status) {
    case "allowed": return "\x1b[32m✓\x1b[0m";
    case "pending": return "\x1b[33m?\x1b[0m";
    case "blocked": return "\x1b[31m✗\x1b[0m";
  }
}

function statusText(status: ContactStatus): string {
  switch (status) {
    case "allowed": return "\x1b[32mallowed\x1b[0m";
    case "pending": return "\x1b[33mpending\x1b[0m";
    case "blocked": return "\x1b[31mblocked\x1b[0m";
  }
}

switch (command) {
  case "list": {
    const contacts = getAllContacts();
    if (contacts.length === 0) {
      console.log("No contacts registered.");
      console.log("\nAdd a contact: npm run cli -- add <phone> [name]");
    } else {
      console.log("\nContacts:\n");
      console.log("  ST  PHONE                  NAME");
      console.log("  --  --------------------   ----------------");
      for (const contact of contacts) {
        const icon = statusIcon(contact.status);
        const phone = formatPhone(contact.phone).padEnd(20);
        const name = contact.name || "-";
        console.log(`  ${icon}   ${phone}   ${name}`);
      }
      const allowed = contacts.filter(c => c.status === "allowed").length;
      const pending = contacts.filter(c => c.status === "pending").length;
      const blocked = contacts.filter(c => c.status === "blocked").length;
      console.log(`\n  Total: ${contacts.length} (${allowed} allowed, ${pending} pending, ${blocked} blocked)`);
    }
    break;
  }

  case "pending": {
    const contacts = getPendingContacts();
    if (contacts.length === 0) {
      console.log("No pending contacts.");
    } else {
      console.log(`\nPending contacts (${contacts.length}):\n`);
      console.log("  PHONE                  NAME                 SINCE");
      console.log("  --------------------   ----------------     ----------");
      for (const contact of contacts) {
        const phone = formatPhone(contact.phone).padEnd(20);
        const name = (contact.name || "-").padEnd(16);
        const since = contact.created_at.split(" ")[0];
        console.log(`  ${phone}   ${name}     ${since}`);
      }
      console.log("\nApprove: npm run cli -- approve <phone>");
      console.log("Block:   npm run cli -- block <phone>");
    }
    break;
  }

  case "add": {
    const phone = args[0];
    const name = args.slice(1).join(" ") || null;
    if (!phone) {
      console.error("Error: Phone number required");
      console.log("Usage: npm run cli -- add <phone> [name]");
      process.exit(1);
    }
    const normalized = normalizePhone(phone);
    upsertContact(normalized, name, "allowed");
    console.log(`✓ Contact added: ${formatPhone(normalized)}${name ? ` (${name})` : ""}`);
    break;
  }

  case "approve": {
    const phone = args[0];
    if (!phone) {
      console.error("Error: Phone number required");
      process.exit(1);
    }
    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);
    if (!contact) {
      console.log(`Contact not found: ${formatPhone(normalized)}`);
      process.exit(1);
    }
    allowContact(normalized);
    console.log(`✓ Contact approved: ${formatPhone(normalized)}${contact.name ? ` (${contact.name})` : ""}`);
    break;
  }

  case "remove": {
    const phone = args[0];
    if (!phone) {
      console.error("Error: Phone number required");
      process.exit(1);
    }
    const normalized = normalizePhone(phone);
    const deleted = deleteContact(normalized);
    if (deleted) {
      console.log(`✓ Contact removed: ${formatPhone(normalized)}`);
    } else {
      console.log(`Contact not found: ${formatPhone(normalized)}`);
    }
    break;
  }

  case "allow": {
    const phone = args[0];
    if (!phone) {
      console.error("Error: Phone number required");
      process.exit(1);
    }
    const normalized = normalizePhone(phone);
    allowContact(normalized);
    console.log(`✓ Contact allowed: ${formatPhone(normalized)}`);
    break;
  }

  case "block": {
    const phone = args[0];
    if (!phone) {
      console.error("Error: Phone number required");
      process.exit(1);
    }
    const normalized = normalizePhone(phone);
    blockContact(normalized);
    console.log(`✗ Contact blocked: ${formatPhone(normalized)}`);
    break;
  }

  case "check": {
    const phone = args[0];
    if (!phone) {
      console.error("Error: Phone number required");
      process.exit(1);
    }
    const normalized = normalizePhone(phone);
    const contact = getContact(normalized);

    if (contact) {
      console.log(`\nContact: ${formatPhone(normalized)}`);
      console.log(`  Name:    ${contact.name || "-"}`);
      console.log(`  Status:  ${statusText(contact.status)}`);
      console.log(`  Created: ${contact.created_at}`);
      console.log(`  Updated: ${contact.updated_at}`);
    } else {
      console.log(`\nContact not found: ${formatPhone(normalized)}`);
      console.log(`  Status: \x1b[31m✗ Not allowed\x1b[0m (unknown)`);
    }
    break;
  }

  case "help":
  case "--help":
  case "-h":
    printUsage();
    break;

  default:
    if (command) {
      console.error(`Unknown command: ${command}`);
    }
    printUsage();
    process.exit(command ? 1 : 0);
}
