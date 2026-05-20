/**
 * Inbox Commands - manage the local Console agent-inbox poller.
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
  listRecentItems,
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

@Group({
  name: "inbox",
  description: "Console agent-inbox bridge (poll Console → publish NATS)",
  scope: "open",
})
export class InboxCommands {
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
