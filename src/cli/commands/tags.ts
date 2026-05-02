import "reflect-metadata";
import { Arg, Command, Group, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { loadRouterConfig, resolveSession } from "../../router/index.js";
import {
  dbCreateTagDefinition,
  dbDeleteTagBinding,
  dbFindTagBindings,
  dbGetTagDefinition,
  dbListTagDefinitions,
  dbUpsertTagBinding,
} from "../../tags/index.js";
import type { TagAssetType, TagBinding, TagDefinition, TagKind } from "../../tags/types.js";
import { dbGetTask } from "../../tasks/task-db.js";

const VALID_TAG_KINDS = new Set<TagKind>(["system", "user"]);

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

function resolveTagTarget(input: {
  agentId?: string;
  sessionName?: string;
  taskId?: string;
  projectId?: string;
  profileId?: string;
  contactId?: string;
}): { assetType: TagAssetType; assetId: string } {
  const { agentId, sessionName, taskId, projectId, profileId, contactId } = input;
  const normalizedAgent = agentId?.trim();
  const normalizedSession = sessionName?.trim();
  const normalizedTask = taskId?.trim();
  const normalizedProject = projectId?.trim();
  const normalizedProfile = profileId?.trim();
  const normalizedContact = contactId?.trim();
  const targetCount = [
    normalizedAgent,
    normalizedSession,
    normalizedTask,
    normalizedProject,
    normalizedProfile,
    normalizedContact,
  ].filter(Boolean).length;
  if (targetCount !== 1) {
    fail("Use exactly one target: --agent, --session, --task, --project, --profile, or --contact.");
  }

  if (normalizedAgent) {
    const config = loadRouterConfig();
    if (!config.agents[normalizedAgent]) {
      fail(`Agent not found: ${normalizedAgent}`);
    }
    return { assetType: "agent", assetId: normalizedAgent };
  }

  if (normalizedSession) {
    const session = resolveSession(normalizedSession);
    if (!session) {
      fail(`Session not found: ${normalizedSession}`);
    }
    return {
      assetType: "session",
      assetId: session.name ?? session.sessionKey,
    };
  }

  if (normalizedTask) {
    if (!dbGetTask(normalizedTask)) {
      fail(`Task not found: ${normalizedTask}`);
    }
    return { assetType: "task", assetId: normalizedTask };
  }
  if (normalizedProject) return { assetType: "project", assetId: normalizedProject };
  if (normalizedProfile) return { assetType: "profile", assetId: normalizedProfile };
  return { assetType: "contact", assetId: normalizedContact! };
}

function resolveTagActor(): string {
  const ctx = getContext();
  return ctx?.sessionName ?? ctx?.agentId ?? process.env.USER ?? "cli";
}

function printTagDefinition(tag: TagDefinition & { bindingCount?: number }): void {
  console.log(`\nTag:         ${tag.slug}`);
  console.log(`Label:       ${tag.label}`);
  console.log(`Kind:        ${tag.kind}`);
  if (typeof tag.bindingCount === "number") console.log(`Bindings:    ${tag.bindingCount}`);
  if (tag.description) console.log(`Description: ${tag.description}`);
  if (tag.metadata) console.log(`Metadata:    ${JSON.stringify(tag.metadata)}`);
}

function printBinding(binding: TagBinding): void {
  console.log(
    `  - ${binding.assetType}:${binding.assetId}${binding.metadata ? ` :: ${JSON.stringify(binding.metadata)}` : ""}`,
  );
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

@Group({
  name: "tags",
  description: "Unified tags for agents and sessions",
  scope: "admin",
})
export class TagCommands {
  @Command({ name: "create", description: "Create a new tag definition" })
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
      ...(parseMetadata(metadataJson) ? { metadata: parseMetadata(metadataJson) } : {}),
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
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const tags = dbListTagDefinitions();
    const payload = { total: tags.length, tags };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (tags.length === 0) {
      console.log("\nNo tags found.\n");
    } else {
      console.log(`\nTags (${tags.length}):\n`);
      for (const tag of tags) {
        console.log(
          `- ${tag.slug} :: ${tag.kind} :: ${tag.bindingCount} bindings${tag.description ? ` :: ${tag.description}` : ""}`,
        );
      }
    }
    return payload;
  }

  @Command({ name: "show", description: "Show one tag and its bindings" })
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
    const payload = { tag, bindings };

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
    }
    return payload;
  }

  @Command({
    name: "attach",
    description: "Attach a tag to an agent, session, task, project, profile, or contact",
  })
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
    @Option({
      flags: "--meta <json>",
      description: "Free JSON metadata for this binding",
    })
    metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const target = resolveTagTarget({
      agentId,
      sessionName,
      taskId,
      projectId,
      profileId,
      contactId,
    });
    const binding = dbUpsertTagBinding({
      slug: normalizeSlug(slug),
      assetType: target.assetType,
      assetId: target.assetId,
      ...(parseMetadata(metadataJson) ? { metadata: parseMetadata(metadataJson) } : {}),
      createdBy: resolveTagActor(),
    });

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
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`\n✓ Attached ${binding.tagSlug} -> ${binding.assetType}:${binding.assetId}`);
      if (binding.metadata) {
        console.log(`Metadata: ${JSON.stringify(binding.metadata)}`);
      }
    }
    return payload;
  }

  @Command({
    name: "detach",
    description: "Detach a tag from an agent, session, task, project, profile, or contact",
  })
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
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const normalizedSlug = normalizeSlug(slug);
    const target = resolveTagTarget({
      agentId,
      sessionName,
      taskId,
      projectId,
      profileId,
      contactId,
    });
    const removed = dbDeleteTagBinding({
      slug: normalizedSlug,
      assetType: target.assetType,
      assetId: target.assetId,
    });

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
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const hasTarget = [agentId, sessionName, taskId, projectId, profileId, contactId].some((value) => value?.trim());
    const target = hasTarget
      ? resolveTagTarget({
          agentId,
          sessionName,
          taskId,
          projectId,
          profileId,
          contactId,
        })
      : undefined;
    const bindings = dbFindTagBindings({
      ...(slug?.trim() ? { slug: normalizeSlug(slug) } : {}),
      ...(target ? { assetType: target.assetType, assetId: target.assetId } : {}),
    });

    const payload = { total: bindings.length, bindings };

    if (asJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (bindings.length === 0) {
      console.log("\nNo bindings found.\n");
    } else {
      console.log(`\nBindings (${bindings.length}):\n`);
      for (const binding of bindings) {
        printBinding(binding);
      }
    }
    return payload;
  }
}
