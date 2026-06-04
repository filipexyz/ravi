/**
 * Inbox Commands - manage local inbox items and Console delivery compatibility.
 */

import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail } from "../context.js";
import { publish } from "../../nats.js";
import {
  INBOX_NATS_SUBJECT,
  getItemById,
  getItemByItemId,
  getStatusSnapshot,
  listLocalInboxItems,
  listLocalInboxSources,
  listRecentItems,
  markLocalInboxItem,
  readLocalInboxItem,
  runSingleTick,
  setEnabledForCurrentOrg,
} from "../../inbox/index.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function formatTimestamp(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toISOString();
}

function parseLocalInboxStatus(
  value: string | undefined,
): "open" | "seen" | "assigned" | "snoozed" | "done" | "archived" | "dismissed" | undefined {
  if (!value?.trim()) return undefined;
  if (
    value === "open" ||
    value === "seen" ||
    value === "assigned" ||
    value === "snoozed" ||
    value === "done" ||
    value === "archived" ||
    value === "dismissed"
  ) {
    return value;
  }
  fail("Invalid --status value");
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    fail(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function parseTimestamp(value: string | undefined, label: string): number {
  if (!value?.trim()) fail(`Missing ${label}`);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value as string);
  if (Number.isFinite(parsed)) return parsed;
  fail(`${label} must be a Unix ms timestamp or ISO date`);
}

@Group({
  name: "inbox",
  description: "Local Ravi inbox and Console delivery compatibility commands",
  scope: "open",
})
export class InboxCommands {
  @Command({ name: "list", description: "List local inbox items" })
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) status?: string,
    @Option({ flags: "--source <domain>", description: "Filter by source domain" }) sourceDomain?: string,
    @Option({ flags: "--include-archived", description: "Include done/archive/dismissed items" })
    includeArchived?: boolean,
    @Option({ flags: "--limit <n>", description: "Maximum items to return (default: 50, max: 500)" })
    limit?: string,
    @Option({ flags: "--offset <n>", description: "Items to skip before returning results" })
    offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const items = listLocalInboxItems({
      status: parseLocalInboxStatus(status),
      sourceDomain,
      includeArchived,
      limit: parsePositiveInteger(limit, "--limit"),
      offset: parseNonNegativeInteger(offset, "--offset"),
    });
    const payload = { items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (items.length === 0) {
      console.log("No local inbox items found.");
      return payload;
    }
    console.log(`\nInbox items: ${items.length}\n`);
    for (const item of items) {
      console.log(`  • ${item.title ?? item.id}`);
      console.log(`      id       : ${item.id}`);
      console.log(`      source   : ${item.sourceDomain}/${item.sourceType}`);
      console.log(`      status   : ${item.status}`);
      console.log(`      priority : ${item.priority}`);
      if (item.summary) console.log(`      summary  : ${item.summary}`);
      console.log("");
    }
    return payload;
  }

  @Command({ name: "read", description: "Read one local inbox item and mark it seen" })
  read(
    @Arg("item", { description: "Local inbox item id" }) itemId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = readLocalInboxItem(itemId);
    if (asJson) {
      printJson(result);
      return result;
    }
    console.log(`\n${result.item.title ?? result.item.id}\n`);
    console.log(`  id       : ${result.item.id}`);
    console.log(`  source   : ${result.item.sourceDomain}/${result.item.sourceType}`);
    console.log(`  sourceId : ${result.item.sourceId}`);
    console.log(`  status   : ${result.item.status}`);
    console.log(`  priority : ${result.item.priority}`);
    if (result.item.summary) console.log(`  summary  : ${result.item.summary}`);
    console.log(`  events   : ${result.events.length}`);
    console.log("");
    return result;
  }

  @Command({ name: "done", description: "Mark a local inbox item done" })
  done(
    @Arg("item", { description: "Local inbox item id" }) itemId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const item = markLocalInboxItem(itemId, "done");
    const payload = { item };
    if (asJson) printJson(payload);
    else console.log(`✓ Marked ${item.id} done.`);
    return payload;
  }

  @Command({ name: "snooze", description: "Snooze a local inbox item until a timestamp" })
  snooze(
    @Arg("item", { description: "Local inbox item id" }) itemId: string,
    @Option({ flags: "--until <time>", description: "Unix ms or ISO timestamp" }) until?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const snoozedUntil = parseTimestamp(until, "--until");
    const item = markLocalInboxItem(itemId, "snoozed", {
      snoozedUntil,
      payload: { snoozedUntil },
    });
    const payload = { item };
    if (asJson) printJson(payload);
    else console.log(`✓ Snoozed ${item.id} until ${formatTimestamp(item.snoozedUntil)}.`);
    return payload;
  }

  @Command({ name: "archive", description: "Archive a local inbox item" })
  archive(
    @Arg("item", { description: "Local inbox item id" }) itemId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const item = markLocalInboxItem(itemId, "archived");
    const payload = { item };
    if (asJson) printJson(payload);
    else console.log(`✓ Archived ${item.id}.`);
    return payload;
  }

  @Command({ name: "sources", description: "List local inbox source domains" })
  sources(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const sources = listLocalInboxSources();
    const payload = { sources };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (sources.length === 0) {
      console.log("No local inbox sources found.");
      return payload;
    }
    console.log("\nInbox sources:\n");
    for (const source of sources) {
      console.log(`  • ${source.sourceDomain}: ${source.open} open / ${source.count} total`);
    }
    console.log("");
    return payload;
  }

  @Command({ name: "status", description: "Show inbox poller status and subscriptions" })
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const snapshot = getStatusSnapshot();

    if (asJson) {
      printJson(snapshot);
      return snapshot;
    }

    console.log("\nInbox poller status:\n");
    console.log(`  credentials present : ${snapshot.credentialsPresent ? "yes" : "no"}`);
    console.log(`  console URL         : ${snapshot.consoleUrl ?? "—"}`);
    console.log(`  organization        : ${snapshot.organizationId ?? "—"}`);
    console.log(`  required scopes ok  : ${snapshot.scopesPresent ? "yes" : "no"}`);
    console.log("");

    if (snapshot.subscriptions.length === 0) {
      console.log("No local inbox subscriptions yet.");
      console.log("Run `ravi login` if you have not, then start the daemon.\n");
      return snapshot;
    }

    console.log("Subscriptions:\n");
    for (const sub of snapshot.subscriptions) {
      console.log(`  • ${sub.consoleUrl}  (org ${sub.organizationId})`);
      console.log(`      local id            : ${sub.id}`);
      console.log(`      remote subscription : ${sub.subscriptionId ?? "—"}`);
      console.log(`      enabled             : ${sub.enabled ? "yes" : "no"}`);
      console.log(`      status              : ${sub.status}`);
      console.log(`      cursor (sequence)   : ${sub.lastSequence ?? "—"}`);
      console.log(`      generation          : ${sub.lastGeneration ?? "—"}`);
      console.log(`      last poll           : ${formatTimestamp(sub.lastPollAt)}`);
      console.log(`      last success        : ${formatTimestamp(sub.lastSuccessAt)}`);
      if (sub.lastErrorCode) {
        console.log(`      last error          : ${sub.lastErrorCode} @ ${formatTimestamp(sub.lastErrorAt)}`);
      }
      console.log(`      pending             : ${sub.pending.undelivered} undelivered, ${sub.pending.unacked} unacked`);
      console.log("");
    }

    return snapshot;
  }

  @Command({ name: "enable", description: "Enable inbox polling for the current Console+org" })
  enable(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const result = setEnabledForCurrentOrg(true);
    const payload = { enabled: true, changed: result.changed };
    if (asJson) printJson(payload);
    else console.log(result.changed ? "✓ Inbox polling enabled." : "Inbox polling was already enabled.");
    return payload;
  }

  @Command({ name: "disable", description: "Disable inbox polling for the current Console+org" })
  disable(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const result = setEnabledForCurrentOrg(false);
    const payload = { enabled: false, changed: result.changed };
    if (asJson) printJson(payload);
    else console.log(result.changed ? "✓ Inbox polling disabled." : "Inbox polling was already disabled.");
    return payload;
  }

  @Command({ name: "poll", description: "Run a single inbox poll cycle (foreground)" })
  async poll(
    @Option({ flags: "--once", description: "Run one cycle and exit (default)" }) _once?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    try {
      await runSingleTick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`Inbox poll failed: ${message}`);
      return;
    }
    const snapshot = getStatusSnapshot();
    if (asJson) printJson({ ok: true, snapshot });
    else console.log("✓ Inbox poll cycle completed.");
    return { ok: true, snapshot };
  }

  @Command({ name: "items", description: "List recently delivered inbox items in the local mirror" })
  items(
    @Option({ flags: "--limit <n>", description: "Maximum items to return (default: 25, max: 500)" })
    limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsedLimit = limit ? Number(limit) : undefined;
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      fail("--limit must be a positive integer");
      return;
    }
    const items = listRecentItems({ limit: parsedLimit });
    const payload = { total: items.length, items };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (items.length === 0) {
      console.log("No inbox items stored locally yet.");
      return payload;
    }
    console.log(`\nLast ${items.length} inbox items:\n`);
    for (const item of items) {
      console.log(`  • [#${item.sequence}] ${item.eventType} (${item.category}/${item.severity})`);
      console.log(`      itemId      : ${item.itemId}`);
      console.log(`      delivered   : ${formatTimestamp(item.deliveredAt)}`);
      console.log(`      acked       : ${formatTimestamp(item.ackedAt)}`);
      console.log(`      replayCount : ${item.replayCount}`);
      console.log("");
    }
    return payload;
  }

  @Command({ name: "replay", description: "Republish a locally stored inbox item to NATS" })
  async replay(
    @Arg("ref", { description: "Local row id (number) or remote item id (uuid)" }) ref: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!ref) {
      fail("replay requires an item reference");
      return;
    }

    let row = /^\d+$/.test(ref) ? getItemById(Number(ref)) : null;
    if (!row) {
      const snapshot = getStatusSnapshot();
      const target = snapshot.subscriptions[0];
      if (target) {
        row = getItemByItemId(target.consoleUrl, target.organizationId, ref);
      }
    }

    if (!row) {
      fail(`No inbox item found for ref ${ref}`);
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.natsPayloadJson) as Record<string, unknown>;
    } catch (error) {
      fail(`Stored NATS payload is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const replayedAt = new Date().toISOString();
    const delivery = (payload.delivery as Record<string, unknown> | undefined) ?? {};
    payload.delivery = {
      ...delivery,
      replayed: true,
      replayCount: row.replayCount + 1,
      replayedAt,
    };

    await publish(row.natsSubject || INBOX_NATS_SUBJECT, payload);

    const result = {
      ok: true,
      itemId: row.itemId,
      sequence: row.sequence,
      subject: row.natsSubject || INBOX_NATS_SUBJECT,
      replayedAt,
    };
    if (asJson) printJson(result);
    else console.log(`✓ Replayed item ${row.itemId} on subject ${result.subject}.`);
    return result;
  }
}
