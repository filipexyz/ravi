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

function resolveTagTarget(agentId?: string, sessionName?: string): { assetType: TagAssetType; assetId: string } {
  const normalizedAgent = agentId?.trim();
  const normalizedSession = sessionName?.trim();
  if ((normalizedAgent ? 1 : 0) + (normalizedSession ? 1 : 0) !== 1) {
    fail("Use exactly one target: --agent <id> or --session <name>.");
  }

  if (normalizedAgent) {
    const config = loadRouterConfig();
    if (!config.agents[normalizedAgent]) {
      fail(`Agent not found: ${normalizedAgent}`);
    }
    return { assetType: "agent", assetId: normalizedAgent };
  }

  const session = resolveSession(normalizedSession!);
  if (!session) {
    fail(`Session not found: ${normalizedSession}`);
  }
  return {
    assetType: "session",
    assetId: session.name ?? session.sessionKey,
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
    @Option({ flags: "--label <text>", description: "Display label" }) label?: string,
    @Option({ flags: "--description <text>", description: "Optional description" }) description?: string,
    @Option({ flags: "--kind <kind>", description: "system|user", defaultValue: "user" }) kind?: string,
    @Option({ flags: "--meta <json>", description: "Free JSON metadata for the tag definition" }) metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const tag = dbCreateTagDefinition({
      slug: normalizeSlug(slug),
      label: label?.trim() || normalizeSlug(slug),
      ...(description?.trim() ? { description: description.trim() } : {}),
      kind: requireTagKind(kind),
      ...(parseMetadata(metadataJson) ? { metadata: parseMetadata(metadataJson) } : {}),
    });

    if (asJson) {
      printJson({
        status: "created",
        target: { type: "tag", slug: tag.slug },
        changedCount: 1,
        tag,
      });
      return;
    }

    console.log(`\n✓ Created tag ${tag.slug}`);
    printTagDefinition(tag);
  }

  @Command({ name: "list", description: "List tag definitions" })
  list(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const tags = dbListTagDefinitions();

    if (asJson) {
      console.log(JSON.stringify({ total: tags.length, tags }, null, 2));
      return;
    }

    if (tags.length === 0) {
      console.log("\nNo tags found.\n");
      return;
    }

    console.log(`\nTags (${tags.length}):\n`);
    for (const tag of tags) {
      console.log(
        `- ${tag.slug} :: ${tag.kind} :: ${tag.bindingCount} bindings${tag.description ? ` :: ${tag.description}` : ""}`,
      );
    }
  }

  @Command({ name: "show", description: "Show one tag and its bindings" })
  show(
    @Arg("slug", { description: "Tag slug" }) slug: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalizedSlug = normalizeSlug(slug);
    const tag = dbGetTagDefinition(normalizedSlug);
    if (!tag) {
      fail(`Tag not found: ${normalizedSlug}`);
    }
    const bindings = dbFindTagBindings({ slug: normalizedSlug });

    if (asJson) {
      console.log(JSON.stringify({ tag, bindings }, null, 2));
      return;
    }

    printTagDefinition({ ...tag, bindingCount: bindings.length });
    console.log("\nBindings:");
    if (bindings.length === 0) {
      console.log("  - none");
      return;
    }
    for (const binding of bindings) {
      printBinding(binding);
    }
  }

  @Command({ name: "attach", description: "Attach a tag to an agent or session" })
  attach(
    @Arg("slug", { description: "Tag slug" }) slug: string,
    @Option({ flags: "--agent <id>", description: "Target agent id" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Target session name" }) sessionName?: string,
    @Option({ flags: "--meta <json>", description: "Free JSON metadata for this binding" }) metadataJson?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const target = resolveTagTarget(agentId, sessionName);
    const binding = dbUpsertTagBinding({
      slug: normalizeSlug(slug),
      assetType: target.assetType,
      assetId: target.assetId,
      ...(parseMetadata(metadataJson) ? { metadata: parseMetadata(metadataJson) } : {}),
      createdBy: resolveTagActor(),
    });

    if (asJson) {
      printJson({
        status: "attached",
        target: {
          type: "tag-binding",
          tagSlug: binding.tagSlug,
          assetType: binding.assetType,
          assetId: binding.assetId,
        },
        changedCount: 1,
        binding,
      });
      return;
    }

    console.log(`\n✓ Attached ${binding.tagSlug} -> ${binding.assetType}:${binding.assetId}`);
    if (binding.metadata) {
      console.log(`Metadata: ${JSON.stringify(binding.metadata)}`);
    }
  }

  @Command({ name: "detach", description: "Detach a tag from an agent or session" })
  detach(
    @Arg("slug", { description: "Tag slug" }) slug: string,
    @Option({ flags: "--agent <id>", description: "Target agent id" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Target session name" }) sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const normalizedSlug = normalizeSlug(slug);
    const target = resolveTagTarget(agentId, sessionName);
    const removed = dbDeleteTagBinding({
      slug: normalizedSlug,
      assetType: target.assetType,
      assetId: target.assetId,
    });

    if (!removed) {
      fail(`Binding not found for ${normalizedSlug} -> ${target.assetType}:${target.assetId}`);
    }

    if (asJson) {
      printJson({
        status: "detached",
        target: {
          type: "tag-binding",
          tagSlug: normalizedSlug,
          assetType: target.assetType,
          assetId: target.assetId,
        },
        changedCount: 1,
      });
      return;
    }

    console.log(`\n✓ Detached ${normalizedSlug} from ${target.assetType}:${target.assetId}`);
  }

  @Command({ name: "search", description: "Search bindings by tag or asset" })
  search(
    @Option({ flags: "--tag <slug>", description: "Filter by tag slug" }) slug?: string,
    @Option({ flags: "--agent <id>", description: "Filter by agent id" }) agentId?: string,
    @Option({ flags: "--session <name>", description: "Filter by session name" }) sessionName?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const target = agentId?.trim() || sessionName?.trim() ? resolveTagTarget(agentId, sessionName) : undefined;
    const bindings = dbFindTagBindings({
      ...(slug?.trim() ? { slug: normalizeSlug(slug) } : {}),
      ...(target ? { assetType: target.assetType, assetId: target.assetId } : {}),
    });

    if (asJson) {
      console.log(JSON.stringify({ total: bindings.length, bindings }, null, 2));
      return;
    }

    if (bindings.length === 0) {
      console.log("\nNo bindings found.\n");
      return;
    }

    console.log(`\nBindings (${bindings.length}):\n`);
    for (const binding of bindings) {
      printBinding(binding);
    }
  }
}
