import "reflect-metadata";
import { Arg, Command, Group, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, parseCliListLimit, parseCliListOffset } from "../pagination.js";
import {
  addThreadEntry,
  buildThreadBrief,
  createThread,
  formatThreadPointer,
  listThreadEntries,
  listThreadLinks,
  listThreads,
  normalizeThreadSlug,
  parseThreadPointer,
  resolveThread,
  updateThreadStatus,
  upsertThreadLink,
  type ThreadActor,
  type ThreadEntryKind,
  type ThreadRecord,
} from "../../threads/index.js";
import {
  threadActionReturnSchema,
  threadBriefReturnSchema,
  threadEntriesReturnSchema,
  threadEntryReturnSchema,
  threadLinkReturnSchema,
  threadListReturnSchema,
  threadShowReturnSchema,
} from "./operational-return-schemas.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function actorFromContext(): ThreadActor {
  const ctx = getContext();
  return {
    type: ctx?.sessionKey ? "session" : ctx?.agentId ? "agent" : "cli",
    id: ctx?.sessionKey ?? ctx?.agentId ?? "cli",
    agentId: ctx?.agentId,
    sessionKey: ctx?.sessionKey,
    sessionName: ctx?.sessionName,
    contextId: ctx?.contextId,
  };
}

function threadToJson(thread: ThreadRecord): Record<string, unknown> {
  return {
    id: thread.id,
    slug: thread.slug ?? null,
    title: thread.title,
    summary: thread.summary ?? null,
    status: thread.status,
    owner: { type: thread.ownerType, id: thread.ownerId ?? null },
    scope: { type: thread.scopeType, id: thread.scopeId ?? null },
    defaultAgentId: thread.defaultAgentId ?? null,
    defaultChatId: thread.defaultChatId ?? null,
    defaultContactId: thread.defaultContactId ?? null,
    currentAssignee:
      thread.currentAssigneeType || thread.currentAssigneeId
        ? { type: thread.currentAssigneeType ?? null, id: thread.currentAssigneeId ?? null }
        : null,
    closedReason: thread.closedReason ?? null,
    closedAt: thread.closedAt ?? null,
    metadata: thread.metadata ?? null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    lastEntryAt: thread.lastEntryAt ?? null,
    lastHandoffAt: thread.lastHandoffAt ?? null,
  };
}

