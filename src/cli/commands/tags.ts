import "reflect-metadata";
import { Arg, Command, CommandAccess, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import {
  declareCommandReturns,
  tagDetachReturnSchema,
  tagMutationReturnSchema,
  tagShowReturnSchema,
  tagsListReturnSchema,
  tagsSearchReturnSchema,
} from "./operational-return-schemas.js";
import {
  decodeListCursor,
  encodeListCursor,
  parseListLimit,
  parseListOrder,
  parseListSort,
  type ListOrder,
} from "../listing.js";
import { dbListObserverRules } from "../../runtime/observation-plane.js";
import {
  dbCreateTagDefinition,
  dbFindTagBindings,
  dbGetTagDefinition,
  dbListTagDefinitions,
  dbUpdateTagDefinition,
} from "../../tags/index.js";
import { attachTagToSelector, detachTagFromSelector, resolveTagTarget } from "../../tags/service.js";
import { hasTagTargetSelector, type TagTargetSelectorInput } from "../../tags/targets.js";
import type {
  TagAssetType,
  TagBinding,
  TagDefinition,
  TagKind,
  TagListCursor,
  TagListOrder,
  TagListSort,
} from "../../tags/types.js";

const VALID_TAG_KINDS = new Set<TagKind>(["system", "user"]);
const DEFAULT_TAG_LIST_LIMIT = 30;
const MAX_TAG_LIST_LIMIT = 500;
const TAG_LIST_SORT_FIELDS = ["updated", "created"] as const satisfies readonly TagListSort[];

type TagBehaviorConsumer = {
  type: "observer_rule";
  ruleId: string;
  enabled: boolean;
  targetType: string;
  inherited: boolean;
  behavior: "create_observer_binding";
  observerAgentId: string;
  observerRole: string;
  observerMode: string;
  permissionGrants: string[];
};

function normalizeSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!slug) fail("Tag slug is required.");
  if (!/^[a-z0-9._:-]+$/.test(slug)) {
    fail(`Invalid tag slug: ${value}. Use [a-z0-9._:-].`);
  }
  return slug;
}

function requireTagKind(value?: string): TagKind {
  const normalized = (value?.trim().toLowerCase() || "user") as TagKind;
  if (!VALID_TAG_KINDS.has(normalized)) {
    fail(`Invalid tag kind: ${value}. Use system|user.`);
  }
  return normalized;
}

function parseMetadata(value?: string): Record<string, unknown> | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("Metadata must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    fail(`Invalid metadata JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function failFromError(error: unknown): never {
  fail(error instanceof Error ? error.message : String(error));
}

function quoteCliArg(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9._:/@=-]+$/.test(text) ? text : JSON.stringify(text);
}

function parseTagListLimit(value?: string): number {
  return parseListLimit(value, {
    defaultValue: DEFAULT_TAG_LIST_LIMIT,
    maxValue: MAX_TAG_LIST_LIMIT,
    flag: "--limit",
  });
}

