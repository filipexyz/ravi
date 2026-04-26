import "reflect-metadata";
import { readFileSync } from "node:fs";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { createArtifact } from "../../artifacts/store.js";
import {
  createDevinClientFromEnv,
  getDefaultMaxAcuLimit,
  type CreateDevinSessionInput,
  type DevinClient,
  type DevinSession,
} from "../../devin/client.js";
import {
  getDevinSession,
  listDevinAttachments,
  listDevinMessages,
  listDevinSessions,
  upsertDevinAttachments,
  upsertDevinMessages,
  upsertDevinSession,
  type DevinSessionRecord,
  type StoredDevinAttachment,
  type StoredDevinMessage,
} from "../../devin/store.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function parsePositiveInteger(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer.`);
  return parsed;
}

function parseStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseJsonObject(value: string | undefined, label: string): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(`${label} must be a JSON object.`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message.endsWith("must be a JSON object.")) throw error;
    fail(`${label} must be valid JSON.`);
  }
}

function readPrompt(prompt?: string, promptFile?: string): string {
  if (prompt?.trim() && promptFile?.trim()) fail("Use either --prompt or --prompt-file, not both.");
  if (prompt?.trim()) return prompt;
  if (promptFile?.trim()) return readFileSync(promptFile, "utf8");
  fail("--prompt or --prompt-file is required.");
}

function rawFlagPresent(flag: string): boolean {
  return process.argv.includes(flag);
}

