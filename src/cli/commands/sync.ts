import "reflect-metadata";
import { Arg, CliOnly, Command, Group, Option } from "../decorators.js";
import { readCloudCredentials } from "../../cloud-auth/storage.js";
import { createConsoleSyncBridge, getSyncStatusSummary, inspectSyncRecord, retryOutbox } from "../../sync/index.js";
import { getSyncRuntimeConfig } from "../../sync/config.js";
import { enqueueTraceExportBatch, pushTraceExportBatch } from "../../session-trace/cloud-trace-export.js";
import type { ConsoleSyncPullResult, ConsoleSyncPushResult } from "../../sync/console-bridge.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

@Group({
  name: "sync",
  description: "Local-first sync outbox, inbox, and Console bridge",
  scope: "open",
})
export class SyncCommands {
  @Command({ name: "status", description: "Show local sync status" })
  @CliOnly()
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const payload = buildStatusPayload();
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Sync: ${payload.linked ? "linked" : "unlinked"}`);
    console.log(`Runner: ${payload.runner.enabled ? "enabled" : `disabled (set ${payload.runner.env}=1)`}`);
    console.log(
      `Outbox pending: ${payload.outbox.pending} | failed: ${payload.outbox.failed} | dead: ${payload.outbox.dead}`,
    );
    console.log(
      `Inbox pending: ${payload.inbox.pending} | failed: ${payload.inbox.failed} | dead: ${payload.inbox.dead}`,
    );
    if (payload.lastError) console.log(`Last error: ${payload.lastError}`);
    return payload;
  }

  @Command({ name: "push", description: "Upload a bounded outbox batch to Console" })
  @CliOnly()
  async push(
    @Option({ flags: "--domain <domain>", description: "Filter one sync domain" }) domain?: string,
    @Option({ flags: "--project <project>", description: "Alias for --project-ref" }) project?: string,
    @Option({ flags: "--project-ref <projectRef>", description: "Console project ref" }) projectRef?: string,
    @Option({ flags: "--project-id <projectId>", description: "Console project id" }) projectId?: string,
    @Option({ flags: "--scope <scope>", description: "Sync scope (organization)" }) scope?: string,
    @Option({ flags: "--limit <n>", description: "Max events in batch" }) limitRaw?: string,
    @Option({ flags: "--max-bytes <n>", description: "Max payload bytes in batch" }) maxBytesRaw?: string,
    @Option({
      flags: "--traces",
      description: "Also enqueue and upload runtime trace export batches",
    })
    includeTraces?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const bridge = createConsoleSyncBridge();
    let trace: Awaited<ReturnType<typeof pushTraceExportBatch>> | null = null;
    if (includeTraces === true && readCloudCredentials()) {
      enqueueTraceExportBatch();
      trace = await pushTraceExportBatch({
        bridge,
        limit: parseIntOption(limitRaw),
        maxBytes: parseIntOption(maxBytesRaw),
      });
    }
    const result = await bridge.push({
      domain: clean(domain),
      project: clean(project),
      projectRef: clean(projectRef),
      projectId: clean(projectId),
      scope: parseScope(scope),
      limit: parseIntOption(limitRaw),
      maxBytes: parseIntOption(maxBytesRaw),
    });
    const payload = trace ? { ...result, trace } : result;
    if (asJson) printJson(payload);
    else printPushResult(result);
    return payload;
  }

  @Command({ name: "pull", description: "Download a bounded remote event batch from Console" })
  @CliOnly()
  async pull(
    @Option({ flags: "--domain <domain>", description: "Filter one sync domain" }) domain?: string,
    @Option({ flags: "--project <project>", description: "Alias for --project-ref" }) project?: string,
    @Option({ flags: "--project-ref <projectRef>", description: "Console project ref" }) projectRef?: string,
    @Option({ flags: "--project-id <projectId>", description: "Console project id" }) projectId?: string,
    @Option({ flags: "--scope <scope>", description: "Sync scope (organization)" }) scope?: string,
    @Option({ flags: "--limit <n>", description: "Max events in batch" }) limitRaw?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const bridge = createConsoleSyncBridge();
    const result = await bridge.pull({
      domain: clean(domain),
      project: clean(project),
      projectRef: clean(projectRef),
      projectId: clean(projectId),
      scope: parseScope(scope),
      limit: parseIntOption(limitRaw),
    });
    if (asJson) printJson(result);
    else printPullResult(result);
    return result;
  }

  @Command({ name: "retry", description: "Move failed sync outbox rows back to pending" })
  @CliOnly()
  retry(
    @Option({ flags: "--id <id>", description: "Retry one outbox id" }) id?: string,
    @Option({ flags: "--dead", description: "Also retry dead rows" }) includeDead?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const retried = retryOutbox({
      ids: clean(id) ? [clean(id)!] : undefined,
      includeDead: includeDead === true,
    });
    const payload = { success: true, retried };
    if (asJson) printJson(payload);
    else console.log(`Retried ${retried} sync outbox row(s).`);
    return payload;
  }

  @Command({ name: "inspect", description: "Inspect a sync outbox/inbox row by id" })
  @CliOnly()
  inspect(
    @Arg("id", { description: "sync_outbox or sync_inbox id" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = inspectSyncRecord(id);
    const payload = result ? { found: true, ...result } : { found: false, id };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (!result) {
      console.log(`Sync row not found: ${id}`);
      return payload;
    }
    console.log(`${result.kind}: ${result.record.id}`);
    console.log(`  domain: ${result.record.domain}`);
    console.log(`  type: ${result.record.eventType}`);
    console.log(`  status: ${result.record.status}`);
    return payload;
  }
}

function buildStatusPayload() {
  const credentials = readCloudCredentials();
  const summary = getSyncStatusSummary();
  const config = getSyncRuntimeConfig();
  const lastUpload = summary.cursors.find((cursor) => cursor.domain === "sync" && cursor.cursorKey === "last_upload");
  const lastDownload = summary.cursors.filter((cursor) => cursor.domain === "sync_remote").at(-1);
  return {
    linked: !!credentials,
    consoleUrl: credentials?.consoleUrl ?? null,
    installationId: credentials?.installationId ?? null,
    runner: {
      enabled: config.runnerEnabled,
      env: config.runnerEnabledEnv,
      pullDomains: config.pullDomains,
    },
    outbox: summary.outbox,
    inbox: summary.inbox,
    cursors: summary.cursors,
    lastUpload: lastUpload?.cursorValue ?? null,
    lastDownload: lastDownload?.cursorValue ?? null,
    lastError: summary.lastError,
  };
}

function printPushResult(result: ConsoleSyncPushResult): void {
  if (!result.linked) {
    console.log("Sync push skipped: not linked. Run `ravi login` to enable Console sync.");
    return;
  }
  console.log(
    `Sync push: ${result.status} | attempted ${result.attempted} | sent ${result.sent} | acked ${result.acked}`,
  );
  if (result.errorCode) console.log(`Error: ${result.errorCode}`);
}

function printPullResult(result: ConsoleSyncPullResult): void {
  if (!result.linked) {
    console.log("Sync pull skipped: not linked. Run `ravi login` to enable Console sync.");
    return;
  }
  console.log(`Sync pull: ${result.status} | downloaded ${result.downloaded} | applied ${result.applied}`);
  if (result.errorCode) console.log(`Error: ${result.errorCode}`);
}

function clean(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text || undefined;
}

function parseIntOption(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseScope(value: string | undefined): "organization" | undefined {
  const text = clean(value);
  if (!text) return undefined;
  return text === "organization" ? "organization" : undefined;
}