function buildTagListFilterFingerprint(filters: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(filters).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function resolveTagListCursor(
  value: string | undefined,
  sort: TagListSort,
  order: TagListOrder,
  filters: string,
): TagListCursor | undefined {
  const parsed = decodeListCursor(value);
  if (!parsed) return undefined;
  if (parsed.sort !== sort || parsed.order !== order) {
    fail(`Cursor was created for sort ${parsed.sort} ${parsed.order}. Re-run with matching --sort/--order.`);
  }
  if (!TAG_LIST_SORT_FIELDS.includes(parsed.sort as TagListSort)) {
    fail("Cursor was created for an unsupported tag sort field.");
  }
  if (parsed.filters && parsed.filters !== filters) {
    fail("Cursor was created for different tag filters. Re-run without --cursor or use the original filters.");
  }
  return {
    sort: parsed.sort as TagListSort,
    order: parsed.order,
    value: parsed.value,
    id: parsed.id,
    ...(parsed.filters ? { filters: parsed.filters } : {}),
  };
}

function getTagListSortValue(item: TagDefinition | TagBinding, sort: TagListSort): number {
  return sort === "created" ? item.createdAt : item.updatedAt;
}

function buildTagsListNextCommand(input: {
  cursor: string;
  limit: number;
  sort: TagListSort;
  order: ListOrder;
  kind?: TagKind;
  source?: string;
  query?: string;
}): string {
  const args = [
    "ravi",
    "tags",
    "list",
    "--cursor",
    quoteCliArg(input.cursor),
    "--limit",
    String(input.limit),
    "--sort",
    input.sort,
    "--order",
    input.order,
  ];
  if (input.kind) args.push("--kind", input.kind);
  if (input.source) args.push("--source", quoteCliArg(input.source));
  if (input.query) args.push("--query", quoteCliArg(input.query));
  return args.join(" ");
}

function buildTagsSearchNextCommand(input: {
  cursor: string;
  limit: number;
  sort: TagListSort;
  order: ListOrder;
  slug?: string;
  target?: { assetType: TagAssetType; assetId: string };
  kind?: TagKind;
  source?: string;
}): string {
  const args = [
    "ravi",
    "tags",
    "search",
    "--cursor",
    quoteCliArg(input.cursor),
    "--limit",
    String(input.limit),
    "--sort",
    input.sort,
    "--order",
    input.order,
  ];
  if (input.slug) args.push("--tag", quoteCliArg(input.slug));
  if (input.target) args.push("--target", quoteCliArg(`${input.target.assetType}:${input.target.assetId}`));
  if (input.kind) args.push("--kind", input.kind);
  if (input.source) args.push("--source", quoteCliArg(input.source));
  return args.join(" ");
}

interface TagTargetCliOptions {
  targetSelector?: string;
  agentId?: string;
  sessionName?: string;
  taskId?: string;
  projectId?: string;
  profileId?: string;
  contactId?: string;
  chatId?: string;
  routeId?: string;
  instanceName?: string;
  artifactId?: string;
  insightId?: string;
  workflowSpecId?: string;
  workflowRunId?: string;
  workflowNodeId?: string;
  cronJobId?: string;
  triggerId?: string;
  hookId?: string;
  taskAutomationId?: string;
  commandId?: string;
  skillId?: string;
  skillGateRuleId?: string;
  devinSessionId?: string;
  callProfileId?: string;
  callRequestId?: string;
  callVoiceAgentId?: string;
  callToolId?: string;
}

function buildTagTargetSelector(input: TagTargetCliOptions): TagTargetSelectorInput {
  return {
    ...(input.targetSelector?.trim() ? { target: input.targetSelector.trim() } : {}),
    ...(input.agentId?.trim() ? { agent: input.agentId.trim() } : {}),
    ...(input.sessionName?.trim() ? { session: input.sessionName.trim() } : {}),
    ...(input.taskId?.trim() ? { task: input.taskId.trim() } : {}),
    ...(input.projectId?.trim() ? { project: input.projectId.trim() } : {}),
    ...(input.profileId?.trim() ? { profile: input.profileId.trim() } : {}),
    ...(input.contactId?.trim() ? { contact: input.contactId.trim() } : {}),
    ...(input.chatId?.trim() ? { chat: input.chatId.trim() } : {}),
    ...(input.routeId?.trim() ? { route: input.routeId.trim() } : {}),
    ...(input.instanceName?.trim() ? { instance: input.instanceName.trim() } : {}),
    ...(input.artifactId?.trim() ? { artifact: input.artifactId.trim() } : {}),
    ...(input.insightId?.trim() ? { insight: input.insightId.trim() } : {}),
    ...(input.workflowSpecId?.trim() ? { workflow_spec: input.workflowSpecId.trim() } : {}),
    ...(input.workflowRunId?.trim() ? { workflow_run: input.workflowRunId.trim() } : {}),
    ...(input.workflowNodeId?.trim() ? { workflow_node: input.workflowNodeId.trim() } : {}),
    ...(input.cronJobId?.trim() ? { cron_job: input.cronJobId.trim() } : {}),
    ...(input.triggerId?.trim() ? { trigger: input.triggerId.trim() } : {}),
    ...(input.hookId?.trim() ? { hook: input.hookId.trim() } : {}),
    ...(input.taskAutomationId?.trim() ? { task_automation: input.taskAutomationId.trim() } : {}),
    ...(input.commandId?.trim() ? { command: input.commandId.trim() } : {}),
    ...(input.skillId?.trim() ? { skill: input.skillId.trim() } : {}),
    ...(input.skillGateRuleId?.trim() ? { skill_gate_rule: input.skillGateRuleId.trim() } : {}),
    ...(input.devinSessionId?.trim() ? { devin_session: input.devinSessionId.trim() } : {}),
    ...(input.callProfileId?.trim() ? { call_profile: input.callProfileId.trim() } : {}),
    ...(input.callRequestId?.trim() ? { call_request: input.callRequestId.trim() } : {}),
    ...(input.callVoiceAgentId?.trim() ? { call_voice_agent: input.callVoiceAgentId.trim() } : {}),
    ...(input.callToolId?.trim() ? { call_tool: input.callToolId.trim() } : {}),
  };
}

function resolveTagActor(): string {
  const ctx = getContext();
  return ctx?.sessionName ?? ctx?.agentId ?? process.env.USER ?? "cli";
}

function printTagDefinition(tag: TagDefinition & { bindingCount?: number }): void {
  console.log(`\nTag:         ${tag.slug}`);
  console.log(`Label:       ${tag.label}`);
  console.log(`Kind:        ${tag.kind}`);
  console.log(`Source:      ${tag.source}`);
  if (typeof tag.bindingCount === "number") console.log(`Bindings:    ${tag.bindingCount}`);
  if (tag.description) console.log(`Description: ${tag.description}`);
  if (tag.metadata) console.log(`Metadata:    ${JSON.stringify(tag.metadata)}`);
}

function printBinding(binding: TagBinding): void {
  console.log(
    `  - ${binding.assetType}:${binding.assetId}${binding.metadata ? ` :: ${JSON.stringify(binding.metadata)}` : ""}`,
  );
}

function listTagBehaviorConsumers(slug: string): TagBehaviorConsumer[] {
  return dbListObserverRules()
    .filter((rule) => rule.scope === "tag" && rule.tagSlug === slug)
    .map((rule) => ({
      type: "observer_rule" as const,
      ruleId: rule.id,
      enabled: rule.enabled,
      targetType: rule.tagTargetType ?? "any",
      inherited: rule.tagInherited,
      behavior: "create_observer_binding" as const,
      observerAgentId: rule.observerAgentId,
      observerRole: rule.observerRole,
      observerMode: rule.observerMode,
      permissionGrants: rule.permissionGrants,
    }));
}

function printBehaviorConsumers(consumers: TagBehaviorConsumer[]): void {
  console.log("\nBehavior consumers:");
  if (consumers.length === 0) {
    console.log("  - none");
    return;
  }
  for (const consumer of consumers) {
    const state = consumer.enabled ? "enabled" : "disabled";
    const inheritance = consumer.inherited ? "direct or inherited" : "direct only";
    const permissions =
      consumer.permissionGrants.length > 0 ? ` permissions=${consumer.permissionGrants.join(",")}` : "";
    console.log(
      `  - ${consumer.type}:${consumer.ruleId} (${state}) target=${consumer.targetType} ${inheritance} -> ${consumer.behavior}:${consumer.observerRole} mode=${consumer.observerMode}${permissions}`,
    );
  }
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

@Group({
  name: "tags",
  description: "Unified tags for Ravi assets",
  scope: "admin",
})
export class TagCommands {
  @Command({ name: "create", description: "Create a new tag definition" })
  @CommandAccess({ kind: "mutate", resource: "tags", action: "create", risk: "medium" })
  create(
    @Arg("slug", { description: "Stable tag slug" }) slug: string,
    @Option({ flags: "--label <text>", description: "Display label" })
    label?: string,
    @Option({
      flags: "--description <text>",
      description: "Optional description",
    })
    description?: string,
    @Option({
      flags: "--kind <kind>",
      description: "system|user",
      defaultValue: "user",
    })
    kind?: string,
    @Option({
      flags: "--source <source>",
      description: "Tag definition provenance source",
    })
    source?: string,
    @Option({
      flags: "--meta <json>",
      description: "Free JSON metadata for the tag definition",
    })
    metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const tag = dbCreateTagDefinition({
      slug: normalizeSlug(slug),
      label: label?.trim() || normalizeSlug(slug),
      ...(description?.trim() ? { description: description.trim() } : {}),
      kind: requireTagKind(kind),
      ...(source?.trim() ? { source: source.trim() } : {}),
      ...(parseMetadata(metadataJson) ? { metadata: parseMetadata(metadataJson) } : {}),
      createdBy: resolveTagActor(),
    });

    const payload = {
      status: "created" as const,
      target: { type: "tag" as const, slug: tag.slug },
      changedCount: 1,
      tag,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\n✓ Created tag ${tag.slug}`);
      printTagDefinition(tag);
    }
    return payload;
  }

  @Command({ name: "list", description: "List tag definitions" })
  @CommandAccess({ kind: "read", resource: "tags", action: "list", risk: "low" })
  list(
    @Option({ flags: "--kind <kind>", description: "Filter by kind: system|user" })
    kind?: string,
    @Option({ flags: "--source <source>", description: "Filter by provenance source" })
    source?: string,
    @Option({ flags: "--query <text>", description: "Search slug, label, or description" })
    query?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--limit <n>",
      description: `Page size (default: ${DEFAULT_TAG_LIST_LIMIT}, max: ${MAX_TAG_LIST_LIMIT})`,
    })
    limit?: string,
    @Option({ flags: "--cursor <token>", description: "Opaque cursor returned by the previous page" })
    cursor?: string,
    @Option({ flags: "--sort <field>", description: "Sort field: updated|created" })
    sort?: string,
    @Option({ flags: "--order <dir>", description: "Sort direction: asc|desc" })
    order?: string,
  ) {
    const parsedKind = kind?.trim() ? requireTagKind(kind) : undefined;
    const parsedSource = source?.trim() || undefined;
    const parsedQuery = query?.trim() || undefined;
    const pageLimit = parseTagListLimit(limit);
    const sortField = parseListSort(sort, TAG_LIST_SORT_FIELDS, "updated");
    const orderDirection = parseListOrder(order) as TagListOrder;
    const filterFingerprint = buildTagListFilterFingerprint({
      kind: parsedKind ?? null,
      source: parsedSource ?? null,
      query: parsedQuery ?? null,
    });
    const tagCursor = resolveTagListCursor(cursor, sortField, orderDirection, filterFingerprint);
    const fetchedTags = dbListTagDefinitions({
      ...(parsedKind ? { kind: parsedKind } : {}),
      ...(parsedSource ? { source: parsedSource } : {}),
      ...(parsedQuery ? { query: parsedQuery } : {}),
      limit: pageLimit + 1,
      sort: sortField,
      order: orderDirection,
      ...(tagCursor ? { cursor: tagCursor } : {}),
    });
    const hasMore = fetchedTags.length > pageLimit;
    const tags = hasMore ? fetchedTags.slice(0, pageLimit) : fetchedTags;
    const lastTag = tags[tags.length - 1];
    const nextCursor =
      hasMore && lastTag
        ? encodeListCursor({
            sort: sortField,
            order: orderDirection,
            value: getTagListSortValue(lastTag, sortField),
            id: lastTag.id,
            filters: filterFingerprint,
          })
        : null;
    const nextCommand = nextCursor
      ? buildTagsListNextCommand({
          cursor: nextCursor,
          limit: pageLimit,
          sort: sortField,
          order: orderDirection,
          kind: parsedKind,
          source: parsedSource,
          query: parsedQuery,
        })
      : null;
    const payload = {
      total: tags.length,
      page: {
        limit: pageLimit,
        count: tags.length,
        hasMore,
        nextCursor,
        nextCommand,
        sort: sortField,
        order: orderDirection,
      },
      filters: {
        kind: parsedKind ?? null,
        source: parsedSource ?? null,
        query: parsedQuery ?? null,
      },
      items: tags,
      tags,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (tags.length === 0) {
      console.log("\nNo tags found.\n");
    } else {
      console.log(`\nTags (${tags.length} returned, limit ${pageLimit}, sort ${sortField} ${orderDirection}):\n`);
      for (const tag of tags) {
        console.log(
          `- ${tag.slug} :: ${tag.kind} :: ${tag.bindingCount} bindings${tag.description ? ` :: ${tag.description}` : ""}`,
        );
      }
      if (nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${nextCommand}`);
      }
    }
    return payload;
  }

  @Command({ name: "set", description: "Set tag definition metadata" })
  @CommandAccess({ kind: "mutate", resource: "tags", action: "set", risk: "medium" })
  set(
    @Arg("slug", { description: "Tag slug" }) slug: string,
    @Arg("key", { description: "Property: label, description, kind, source, metadata" }) key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const normalizedSlug = normalizeSlug(slug);
    const normalizedKey = key.trim();
    const base = { slug: normalizedSlug, updatedBy: resolveTagActor() };
    const tag =
      normalizedKey === "label"
        ? dbUpdateTagDefinition({ ...base, label: value })
        : normalizedKey === "description"
          ? dbUpdateTagDefinition({ ...base, description: value })
          : normalizedKey === "kind"
            ? dbUpdateTagDefinition({ ...base, kind: requireTagKind(value) })
            : normalizedKey === "source"
              ? dbUpdateTagDefinition({ ...base, source: value })
              : normalizedKey === "metadata" || normalizedKey === "meta"
                ? dbUpdateTagDefinition({ ...base, metadata: parseMetadata(value) ?? {} })
                : null;

    if (!tag) {
      fail("Invalid tag property. Use label, description, kind, source, metadata.");
    }

    const payload = {
      status: "updated" as const,
      target: { type: "tag" as const, slug: tag.slug },
      changedCount: 1,
      tag,
      behaviorConsumers: listTagBehaviorConsumers(tag.slug),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\n✓ Updated tag ${tag.slug}`);
      printTagDefinition(tag);
      printBehaviorConsumers(payload.behaviorConsumers);
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one tag and its bindings" })
  @CommandAccess({ kind: "read", resource: "tags", action: "show", risk: "low" })
  show(
    @Arg("slug", { description: "Tag slug" }) slug: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const normalizedSlug = normalizeSlug(slug);
    const tag = dbGetTagDefinition(normalizedSlug);
    if (!tag) {
      fail(`Tag not found: ${normalizedSlug}`);
    }
    const bindings = dbFindTagBindings({ slug: normalizedSlug });
    const behaviorConsumers = listTagBehaviorConsumers(normalizedSlug);
    const payload = { tag, bindings, behaviorConsumers };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printTagDefinition({ ...tag, bindingCount: bindings.length });
      console.log("\nBindings:");
      if (bindings.length === 0) {
        console.log("  - none");
      } else {
        for (const binding of bindings) {
          printBinding(binding);
        }
      }
      printBehaviorConsumers(behaviorConsumers);
    }
    return payload;
  }

  @Command({
    name: "attach",
    description: "Attach a tag to a Ravi asset",
  })
  @CommandAccess({ kind: "mutate", resource: "tags", action: "attach", risk: "medium" })
  attach(
    @Arg("slug", { description: "Tag slug" }) slug: string,
    @Option({ flags: "--agent <id>", description: "Target agent id" })
    agentId?: string,
    @Option({ flags: "--session <name>", description: "Target session name" })
    sessionName?: string,
    @Option({ flags: "--task <id>", description: "Target task id" })
    taskId?: string,
    @Option({ flags: "--project <id>", description: "Target project id" })
    projectId?: string,
    @Option({ flags: "--profile <id>", description: "Target task profile id" })
    profileId?: string,
    @Option({ flags: "--contact <id>", description: "Target contact id" })
    contactId?: string,
    @Option({ flags: "--chat <id>", description: "Target canonical chat id" })
    chatId?: string,
    @Option({ flags: "--route <id>", description: "Target route id" })
    routeId?: string,
    @Option({ flags: "--instance <name>", description: "Target Ravi channel instance name" })
    instanceName?: string,
    @Option({ flags: "--artifact <id>", description: "Target artifact id" })
    artifactId?: string,
    @Option({ flags: "--insight <id>", description: "Target insight id" })
    insightId?: string,
    @Option({ flags: "--workflow-spec <id>", description: "Target workflow spec id" })
    workflowSpecId?: string,
    @Option({ flags: "--workflow-run <id>", description: "Target workflow run id" })
    workflowRunId?: string,
    @Option({ flags: "--workflow-node <id>", description: "Target workflow node id" })
    workflowNodeId?: string,
    @Option({ flags: "--cron-job <id>", description: "Target cron job id" })
    cronJobId?: string,
    @Option({ flags: "--trigger <id>", description: "Target trigger id" })
    triggerId?: string,
    @Option({ flags: "--hook <id>", description: "Target hook id" })
    hookId?: string,
    @Option({ flags: "--task-automation <id>", description: "Target task automation id" })
    taskAutomationId?: string,
    @Option({ flags: "--command <id>", description: "Target Ravi command id" })
    commandId?: string,
    @Option({ flags: "--skill <name>", description: "Target skill name" })
    skillId?: string,
    @Option({ flags: "--skill-gate-rule <id>", description: "Target skill gate rule id" })
    skillGateRuleId?: string,
    @Option({ flags: "--devin-session <id>", description: "Target Devin session id" })
    devinSessionId?: string,
    @Option({ flags: "--call-profile <id>", description: "Target prox call profile id" })
    callProfileId?: string,
    @Option({ flags: "--call-request <id>", description: "Target prox call request id" })
    callRequestId?: string,
    @Option({ flags: "--call-voice-agent <id>", description: "Target prox call voice agent id" })
    callVoiceAgentId?: string,
    @Option({ flags: "--call-tool <id>", description: "Target prox call tool id" })
    callToolId?: string,
    @Option({
      flags: "--target <type:id>",
      description: "Generic target selector, e.g. task:task-123 or workflow_run:wfr-123",
    })
    targetSelector?: string,
    @Option({ flags: "--source <source>", description: "Binding provenance source" })
    source?: string,
    @Option({
      flags: "--meta <json>",
      description: "Free JSON metadata for this binding",
    })
    metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const metadata = parseMetadata(metadataJson);
    const { binding } = (() => {
      try {
        return attachTagToSelector({
          slug: normalizeSlug(slug),
          selector: buildTagTargetSelector({
            targetSelector,
            agentId,
            sessionName,
            taskId,
            projectId,
            profileId,
            contactId,
            chatId,
            routeId,
            instanceName,
            artifactId,
            insightId,
            workflowSpecId,
            workflowRunId,
            workflowNodeId,
            cronJobId,
            triggerId,
            hookId,
            taskAutomationId,
            commandId,
            skillId,
            skillGateRuleId,
            devinSessionId,
            callProfileId,
            callRequestId,
            callVoiceAgentId,
            callToolId,
          }),
          ...(source?.trim() ? { source: source.trim() } : {}),
          ...(metadata ? { metadata } : {}),
          actor: resolveTagActor(),
        });
      } catch (error) {
        failFromError(error);
      }
    })();

    const payload = {
      status: "attached" as const,
      target: {
        type: "tag-binding" as const,
        tagSlug: binding.tagSlug,
        assetType: binding.assetType,
        assetId: binding.assetId,
      },
      changedCount: 1,
      binding,
      behaviorConsumers: listTagBehaviorConsumers(binding.tagSlug),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\n✓ Attached ${binding.tagSlug} -> ${binding.assetType}:${binding.assetId}`);
      if (binding.metadata) {
        console.log(`Metadata: ${JSON.stringify(binding.metadata)}`);
      }
      printBehaviorConsumers(payload.behaviorConsumers);
    }
    return payload;
  }

  @Command({
    name: "detach",
    description: "Detach a tag from a Ravi asset",
  })
  @CommandAccess({ kind: "mutate", resource: "tags", action: "detach", risk: "medium" })
  detach(
    @Arg("slug", { description: "Tag slug" }) slug: string,
    @Option({ flags: "--agent <id>", description: "Target agent id" })
    agentId?: string,
    @Option({ flags: "--session <name>", description: "Target session name" })
    sessionName?: string,
    @Option({ flags: "--task <id>", description: "Target task id" })
    taskId?: string,
    @Option({ flags: "--project <id>", description: "Target project id" })
    projectId?: string,
    @Option({ flags: "--profile <id>", description: "Target task profile id" })
    profileId?: string,
    @Option({ flags: "--contact <id>", description: "Target contact id" })
    contactId?: string,
    @Option({ flags: "--chat <id>", description: "Target canonical chat id" })
    chatId?: string,
    @Option({ flags: "--route <id>", description: "Target route id" })
    routeId?: string,
    @Option({ flags: "--instance <name>", description: "Target Ravi channel instance name" })
    instanceName?: string,
    @Option({ flags: "--artifact <id>", description: "Target artifact id" })
    artifactId?: string,
    @Option({ flags: "--insight <id>", description: "Target insight id" })
    insightId?: string,
    @Option({ flags: "--workflow-spec <id>", description: "Target workflow spec id" })
    workflowSpecId?: string,
    @Option({ flags: "--workflow-run <id>", description: "Target workflow run id" })
    workflowRunId?: string,
    @Option({ flags: "--workflow-node <id>", description: "Target workflow node id" })
    workflowNodeId?: string,
    @Option({ flags: "--cron-job <id>", description: "Target cron job id" })
    cronJobId?: string,
    @Option({ flags: "--trigger <id>", description: "Target trigger id" })
    triggerId?: string,
    @Option({ flags: "--hook <id>", description: "Target hook id" })
    hookId?: string,
    @Option({ flags: "--task-automation <id>", description: "Target task automation id" })
    taskAutomationId?: string,
    @Option({ flags: "--command <id>", description: "Target Ravi command id" })
    commandId?: string,
    @Option({ flags: "--skill <name>", description: "Target skill name" })
    skillId?: string,
    @Option({ flags: "--skill-gate-rule <id>", description: "Target skill gate rule id" })
    skillGateRuleId?: string,
    @Option({ flags: "--devin-session <id>", description: "Target Devin session id" })
    devinSessionId?: string,
    @Option({ flags: "--call-profile <id>", description: "Target prox call profile id" })
    callProfileId?: string,
    @Option({ flags: "--call-request <id>", description: "Target prox call request id" })
    callRequestId?: string,
    @Option({ flags: "--call-voice-agent <id>", description: "Target prox call voice agent id" })
    callVoiceAgentId?: string,
    @Option({ flags: "--call-tool <id>", description: "Target prox call tool id" })
    callToolId?: string,
    @Option({
      flags: "--target <type:id>",
      description: "Generic target selector, e.g. task:task-123 or workflow_run:wfr-123",
    })
    targetSelector?: string,
    @Option({ flags: "--source <source>", description: "Detach audit/provenance source" })
    source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const normalizedSlug = normalizeSlug(slug);
    const { target, removed } = (() => {
      try {
        return detachTagFromSelector({
          slug: normalizedSlug,
          selector: buildTagTargetSelector({
            targetSelector,
            agentId,
            sessionName,
            taskId,
            projectId,
            profileId,
            contactId,
            chatId,
            routeId,
            instanceName,
            artifactId,
            insightId,
            workflowSpecId,
            workflowRunId,
            workflowNodeId,
            cronJobId,
            triggerId,
            hookId,
            taskAutomationId,
            commandId,
            skillId,
            skillGateRuleId,
            devinSessionId,
            callProfileId,
            callRequestId,
            callVoiceAgentId,
            callToolId,
          }),
          actor: resolveTagActor(),
          ...(source?.trim() ? { source: source.trim() } : {}),
        });
      } catch (error) {
        failFromError(error);
      }
    })();

    if (!removed) {
      fail(`Binding not found for ${normalizedSlug} -> ${target.assetType}:${target.assetId}`);
    }

    const payload = {
      status: "detached" as const,
      target: {
        type: "tag-binding" as const,
        tagSlug: normalizedSlug,
        assetType: target.assetType,
        assetId: target.assetId,
      },
      changedCount: 1,
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\n✓ Detached ${normalizedSlug} from ${target.assetType}:${target.assetId}`);
    }
    return payload;
  }

  @Command({ name: "search", description: "Search bindings by tag or asset" })
  @CommandAccess({ kind: "read", resource: "tags", action: "search", risk: "low" })
  search(
    @Option({ flags: "--tag <slug>", description: "Filter by tag slug" })
    slug?: string,
    @Option({ flags: "--agent <id>", description: "Filter by agent id" })
    agentId?: string,
    @Option({
      flags: "--session <name>",
      description: "Filter by session name",
    })
    sessionName?: string,
    @Option({ flags: "--task <id>", description: "Filter by task id" })
    taskId?: string,
    @Option({ flags: "--project <id>", description: "Filter by project id" })
    projectId?: string,
    @Option({
      flags: "--profile <id>",
      description: "Filter by task profile id",
    })
    profileId?: string,
    @Option({ flags: "--contact <id>", description: "Filter by contact id" })
    contactId?: string,
    @Option({ flags: "--chat <id>", description: "Filter by canonical chat id" })
    chatId?: string,
    @Option({ flags: "--route <id>", description: "Filter by route id" })
    routeId?: string,
    @Option({ flags: "--instance <name>", description: "Filter by Ravi channel instance name" })
    instanceName?: string,
    @Option({ flags: "--artifact <id>", description: "Filter by artifact id" })
    artifactId?: string,
    @Option({ flags: "--insight <id>", description: "Filter by insight id" })
    insightId?: string,
    @Option({ flags: "--workflow-spec <id>", description: "Filter by workflow spec id" })
    workflowSpecId?: string,
    @Option({ flags: "--workflow-run <id>", description: "Filter by workflow run id" })
    workflowRunId?: string,
    @Option({ flags: "--workflow-node <id>", description: "Filter by workflow node id" })
    workflowNodeId?: string,
    @Option({ flags: "--cron-job <id>", description: "Filter by cron job id" })
    cronJobId?: string,
    @Option({ flags: "--trigger <id>", description: "Filter by trigger id" })
    triggerId?: string,
    @Option({ flags: "--hook <id>", description: "Filter by hook id" })
    hookId?: string,
    @Option({ flags: "--task-automation <id>", description: "Filter by task automation id" })
    taskAutomationId?: string,
    @Option({ flags: "--command <id>", description: "Filter by Ravi command id" })
    commandId?: string,
    @Option({ flags: "--skill <name>", description: "Filter by skill name" })
    skillId?: string,
    @Option({ flags: "--skill-gate-rule <id>", description: "Filter by skill gate rule id" })
    skillGateRuleId?: string,
    @Option({ flags: "--devin-session <id>", description: "Filter by Devin session id" })
    devinSessionId?: string,
    @Option({ flags: "--call-profile <id>", description: "Filter by prox call profile id" })
    callProfileId?: string,
    @Option({ flags: "--call-request <id>", description: "Filter by prox call request id" })
    callRequestId?: string,
    @Option({ flags: "--call-voice-agent <id>", description: "Filter by prox call voice agent id" })
    callVoiceAgentId?: string,
    @Option({ flags: "--call-tool <id>", description: "Filter by prox call tool id" })
    callToolId?: string,
    @Option({
      flags: "--target <type:id>",
      description: "Generic target selector, e.g. task:task-123 or workflow_run:wfr-123",
    })
    targetSelector?: string,
    @Option({ flags: "--kind <kind>", description: "Filter by tag kind: system|user" })
    kind?: string,
    @Option({ flags: "--source <source>", description: "Filter by binding provenance source" })
    source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--limit <n>",
      description: `Page size (default: ${DEFAULT_TAG_LIST_LIMIT}, max: ${MAX_TAG_LIST_LIMIT})`,
    })
    limit?: string,
    @Option({ flags: "--cursor <token>", description: "Opaque cursor returned by the previous page" })
    cursor?: string,
    @Option({ flags: "--sort <field>", description: "Sort field: updated|created" })
    sort?: string,
    @Option({ flags: "--order <dir>", description: "Sort direction: asc|desc" })
    order?: string,
  ) {
    const targetSelectorInput = buildTagTargetSelector({
      targetSelector,
      agentId,
      sessionName,
      taskId,
      projectId,
      profileId,
      contactId,
      chatId,
      routeId,
      instanceName,
      artifactId,
      insightId,
      workflowSpecId,
      workflowRunId,
      workflowNodeId,
      cronJobId,
      triggerId,
      hookId,
      taskAutomationId,
      commandId,
      skillId,
      skillGateRuleId,
      devinSessionId,
      callProfileId,
      callRequestId,
      callVoiceAgentId,
      callToolId,
    });
    const target = (() => {
      try {
        return hasTagTargetSelector(targetSelectorInput)
          ? resolveTagTarget({ selector: targetSelectorInput, operation: "search" })
          : undefined;
      } catch (error) {
        failFromError(error);
      }
    })();
    const normalizedSlug = slug?.trim() ? normalizeSlug(slug) : undefined;
    const parsedKind = kind?.trim() ? requireTagKind(kind) : undefined;
    const parsedSource = source?.trim() || undefined;
    const pageLimit = parseTagListLimit(limit);
    const sortField = parseListSort(sort, TAG_LIST_SORT_FIELDS, "updated");
    const orderDirection = parseListOrder(order) as TagListOrder;
    const filterFingerprint = buildTagListFilterFingerprint({
      slug: normalizedSlug ?? null,
      assetType: target?.assetType ?? null,
      assetId: target?.assetId ?? null,
      kind: parsedKind ?? null,
      source: parsedSource ?? null,
    });
    const bindingCursor = resolveTagListCursor(cursor, sortField, orderDirection, filterFingerprint);
    const fetchedBindings = dbFindTagBindings({
      ...(normalizedSlug ? { slug: normalizedSlug } : {}),
      ...(target ? { assetType: target.assetType, assetId: target.assetId } : {}),
      ...(parsedKind ? { kind: parsedKind } : {}),
      ...(parsedSource ? { source: parsedSource } : {}),
      limit: pageLimit + 1,
      sort: sortField,
      order: orderDirection,
      ...(bindingCursor ? { cursor: bindingCursor } : {}),
    });
    const hasMore = fetchedBindings.length > pageLimit;
    const bindings = hasMore ? fetchedBindings.slice(0, pageLimit) : fetchedBindings;
    const lastBinding = bindings[bindings.length - 1];
    const nextCursor =
      hasMore && lastBinding
        ? encodeListCursor({
            sort: sortField,
            order: orderDirection,
            value: getTagListSortValue(lastBinding, sortField),
            id: lastBinding.id,
            filters: filterFingerprint,
          })
        : null;
    const nextCommand = nextCursor
      ? buildTagsSearchNextCommand({
          cursor: nextCursor,
          limit: pageLimit,
          sort: sortField,
          order: orderDirection,
          slug: normalizedSlug,
          target,
          kind: parsedKind,
          source: parsedSource,
        })
      : null;

    const behaviorConsumers = normalizedSlug ? listTagBehaviorConsumers(normalizedSlug) : [];
    const payload = {
      total: bindings.length,
      page: {
        limit: pageLimit,
        count: bindings.length,
        hasMore,
        nextCursor,
        nextCommand,
        sort: sortField,
        order: orderDirection,
      },
      filters: {
        tagSlug: normalizedSlug ?? null,
        assetType: target?.assetType ?? null,
        assetId: target?.assetId ?? null,
        kind: parsedKind ?? null,
        source: parsedSource ?? null,
      },
      items: bindings,
      bindings,
      behaviorConsumers,
    };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (bindings.length === 0) {
      console.log("\nNo bindings found.\n");
      if (normalizedSlug) printBehaviorConsumers(behaviorConsumers);
    } else {
      console.log(
        `\nBindings (${bindings.length} returned, limit ${pageLimit}, sort ${sortField} ${orderDirection}):\n`,
      );
      for (const binding of bindings) {
        printBinding(binding);
      }
      if (normalizedSlug) printBehaviorConsumers(behaviorConsumers);
      if (nextCommand) {
        console.log("\nNext page:");
        console.log(`  ${nextCommand}`);
      }
    }
    return payload;
  }
}

declareCommandReturns(TagCommands, {
  attach: tagMutationReturnSchema,
  create: tagMutationReturnSchema,
  detach: tagDetachReturnSchema,
  list: tagsListReturnSchema,
  search: tagsSearchReturnSchema,
  set: tagMutationReturnSchema,
  show: tagShowReturnSchema,
});