function formatTime(value: number | undefined): string {
  if (!value) return "-";
  const ms = value > 10_000_000_000 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function summarizeSession(session: DevinSessionRecord | DevinSession): Record<string, unknown> {
  const isLocal = "devinId" in session;
  if (isLocal) {
    return {
      id: session.id,
      devinId: session.devinId,
      title: session.title ?? null,
      status: session.status,
      statusDetail: session.statusDetail ?? null,
      url: session.url,
      tags: session.tags,
      originType: session.originType ?? null,
      originId: session.originId ?? null,
      taskId: session.taskId ?? null,
      projectId: session.projectId ?? null,
      proxRunId: session.proxRunId ?? null,
      lastSyncedAt: session.lastSyncedAt ?? null,
      updatedAt: session.updatedAt,
    };
  }

  return {
    devinId: session.session_id,
    title: session.title ?? null,
    status: session.status,
    statusDetail: session.status_detail ?? null,
    url: session.url,
    tags: session.tags ?? [],
    isArchived: session.is_archived ?? false,
    acusConsumed: session.acus_consumed,
    updatedAt: session.updated_at,
  };
}

function printSession(session: DevinSessionRecord | DevinSession): void {
  const summary = summarizeSession(session);
  console.log(`${summary.devinId} — ${summary.status}${summary.statusDetail ? `/${summary.statusDetail}` : ""}`);
  if (summary.title) console.log(`  Title: ${summary.title}`);
  if (summary.url) console.log(`  URL: ${summary.url}`);
  if (Array.isArray(summary.tags) && summary.tags.length > 0) console.log(`  Tags: ${summary.tags.join(", ")}`);
  if ("lastSyncedAt" in summary && summary.lastSyncedAt)
    console.log(`  Last sync: ${formatTime(summary.lastSyncedAt as number)}`);
}

function contextDefaults(): {
  originSessionName?: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
  chatId?: string;
} {
  const ctx = getContext();
  return {
    ...(ctx?.sessionName ? { originSessionName: ctx.sessionName } : {}),
    ...(ctx?.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx?.source?.channel ? { channel: ctx.source.channel } : {}),
    ...(ctx?.source?.accountId ? { accountId: ctx.source.accountId } : {}),
    ...(ctx?.source?.chatId ? { chatId: ctx.source.chatId } : {}),
  };
}

function resolveOrigin(options: { taskId?: string; projectId?: string; proxRunId?: string }): {
  originType: string;
  originId?: string;
} {
  if (options.taskId?.trim()) return { originType: "task", originId: options.taskId.trim() };
  if (options.projectId?.trim()) return { originType: "project", originId: options.projectId.trim() };
  if (options.proxRunId?.trim()) return { originType: "prox_run", originId: options.proxRunId.trim() };
  return { originType: "cli" };
}

function resolveDevinId(identifier: string): string {
  const stored = getDevinSession(identifier);
  if (stored) return stored.devinId;
  if (identifier.startsWith("devin-")) return identifier;
  fail(`Unknown Devin session: ${identifier}`);
}

function determineMaxAcuLimit(explicitValue?: string): {
  maxAcuLimit?: number;
  source: "explicit" | "env" | "omitted";
} {
  const explicit = parsePositiveInteger(explicitValue, "--max-acu");
  const omit = rawFlagPresent("--no-max-acu-limit") || rawFlagPresent("--omit-max-acu-limit");
  if (explicit !== undefined && omit) fail("Use either --max-acu or --no-max-acu-limit, not both.");
  if (explicit !== undefined) return { maxAcuLimit: explicit, source: "explicit" };
  if (omit) return { source: "omitted" };
  const configured = getDefaultMaxAcuLimit();
  if (configured !== undefined) return { maxAcuLimit: configured, source: "env" };
  fail("DEVIN_DEFAULT_MAX_ACU_LIMIT is not configured. Use --max-acu <n> or --no-max-acu-limit explicitly.");
}

async function syncDevinSession(
  client: DevinClient,
  identifier: string,
  options: {
    syncMessages?: boolean;
    syncAttachments?: boolean;
    createArtifacts?: boolean;
  } = {},
): Promise<{
  session: DevinSessionRecord;
  messages: StoredDevinMessage[];
  attachments: StoredDevinAttachment[];
  artifacts: string[];
}> {
  const devinId = resolveDevinId(identifier);
  const remote = await client.getSession(devinId);
  const session = upsertDevinSession(remote, { lastSyncedAt: Date.now() });
  const remoteMessages = options.syncMessages === false ? [] : await client.listAllMessages(devinId);
  const messages =
    options.syncMessages === false ? listDevinMessages(devinId) : upsertDevinMessages(devinId, remoteMessages);
  const remoteAttachments = options.syncAttachments === false ? [] : await client.listAttachments(devinId);
  const attachments =
    options.syncAttachments === false
      ? listDevinAttachments(devinId)
      : upsertDevinAttachments(devinId, remoteAttachments);
  const artifactIds: string[] = [];

  if (options.createArtifacts) {
    const ctx = contextDefaults();
    const artifact = createArtifact({
      kind: "devin.session",
      title: session.title ?? `Devin ${session.devinId}`,
      summary: `${session.status}${session.statusDetail ? `/${session.statusDetail}` : ""}`,
      uri: session.url,
      provider: "devin",
      command: "ravi devin sessions sync",
      ...(ctx.originSessionName ? { sessionName: ctx.originSessionName } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(session.taskId ? { taskId: session.taskId } : {}),
      ...(ctx.channel ? { channel: ctx.channel } : {}),
      ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
      ...(ctx.chatId ? { chatId: ctx.chatId } : {}),
      metadata: {
        devinId: session.devinId,
        localId: session.id,
        status: session.status,
        statusDetail: session.statusDetail ?? null,
        originType: session.originType ?? null,
        originId: session.originId ?? null,
      },
      lineage: {
        source: "ravi devin sessions sync",
        provider: "devin",
        devinId: session.devinId,
      },
      output: {
        session,
        messages,
        attachments,
      },
      tags: ["devin", "session", ...session.tags],
    });
    artifactIds.push(artifact.id);
  }

  return { session, messages, attachments, artifacts: artifactIds };
}

@Group({
  name: "devin.auth",
  description: "Devin authentication tools",
  scope: "open",
})
export class DevinAuthCommands {
  @Command({ name: "check", description: "Validate Devin API credentials" })
  async check(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const client = createDevinClientFromEnv();
    const self = await client.self();
    const payload = {
      ok: true,
      baseUrl: client.baseUrl,
      configuredOrgId: client.orgId,
      self: {
        principalType: self.principal_type ?? null,
        serviceUserId: self.service_user_id ?? null,
        serviceUserName: self.service_user_name ?? null,
        orgId: self.org_id ?? null,
      },
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log("Devin auth OK");
      console.log(`  org: ${payload.self.orgId ?? payload.configuredOrgId}`);
      if (payload.self.serviceUserName) console.log(`  service user: ${payload.self.serviceUserName}`);
      if (payload.self.serviceUserId) console.log(`  service user id: ${payload.self.serviceUserId}`);
    }
    return payload;
  }
}

@Group({
  name: "devin.sessions",
  description: "Devin remote session control plane",
  scope: "open",
})
export class DevinSessionCommands {
  @Command({ name: "create", description: "Create a Devin session" })
  async create(
    @Option({ flags: "--prompt <text>", description: "Prompt for Devin" }) prompt?: string,
    @Option({ flags: "--prompt-file <path>", description: "Read prompt from file" }) promptFile?: string,
    @Option({ flags: "--title <text>", description: "Session title" }) title?: string,
    @Option({ flags: "--tag <tag...>", description: "Tags; can be repeated or comma-separated" }) tags?: string[],
    @Option({ flags: "--repo <repo...>", description: "Repos; can be repeated or comma-separated" }) repos?: string[],
    @Option({ flags: "--attachment-url <url...>", description: "Attachment URLs" }) attachmentUrls?: string[],
    @Option({ flags: "--knowledge <id...>", description: "Knowledge note IDs" }) knowledgeIds?: string[],
    @Option({ flags: "--secret <id...>", description: "Secret IDs" }) secretIds?: string[],
    @Option({ flags: "--session-link <id...>", description: "Linked Devin sessions" }) sessionLinks?: string[],
    @Option({ flags: "--playbook <id>", description: "Playbook ID" }) playbookId?: string,
    @Option({ flags: "--child-playbook <id>", description: "Child playbook ID" }) childPlaybookId?: string,
    @Option({ flags: "--advanced-mode <mode>", description: "analyze|create|improve|batch|manage" })
    advancedMode?: string,
    @Option({ flags: "--max-acu <n>", description: "Per-session max ACU ceiling" }) maxAcu?: string,
    @Option({ flags: "--no-max-acu-limit", description: "Intentionally omit max_acu_limit" }) _noMaxAcuLimit?: boolean,
    @Option({ flags: "--bypass-approval", description: "Request bypass_approval=true" }) bypassApproval?: boolean,
    @Option({ flags: "--as-user <id>", description: "create_as_user_id" }) createAsUserId?: string,
    @Option({ flags: "--structured-output-schema <json>", description: "JSON schema for structured output" })
    structuredOutputSchema?: string,
    @Option({ flags: "--task <id>", description: "Link to Ravi task" }) taskId?: string,
    @Option({ flags: "--project <id>", description: "Link to Ravi project" }) projectId?: string,
    @Option({ flags: "--prox-run <id>", description: "Link to prox run" }) proxRunId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const client = createDevinClientFromEnv();
    const text = readPrompt(prompt, promptFile).trim();
    if (!text) fail("Prompt is empty.");
    const acu = determineMaxAcuLimit(maxAcu);
    const defaultTags = parseStringList(process.env.DEVIN_DEFAULT_TAGS);
    const tagList = [...new Set(["ravi", ...defaultTags, ...parseStringList(tags)])].sort();
    const input: CreateDevinSessionInput = {
      prompt: text,
      ...(title?.trim() ? { title: title.trim() } : {}),
      ...(tagList.length ? { tags: tagList } : {}),
      ...(advancedMode?.trim() ? { advanced_mode: advancedMode.trim() } : {}),
      ...(parseStringList(attachmentUrls).length ? { attachment_urls: parseStringList(attachmentUrls) } : {}),
      ...(bypassApproval === true ? { bypass_approval: true } : {}),
      ...(childPlaybookId?.trim() ? { child_playbook_id: childPlaybookId.trim() } : {}),
      ...(createAsUserId?.trim() ? { create_as_user_id: createAsUserId.trim() } : {}),
      ...(parseStringList(knowledgeIds).length ? { knowledge_ids: parseStringList(knowledgeIds) } : {}),
      ...(acu.maxAcuLimit !== undefined ? { max_acu_limit: acu.maxAcuLimit } : {}),
      ...(playbookId?.trim() ? { playbook_id: playbookId.trim() } : {}),
      ...(parseStringList(repos).length ? { repos: parseStringList(repos) } : {}),
      ...(parseStringList(secretIds).length ? { secret_ids: parseStringList(secretIds) } : {}),
      ...(parseStringList(sessionLinks).length ? { session_links: parseStringList(sessionLinks) } : {}),
      ...(structuredOutputSchema
        ? { structured_output_schema: parseJsonObject(structuredOutputSchema, "--structured-output-schema") }
        : {}),
    };
    const startedAt = Date.now();
    const remote = await client.createSession(input);
    const origin = resolveOrigin({ taskId, projectId, proxRunId });
    const ctx = contextDefaults();
    const stored = upsertDevinSession(remote, {
      ...origin,
      ...(ctx.originSessionName ? { originSessionName: ctx.originSessionName } : {}),
      ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
      ...(taskId?.trim() ? { taskId: taskId.trim() } : {}),
      ...(projectId?.trim() ? { projectId: projectId.trim() } : {}),
      ...(proxRunId?.trim() ? { proxRunId: proxRunId.trim() } : {}),
      metadata: {
        maxAcuLimitSource: acu.source,
        ...(acu.maxAcuLimit !== undefined ? { maxAcuLimit: acu.maxAcuLimit } : {}),
        durationMs: Date.now() - startedAt,
      },
      lastSyncedAt: Date.now(),
    });
    const payload = {
      status: "created",
      maxAcuLimitSource: acu.source,
      maxAcuLimit: acu.maxAcuLimit ?? null,
      session: summarizeSession(stored),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log("Devin session created");
      printSession(stored);
      console.log(`  Max ACU: ${acu.maxAcuLimit ?? "omitted"} (${acu.source})`);
    }
    return payload;
  }

  @Command({ name: "list", description: "List local or remote Devin sessions" })
  async list(
    @Option({ flags: "--remote", description: "Fetch remote sessions and update local cache" }) remote?: boolean,
    @Option({ flags: "--status <status>", description: "Filter local sessions by status" }) status?: string,
    @Option({ flags: "--tag <tag>", description: "Filter sessions by tag" }) tag?: string,
    @Option({ flags: "--limit <n>", description: "Max sessions to show (default: 20)" }) limit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const max = parsePositiveInteger(limit, "--limit") ?? 20;
    if (remote) {
      const client = createDevinClientFromEnv();
      const page = await client.listSessions({
        first: Math.min(max, 200),
        tags: tag?.trim() ? [tag.trim()] : undefined,
      });
      const sessions = page.items.map((item) => upsertDevinSession(item, { lastSyncedAt: Date.now() }));
      const payload = {
        source: "remote",
        total: page.total ?? sessions.length,
        hasNextPage: page.has_next_page ?? false,
        sessions: sessions.map(summarizeSession),
      };
      if (asJson) {
        printJson(payload);
      } else {
        for (const session of sessions) printSession(session);
      }
      return payload;
    }

    const sessions = listDevinSessions({ status, tag, limit: max });
    const payload = { source: "local", total: sessions.length, sessions: sessions.map(summarizeSession) };
    if (asJson) {
      printJson(payload);
    } else if (sessions.length === 0) {
      console.log("No local Devin sessions found.");
    } else {
      for (const session of sessions) printSession(session);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one Devin session" })
  async show(
    @Arg("session", { description: "Local id or devin-* id" }) identifier: string,
    @Option({ flags: "--sync", description: "Fetch latest remote state first" }) sync?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    let session = getDevinSession(identifier);
    if (sync || (!session && identifier.startsWith("devin-"))) {
      const client = createDevinClientFromEnv();
      session = upsertDevinSession(await client.getSession(resolveDevinId(identifier)), { lastSyncedAt: Date.now() });
    }
    if (!session) fail(`Unknown Devin session: ${identifier}`);
    const payload = { session };
    if (asJson) {
      printJson(payload);
    } else {
      printSession(session);
      if (session.pullRequests.length > 0) {
        console.log("  Pull requests:");
        for (const pr of session.pullRequests)
          console.log(`  - ${String(pr.pr_state ?? "-")}: ${String(pr.pr_url ?? "-")}`);
      }
    }
    return payload;
  }

  @Command({ name: "messages", description: "List and cache session messages" })
  async messages(
    @Arg("session", { description: "Local id or devin-* id" }) identifier: string,
    @Option({ flags: "--cached", description: "Use local cache only" }) cached?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const devinId = resolveDevinId(identifier);
    const messages = cached
      ? listDevinMessages(devinId)
      : upsertDevinMessages(devinId, await createDevinClientFromEnv().listAllMessages(devinId));
    const payload = { devinId, total: messages.length, messages };
    if (asJson) {
      printJson(payload);
    } else if (messages.length === 0) {
      console.log("No messages found.");
    } else {
      for (const message of messages) {
        console.log(`[${formatTime(message.createdAt)}] ${message.source}: ${message.message}`);
      }
    }
    return payload;
  }

  @Command({ name: "send", description: "Send a message to a Devin session" })
  async send(
    @Arg("session", { description: "Local id or devin-* id" }) identifier: string,
    @Arg("message", { description: "Message text" }) message: string,
    @Option({ flags: "--as-user <id>", description: "message_as_user_id" }) messageAsUserId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!message.trim()) fail("Message is empty.");
    const client = createDevinClientFromEnv();
    const remote = await client.sendMessage(resolveDevinId(identifier), message, messageAsUserId?.trim());
    const session = upsertDevinSession(remote, { lastSyncedAt: Date.now() });
    const payload = { status: "sent", session: summarizeSession(session) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log("Message sent to Devin session");
      printSession(session);
    }
    return payload;
  }

  @Command({ name: "attachments", description: "List and cache session attachments" })
  async attachments(
    @Arg("session", { description: "Local id or devin-* id" }) identifier: string,
    @Option({ flags: "--cached", description: "Use local cache only" }) cached?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const devinId = resolveDevinId(identifier);
    const attachments = cached
      ? listDevinAttachments(devinId)
      : upsertDevinAttachments(devinId, await createDevinClientFromEnv().listAttachments(devinId));
    const payload = { devinId, total: attachments.length, attachments };
    if (asJson) {
      printJson(payload);
    } else if (attachments.length === 0) {
      console.log("No attachments found.");
    } else {
      for (const attachment of attachments) {
        console.log(`${attachment.attachmentId} — ${attachment.name} — ${attachment.url}`);
      }
    }
    return payload;
  }

  @Command({ name: "sync", description: "Sync session status, messages and attachments" })
  async sync(
    @Arg("session", { description: "Local id or devin-* id" }) identifier: string,
    @Option({ flags: "--artifacts", description: "Register a sync artifact" }) artifacts?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const result = await syncDevinSession(createDevinClientFromEnv(), identifier, {
      createArtifacts: artifacts === true,
    });
    const payload = {
      session: summarizeSession(result.session),
      messages: result.messages.length,
      attachments: result.attachments.length,
      artifacts: result.artifacts,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log("Devin session synced");
      printSession(result.session);
      console.log(`  Messages: ${result.messages.length}`);
      console.log(`  Attachments: ${result.attachments.length}`);
      if (result.artifacts.length) console.log(`  Artifacts: ${result.artifacts.join(", ")}`);
    }
    return payload;
  }

  @Command({ name: "terminate", description: "Terminate a Devin session" })
  async terminate(
    @Arg("session", { description: "Local id or devin-* id" }) identifier: string,
    @Option({ flags: "--archive", description: "Archive after terminating" }) archive?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const client = createDevinClientFromEnv();
    const remote = await client.terminateSession(resolveDevinId(identifier), { archive: archive === true });
    const session = upsertDevinSession(remote, { lastSyncedAt: Date.now() });
    const payload = { status: "terminated", archive: archive === true, session: summarizeSession(session) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log("Devin session terminated");
      printSession(session);
    }
    return payload;
  }

  @Command({ name: "archive", description: "Archive a Devin session" })
  async archive(
    @Arg("session", { description: "Local id or devin-* id" }) identifier: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const client = createDevinClientFromEnv();
    const remote = await client.archiveSession(resolveDevinId(identifier));
    const session = upsertDevinSession(remote, { lastSyncedAt: Date.now() });
    const payload = { status: "archived", session: summarizeSession(session) };
    if (asJson) {
      printJson(payload);
    } else {
      console.log("Devin session archived");
      printSession(session);
    }
    return payload;
  }
}