function parsePointerOption(value: string | undefined, label: string) {
  try {
    return value ? parseThreadPointer(value) : undefined;
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveThreadForCli(ref: string, scope?: string): ThreadRecord {
  try {
    return resolveThread(ref, { scope: parsePointerOption(scope, "--scope") });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function printThreadList(items: ThreadRecord[], total: number): void {
  console.log(`⚡ Threads (${total})`);
  if (items.length === 0) {
    console.log("No threads found.");
    return;
  }
  items.forEach((thread, index) => {
    console.log(`${numberEmoji(index + 1)} ${thread.title}`);
    console.log(`   📋 ${thread.slug ?? thread.id} | ${thread.status}`);
    console.log(
      `   🔹 scope=${thread.scopeType}${thread.scopeId ? `:${thread.scopeId}` : ""} | updated=${formatDate(thread.updatedAt)}`,
    );
  });
}

function numberEmoji(value: number): string {
  const digits = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
  return String(value)
    .split("")
    .map((digit) => digits[Number(digit)] ?? digit)
    .join("");
}

function formatDate(value: number): string {
  return new Date(value).toISOString();
}

@Group({
  name: "threads",
  description: "Manage Ravi threads",
  scope: "open",
})
export class ThreadCommands {
  @Command({ name: "create", description: "Create a Ravi-owned thread" })
  @Returns(threadActionReturnSchema)
  create(
    @Arg("slug", { description: "Thread slug" }) slug: string,
    @Option({ flags: "--title <title>", description: "Thread title" }) title?: string,
    @Option({ flags: "--summary <summary>", description: "Initial thread summary" }) summary?: string,
    @Option({ flags: "--status <status>", description: "Initial status" }) status?: string,
    @Option({ flags: "--scope <type:id>", description: "Scope pointer, e.g. chat:<id> or session:<key>" })
    scope?: string,
    @Option({ flags: "--owner <type:id>", description: "Owner pointer" }) owner?: string,
    @Option({ flags: "--default-agent <id>", description: "Default agent id" }) defaultAgentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!title?.trim()) fail("--title is required.");
    const thread = createThread({
      slug: normalizeThreadSlug(slug),
      title,
      summary,
      status,
      scope: parsePointerOption(scope, "--scope"),
      owner: parsePointerOption(owner, "--owner"),
      defaultAgentId,
      currentAssignee: defaultAgentId ? { type: "agent", id: defaultAgentId } : undefined,
      metadata: { createdVia: "ravi threads create" },
    });
    const payload = { action: "create", thread: threadToJson(thread) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✅ Thread created: ${thread.slug ?? thread.id}`);
    return payload;
  }

  @Command({ name: "list", description: "List Ravi threads" })
  @Returns(threadListReturnSchema)
  list(
    @Option({ flags: "--status <status>", description: "Filter by status" }) status?: string,
    @Option({ flags: "--scope <type:id>", description: "Filter by scope" }) scope?: string,
    @Option({ flags: "--owner <type:id>", description: "Filter by owner" }) owner?: string,
    @Option({ flags: "--search <text>", description: "Search title, slug, or summary" }) search?: string,
    @Option({ flags: "--limit <n>", description: "Page size" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Page offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const parsedLimit = parseCliListLimit(limit);
    const parsedOffset = parseCliListOffset(offset);
    const result = listThreads({
      status,
      scope: parsePointerOption(scope, "--scope"),
      owner: parsePointerOption(owner, "--owner"),
      search,
      limit: parsedLimit,
      offset: parsedOffset,
    });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "threads", "list"],
      limit: result.limit,
      offset: result.offset,
      returned: result.items.length,
      total: result.total,
      options: ["--status", status, "--scope", scope, "--owner", owner, "--search", search],
    });
    const payload = {
      action: "list",
      items: result.items.map(threadToJson),
      pagination,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printThreadList(result.items, result.total);
    return payload;
  }

  @Command({ name: "show", description: "Show one thread with links and recent entries" })
  @Returns(threadShowReturnSchema)
  show(
    @Arg("thread", { description: "Thread id or slug" }) threadRef: string,
    @Option({ flags: "--scope <type:id>", description: "Scope when resolving a slug" }) scope?: string,
    @Option({ flags: "--entries <n>", description: "Number of entries to include" }) entriesLimit?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const thread = resolveThreadForCli(threadRef, scope);
    const entries = listThreadEntries(thread.id, {
      limit: parseCliListLimit(entriesLimit, { defaultLimit: 20, maxLimit: 100 }),
      order: "asc",
    });
    const links = listThreadLinks(thread.id);
    const payload = {
      action: "show",
      thread: threadToJson(thread),
      entries,
      links,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`⚡ ${thread.title}`);
    console.log(`📋 ${thread.slug ?? thread.id} | ${thread.status}`);
    console.log(`🔹 scope=${thread.scopeType}${thread.scopeId ? `:${thread.scopeId}` : ""}`);
    if (thread.summary) console.log(`📝 ${thread.summary}`);
    console.log(`\nLinks: ${links.length}`);
    for (const link of links) {
      console.log(`- ${link.role} ${link.targetType}:${link.targetId}${link.label ? ` (${link.label})` : ""}`);
    }
    console.log(`\nEntries: ${entries.length}`);
    for (const entry of entries) {
      console.log(`- [${entry.kind}] ${entry.actorName ?? entry.actorSessionName ?? entry.actorType}: ${entry.body}`);
    }
    return payload;
  }

  @Command({ name: "comment", description: "Append a comment to a thread" })
  @Returns(threadEntryReturnSchema)
  comment(
    @Arg("thread", { description: "Thread id or slug" }) threadRef: string,
    @Arg("body", { description: "Comment body" }) body: string,
    @Option({ flags: "--scope <type:id>", description: "Scope when resolving a slug" }) scope?: string,
    @Option({ flags: "--visibility <visibility>", description: "default|internal|private|restricted" })
    visibility?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.addEntry("comment", threadRef, body, scope, visibility, asJson);
  }

  @Command({ name: "note", description: "Append a note to a thread" })
  @Returns(threadEntryReturnSchema)
  note(
    @Arg("thread", { description: "Thread id or slug" }) threadRef: string,
    @Arg("body", { description: "Note body" }) body: string,
    @Option({ flags: "--scope <type:id>", description: "Scope when resolving a slug" }) scope?: string,
    @Option({ flags: "--visibility <visibility>", description: "default|internal|private|restricted" })
    visibility?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    return this.addEntry("note", threadRef, body, scope, visibility, asJson);
  }

  @Command({ name: "link", description: "Link a thread to another Ravi object" })
  @Returns(threadLinkReturnSchema)
  link(
    @Arg("thread", { description: "Thread id or slug" }) threadRef: string,
    @Arg("target", { description: "Target pointer, e.g. chat:<id>" }) target: string,
    @Option({ flags: "--scope <type:id>", description: "Scope when resolving a slug" }) scope?: string,
    @Option({ flags: "--role <role>", description: "Link role" }) role?: string,
    @Option({ flags: "--label <label>", description: "Display label" }) label?: string,
    @Option({ flags: "--visibility <visibility>", description: "default|internal|private|restricted" })
    visibility?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const thread = resolveThreadForCli(threadRef, scope);
    const link = upsertThreadLink({
      threadId: thread.id,
      target: parseThreadPointer(target),
      role,
      label,
      visibility,
      metadata: { createdVia: "ravi threads link" },
    });
    const payload = { action: "link", thread: threadToJson(thread), link };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      `✅ Linked ${thread.slug ?? thread.id} -> ${formatThreadPointer({ type: link.targetType, id: link.targetId })}`,
    );
    return payload;
  }

  @Command({ name: "entries", description: "List thread entries" })
  @Returns(threadEntriesReturnSchema)
  entries(
    @Arg("thread", { description: "Thread id or slug" }) threadRef: string,
    @Option({ flags: "--scope <type:id>", description: "Scope when resolving a slug" }) scope?: string,
    @Option({ flags: "--limit <n>", description: "Page size" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Page offset" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const thread = resolveThreadForCli(threadRef, scope);
    const entries = listThreadEntries(thread.id, {
      limit: parseCliListLimit(limit, { defaultLimit: 50, maxLimit: 200 }),
      offset: parseCliListOffset(offset),
      order: "desc",
    });
    const payload = { action: "entries", thread: threadToJson(thread), entries };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`⚡ Entries (${entries.length})`);
    for (const entry of entries) {
      console.log(`${formatDate(entry.createdAt)} [${entry.kind}] ${entry.body}`);
    }
    return payload;
  }

  @Command({ name: "brief", description: "Render the bounded thread brief used for handoff" })
  @Returns(threadBriefReturnSchema)
  brief(
    @Arg("thread", { description: "Thread id or slug" }) threadRef: string,
    @Option({ flags: "--scope <type:id>", description: "Scope when resolving a slug" }) scope?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const thread = resolveThreadForCli(threadRef, scope);
    const brief = buildThreadBrief(thread.id);
    const payload = { action: "brief", thread: threadToJson(thread), brief };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(brief.text);
    return payload;
  }

  @Command({ name: "close", description: "Close a thread" })
  @Returns(threadActionReturnSchema)
  close(
    @Arg("thread", { description: "Thread id or slug" }) threadRef: string,
    @Option({ flags: "--scope <type:id>", description: "Scope when resolving a slug" }) scope?: string,
    @Option({ flags: "--reason <reason>", description: "Closure reason" }) reason?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const thread = resolveThreadForCli(threadRef, scope);
    const updated = updateThreadStatus(thread.id, "closed", { reason });
    const payload = { action: "close", thread: threadToJson(updated) };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✅ Thread closed: ${updated.slug ?? updated.id}`);
    return payload;
  }

  private addEntry(
    kind: ThreadEntryKind,
    threadRef: string,
    body: string,
    scope?: string,
    visibility?: string,
    asJson?: boolean,
  ) {
    const thread = resolveThreadForCli(threadRef, scope);
    const entry = addThreadEntry({
      threadId: thread.id,
      kind,
      body,
      actor: actorFromContext(),
      sourceType: "cli",
      visibility,
      metadata: { createdVia: `ravi threads ${kind}` },
    });
    const payload = { action: kind, thread: threadToJson(thread), entry };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✅ Added ${kind}: ${entry.id}`);
    return payload;
  }
}
