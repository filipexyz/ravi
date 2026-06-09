/**
 * Permissions Commands - REBAC relation management CLI
 */

import "reflect-metadata";
import { z } from "zod";
import { Group, Command, Arg, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  DEFAULT_MANUAL_GRANT_TTL_MS,
  grantRelation,
  revokeRelation,
  hasRelation,
  listRelations,
  clearRelations,
  syncRelationsFromConfig,
  type RelationFilter,
  type Relation,
  type GrantRelationOptions,
} from "../../permissions/relations.js";
import { can } from "../../permissions/engine.js";
import { notifyPermissionGrantCreated, notifyPermissionGrantsCreated } from "../../permissions/grant-notifications.js";
import { SDK_TOOLS, TOOL_GROUPS, resolveToolGroup } from "../tool-registry.js";
import { getDefaultAllowlist } from "../../bash/permissions.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const paginationSchema = z.object({
  limit: z.number(),
  offset: z.number(),
  returned: z.number(),
  total: z.number(),
  hasMore: z.boolean(),
  nextOffset: z.number().nullable(),
  nextCommand: z.string().nullable(),
});

const relationFilterSchema = z
  .object({
    subjectType: z.string().optional(),
    subjectId: z.string().optional(),
    relation: z.string().optional(),
    objectType: z.string().optional(),
    objectId: z.string().optional(),
    source: z.string().optional(),
    includeInactive: z.boolean().optional(),
  })
  .passthrough();

const relationSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    subjectType: z.string(),
    subjectId: z.string(),
    subject: z.string(),
    relation: z.string(),
    objectType: z.string(),
    objectId: z.string(),
    object: z.string(),
    source: z.string().optional(),
    grantMode: z.enum(["temporary", "permanent"]).optional(),
    expiresAt: z.number().nullable().optional(),
    revokedAt: z.number().nullable().optional(),
    reason: z.string().nullable().optional(),
    issuedBy: z.string().nullable().optional(),
    active: z.boolean().optional(),
    objectMembers: z.array(z.string()).optional(),
  })
  .passthrough();

const relationTargetSchema = z.object({ type: z.string() }).passthrough();
const warningSchema = z.record(z.string(), z.unknown());

const permissionMutationBaseSchema = z.object({
  target: relationTargetSchema,
  changedCount: z.number(),
});

const permissionsGrantReturnSchema = permissionMutationBaseSchema.extend({
  status: z.literal("granted"),
  relation: relationSchema,
  warnings: z.array(warningSchema),
});

const permissionsRevokeReturnSchema = permissionMutationBaseSchema.extend({
  status: z.literal("revoked"),
  relation: relationSchema,
  remainingIndividualRelations: z.array(relationSchema),
});

const permissionsCheckReturnSchema = z.object({
  subject: z.object({ raw: z.string(), type: z.string(), id: z.string() }),
  permission: z.string(),
  object: z.object({ raw: z.string(), type: z.string(), id: z.string() }),
  allowed: z.boolean(),
});

const permissionsListReturnSchema = z.object({
  total: z.number(),
  pagination: paginationSchema,
  filter: relationFilterSchema,
  items: z.array(relationSchema),
  relations: z.array(relationSchema),
});

const permissionsSyncReturnSchema = permissionMutationBaseSchema.extend({
  status: z.literal("synced"),
  relations: z.array(relationSchema),
});

const permissionsInitReturnSchema = permissionMutationBaseSchema.extend({
  status: z.literal("applied"),
  relations: z.array(relationSchema),
});

const permissionsClearReturnSchema = permissionMutationBaseSchema.extend({
  status: z.literal("cleared"),
});

@Group({
  name: "permissions",
  description: "REBAC permission management",
  scope: "superadmin",
})
export class PermissionsCommands {
  @Command({ name: "grant", description: "Grant a relation" })
  @Returns(permissionsGrantReturnSchema)
  grant(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" })
    subject: string,
    @Arg("relation", {
      description: "Relation (e.g., admin, access, execute, write_contacts)",
    })
    relation: string,
    @Arg("object", {
      description: "Object (e.g., system:*, group:contacts, session:dev-*)",
    })
    object: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--ttl <duration>",
      description: "Temporary grant TTL (default: 1h; examples: 15m, 2h, 7d)",
    })
    ttl?: string,
    @Option({
      flags: "--expires-at <time>",
      description: "Temporary grant expiration as ISO time or epoch seconds",
    })
    expiresAt?: string,
    @Option({
      flags: "--permanent",
      description: "Create an explicit permanent grant",
    })
    permanent?: boolean,
    @Option({
      flags: "--reason <text>",
      description: "Reason stored with the grant",
    })
    reason?: string,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);
    validateRelation(relation);
    const grantOptions = buildGrantOptions({
      ttl,
      expiresAt,
      permanent,
      reason,
    });
    if (objectType === "toolgroup" && objectId !== "*" && !TOOL_GROUPS[objectId]) {
      fail(`Unknown tool group: "${objectId}". Available: ${Object.keys(TOOL_GROUPS).join(", ")}`);
      return;
    }

    const exactFilter: RelationFilter = {
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId,
    };
    const existedAsManual = listRelations(exactFilter).some((item) => item.source === "manual");
    const granted = grantRelation(subjectType, subjectId, relation, objectType, objectId, "manual", grantOptions);
    if (granted) {
      notifyPermissionGrantCreated(granted);
    }
    if (!asJson) {
      console.log(`✓ Granted: (${subject}) ${relation} (${object})`);
      console.log(formatLifetime(granted));
    }

    // Warn about redundancy
    const warnings: Array<Record<string, unknown>> = [];
    if (objectId === "*") {
      const individuals = listRelations({
        subjectType,
        subjectId,
        relation,
        objectType,
      }).filter((r) => r.objectId !== "*");
      if (individuals.length > 0) {
        if (asJson) {
          warnings.push({
            type: "individual_relations_redundant",
            count: individuals.length,
            relations: individuals.map(serializeRelation),
          });
        } else {
          console.log(`⚠ ${individuals.length} individual relation(s) are now redundant (covered by wildcard)`);
        }
      }
    } else if (hasRelation(subjectType, subjectId, relation, objectType, "*")) {
      if (asJson) {
        warnings.push({
          type: "covered_by_wildcard",
          wildcard: `${objectType}:*`,
        });
      } else {
        console.log(`⚠ Redundant: wildcard ${objectType}:* already covers this`);
      }
    }

    if (asJson) {
      const payload = {
        status: "granted",
        target: relationTarget(subject, relation, object),
        changedCount: existedAsManual ? 0 : 1,
        relation: granted
          ? serializeRelation(granted)
          : relationTuple(subjectType, subjectId, relation, objectType, objectId),
        warnings,
      };
      printJson(payload);
      return payload;
    }

    return {
      status: "granted",
      target: relationTarget(subject, relation, object),
      changedCount: existedAsManual ? 0 : 1,
      relation: granted
        ? serializeRelation(granted)
        : relationTuple(subjectType, subjectId, relation, objectType, objectId),
      warnings,
    };
  }

  @Command({ name: "revoke", description: "Revoke a relation" })
  @Returns(permissionsRevokeReturnSchema)
  revoke(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" })
    subject: string,
    @Arg("relation", { description: "Relation" }) relation: string,
    @Arg("object", { description: "Object (e.g., system:*, group:contacts)" })
    object: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);
    if (objectType === "toolgroup" && objectId !== "*" && !TOOL_GROUPS[objectId]) {
      fail(`Unknown tool group: "${objectId}". Available: ${Object.keys(TOOL_GROUPS).join(", ")}`);
      return;
    }

    const exactFilter: RelationFilter = {
      subjectType,
      subjectId,
      relation,
      objectType,
      objectId,
    };
    const relationBefore =
      listRelations(exactFilter)[0] ?? relationTuple(subjectType, subjectId, relation, objectType, objectId);
    const deleted = revokeRelation(subjectType, subjectId, relation, objectType, objectId);
    if (deleted) {
      if (!asJson) {
        console.log(`✓ Revoked: (${subject}) ${relation} (${object})`);
      }

      // Warn about remaining individual grants after revoking wildcard
      const remaining =
        objectId === "*"
          ? listRelations({
              subjectType,
              subjectId,
              relation,
              objectType,
            }).filter((r) => r.objectId !== "*")
          : [];
      if (objectId === "*") {
        if (remaining.length > 0) {
          if (!asJson) {
            console.log(`⚠ ${remaining.length} individual relation(s) still active:`);
            for (const r of remaining.slice(0, 10)) {
              console.log(`    ${objectType}:${r.objectId}`);
            }
            if (remaining.length > 10) {
              console.log(`    ... and ${remaining.length - 10} more`);
            }
          }
        }
      }

      const payload = {
        status: "revoked",
        target: relationTarget(subject, relation, object),
        changedCount: 1,
        relation: "id" in relationBefore ? serializeRelation(relationBefore) : relationBefore,
        remainingIndividualRelations: remaining.map(serializeRelation),
      };
      if (asJson) {
        printJson(payload);
      }
      return payload;
    } else {
      fail("Relation not found");
    }
  }

  @Command({
    name: "check",
    description: "Check if a subject has a permission on an object",
  })
  @Returns(permissionsCheckReturnSchema)
  check(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" })
    subject: string,
    @Arg("permission", {
      description: "Permission (e.g., execute, access, admin)",
    })
    permission: string,
    @Arg("object", {
      description: "Object (e.g., group:contacts, session:dev-grupo1)",
    })
    object: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);

    const allowed = can(subjectType, subjectId, permission, objectType, objectId);
    const payload = {
      subject: { raw: subject, type: subjectType, id: subjectId },
      permission,
      object: { raw: object, type: objectType, id: objectId },
      allowed,
    };
    if (asJson) {
      printJson(payload);
    } else if (allowed) {
      console.log(`✓ ALLOWED: (${subject}) ${permission} (${object})`);
    } else {
      console.log(`✗ DENIED: (${subject}) ${permission} (${object})`);
    }
    return payload;
  }

  @Command({ name: "list", description: "List relations" })
  @Returns(permissionsListReturnSchema)
  list(
    @Option({
      flags: "--subject <s>",
      description: "Filter by subject (e.g., agent:dev)",
    })
    subject?: string,
    @Option({
      flags: "--object <o>",
      description: "Filter by object (e.g., group:contacts)",
    })
    object?: string,
    @Option({ flags: "--relation <r>", description: "Filter by relation" })
    relation?: string,
    @Option({
      flags: "--source <src>",
      description: "Filter by source (config|manual)",
    })
    source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--limit <n>",
      description: "Page size (default: 50, max: 500)",
    })
    limit?: string,
    @Option({
      flags: "--offset <n>",
      description: "Number of matching relations to skip (default: 0)",
    })
    offset?: string,
    @Option({
      flags: "--all",
      description: "Include expired and revoked relations",
    })
    includeInactive?: boolean,
  ) {
    const filter: RelationFilter = {};

    if (subject) {
      const [type, id] = parseEntity(subject);
      filter.subjectType = type;
      filter.subjectId = id;
    }
    if (object) {
      const [type, id] = parseEntity(object);
      filter.objectType = type;
      filter.objectId = id;
    }
    if (relation) filter.relation = relation;
    if (source) filter.source = source;
    if (includeInactive) filter.includeInactive = true;

    const relations = listRelations(Object.keys(filter).length > 0 ? filter : undefined);
    const page = paginateCliItems(relations, { limit, offset });
    const pageRelations = page.items;
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "permissions", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: pageRelations.length,
      total: page.total,
      options: [
        "--subject",
        subject,
        "--object",
        object,
        "--relation",
        relation,
        "--source",
        source,
        includeInactive && "--all",
      ],
    });

    if (asJson) {
      const payload = {
        total: page.total,
        pagination,
        filter,
        items: pageRelations.map(serializeRelation),
        relations: pageRelations.map(serializeRelation),
      };
      printJson(payload);
      return payload;
    }

    if (pageRelations.length === 0) {
      console.log("No relations found.");
      return {
        total: page.total,
        pagination,
        filter,
        items: pageRelations.map(serializeRelation),
        relations: pageRelations.map(serializeRelation),
      };
    }

    console.log(
      `\nRelations (${pageRelations.length} returned of ${page.total}, limit ${page.limit}, offset ${page.offset}):\n`,
    );
    console.log("  SUBJECT              RELATION              OBJECT                SOURCE   LIFETIME");
    console.log("  -------------------  --------------------  --------------------  -------  --------");

    for (const r of pageRelations) {
      const sub = `${r.subjectType}:${r.subjectId}`.padEnd(19);
      const rel = r.relation.padEnd(20);
      let objStr = `${r.objectType}:${r.objectId}`;
      if (r.objectType === "toolgroup" && r.objectId !== "*") {
        const members = resolveToolGroup(r.objectId);
        if (members) objStr += ` (${members.join(", ")})`;
      }
      const obj = objStr.padEnd(20);
      const src = r.source.padEnd(7);
      console.log(`  ${sub}  ${rel}  ${obj}  ${src}  ${formatRelationLifetime(r)}`);
    }
    if (pagination.nextCommand) {
      console.log("\nNext page:");
      console.log(`  ${pagination.nextCommand}`);
    }
    return {
      total: page.total,
      pagination,
      filter,
      items: pageRelations.map(serializeRelation),
      relations: pageRelations.map(serializeRelation),
    };
  }

  @Command({
    name: "sync",
    description: "Re-sync relations from agent configs",
  })
  @Returns(permissionsSyncReturnSchema)
  sync(
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    syncRelationsFromConfig();
    const relations = listRelations({ source: "config" });
    const payload = {
      status: "synced",
      target: { type: "permission-relations", source: "config" },
      changedCount: relations.length,
      relations: relations.map(serializeRelation),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`✓ Synced ${relations.length} config relations`);
    return payload;
  }

  @Command({
    name: "init",
    description: "Apply a permission template to an agent",
  })
  @Returns(permissionsInitReturnSchema)
  init(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" })
    subject: string,
    @Arg("template", {
      description: "Template: sdk-tools, all-tools, safe-executables, full-access, tool-groups",
    })
    template: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--ttl <duration>",
      description: "Temporary grant TTL (default: 1h; examples: 15m, 2h, 7d)",
    })
    ttl?: string,
    @Option({
      flags: "--expires-at <time>",
      description: "Temporary grant expiration as ISO time or epoch seconds",
    })
    expiresAt?: string,
    @Option({
      flags: "--permanent",
      description: "Create explicit permanent grants",
    })
    permanent?: boolean,
    @Option({
      flags: "--reason <text>",
      description: "Reason stored with the grants",
    })
    reason?: string,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const grantOptions = buildGrantOptions({
      ttl,
      expiresAt,
      permanent,
      reason,
    });
    const grantedRelations: Relation[] = [];
    const grantManual = (relation: string, objectType: string, objectId: string) => {
      const granted = grantRelation(subjectType, subjectId, relation, objectType, objectId, "manual", grantOptions);
      if (granted) grantedRelations.push(granted);
    };

    const templates: Record<string, () => number> = {
      "sdk-tools": () => {
        let count = 0;
        for (const tool of SDK_TOOLS) {
          grantManual("use", "tool", tool);
          count++;
        }
        return count;
      },
      "all-tools": () => {
        grantManual("use", "tool", "*");
        return 1;
      },
      "safe-executables": () => {
        let count = 0;
        for (const cli of [...getDefaultAllowlist(), "ravi"]) {
          grantManual("execute", "executable", cli);
          count++;
        }
        return count;
      },
      "full-access": () => {
        // Wildcards across every (relation, objectType) pair the REBAC engine recognises.
        // Covers SDK tools, system executables, tool groups, AND the in-process REBAC types
        // used by command/scope checks (agent, contact, cron, group, session, system, team,
        // toolgroup, trigger). Prior versions of this template only granted use:tool:* and
        // execute:executable:*, which left agents unable to operate against the runtime even
        // though the template name promised "full". Pairs listed here mirror what
        // `ravi permissions list` shows in production.
        const wildcards: Array<[string, string]> = [
          ["use", "tool"],
          ["execute", "executable"],
          ["use", "toolgroup"],
          ["access", "toolgroup"],
          ["admin", "toolgroup"],
          ["access", "agent"],
          ["admin", "agent"],
          ["access", "automation"],
          ["admin", "automation"],
          ["use", "app"],
          ["execute", "app"],
          ["read", "calendar"],
          ["write", "calendar"],
          ["free-busy", "calendar"],
          ["sync", "calendar"],
          ["sync", "calendar-provider"],
          ["access", "chat"],
          ["admin", "chat"],
          ["access", "contact"],
          ["admin", "contact"],
          ["write_contacts", "contact"],
          ["access", "cron"],
          ["admin", "cron"],
          ["access", "group"],
          ["admin", "group"],
          ["execute", "group"],
          ["read", "mailbox"],
          ["send", "mailbox"],
          ["sync", "mailbox"],
          ["sync", "mail-provider"],
          ["access", "network"],
          ["access", "platform_identity"],
          ["admin", "platform_identity"],
          ["access", "session"],
          ["modify", "session"],
          ["use", "session"],
          ["access", "system"],
          ["admin", "system"],
          ["read_own_contacts", "system"],
          ["read_tagged_contacts", "system"],
          ["write_contacts", "system"],
          ["access", "team"],
          ["admin", "team"],
          ["access", "trigger"],
          ["admin", "trigger"],
        ];
        for (const [relation, objectType] of wildcards) {
          grantManual(relation, objectType, "*");
        }
        return wildcards.length;
      },
      "tool-groups": () => {
        let count = 0;
        for (const groupName of Object.keys(TOOL_GROUPS)) {
          grantManual("use", "toolgroup", groupName);
          count++;
        }
        return count;
      },
    };

    const fn = templates[template];
    if (!fn) {
      fail(`Unknown template: "${template}". Available: ${Object.keys(templates).join(", ")}`);
      return;
    }

    const count = fn();
    notifyPermissionGrantsCreated(grantedRelations);
    const relations = listRelations({
      subjectType,
      subjectId,
      source: "manual",
    });
    const payload = {
      status: "applied" as const,
      target: { type: "permission-template" as const, subject, template },
      changedCount: count,
      relations: relations.map(serializeRelation),
    };
    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Applied template "${template}" to ${subject} (${count} relation(s))`);
    }
    return payload;
  }

  @Command({ name: "clear", description: "Clear all manual relations" })
  @Returns(permissionsClearReturnSchema)
  clear(
    @Option({
      flags: "--all",
      description: "Clear ALL relations (including config)",
    })
    all?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    const count = all ? clearRelations() : clearRelations({ source: "manual" });
    const payload = {
      status: "cleared" as const,
      target: {
        type: "permission-relations" as const,
        source: all ? ("all" as const) : ("manual" as const),
      },
      changedCount: count,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(`✓ Cleared ${count} relation(s)`);
      if (all) {
        console.log("Run 'ravi permissions sync' to regenerate config relations.");
      }
    }
    return payload;
  }
}

/** Valid relations recognized by the engine */
const VALID_RELATIONS = new Set([
  "admin", // superadmin: (agent, admin, system, *)
  "use", // SDK tools: (agent, use, tool, Bash)
  "execute", // executables + CLI groups: (agent, execute, executable, git) or (agent, execute, group, contacts)
  "access", // sessions: (agent, access, session, dev-*)
  "modify", // sessions: (agent, modify, session, dev-*)
  "write_contacts", // contacts: (agent, write_contacts, system, *)
  "read_own_contacts", // contacts: (agent, read_own_contacts, system, *)
  "read_tagged_contacts", // contacts: (agent, read_tagged_contacts, system, tag)
  "read_contact", // contacts: (agent, read_contact, contact, id)
  "view", // agents: (agent, view, agent, id)
  "member", // roles: (contact, member, role, operators)
  "read",
  "write",
  "send",
  "sync",
  "free-busy",
]);

/** Valid entity types for relations */
const VALID_ENTITY_TYPES = new Set([
  "agent",
  "system",
  "group",
  "session",
  "contact",
  "cron",
  "trigger",
  "team",
  "tool",
  "executable",
  "toolgroup",
  "chat",
  "role",
  "app",
  "automation",
  "platform_identity",
  "mailbox",
  "mail-provider",
  "calendar",
  "calendar-provider",
  "network",
]);

/**
 * Validate that a relation name is recognized by the engine.
 */
function validateRelation(relation: string): void {
  if (!VALID_RELATIONS.has(relation)) {
    fail(`Unknown relation: "${relation}". Valid relations: ${[...VALID_RELATIONS].join(", ")}`);
  }
}

/**
 * Parse "type:id" entity notation.
 * e.g., "agent:dev" → ["agent", "dev"]
 *        "system:*" → ["system", "*"]
 *        "group:contacts" → ["group", "contacts"]
 */
function parseEntity(entity: string): [string, string] {
  const idx = entity.indexOf(":");
  if (idx === -1) {
    fail(`Invalid entity format: "${entity}". Expected "type:id" (e.g., agent:dev, group:contacts)`);
    return ["", ""];
  }
  const type = entity.slice(0, idx);
  const id = entity.slice(idx + 1);
  if (!VALID_ENTITY_TYPES.has(type)) {
    fail(`Unknown entity type: "${type}". Valid types: ${[...VALID_ENTITY_TYPES].join(", ")}`);
    return ["", ""];
  }
  if (!id) {
    fail(`Empty entity id in "${entity}"`);
    return ["", ""];
  }
  return [type, id];
}

function relationTarget(subject: string, relation: string, object: string) {
  return {
    type: "permission-relation",
    subject,
    relation,
    object,
  };
}

function relationTuple(subjectType: string, subjectId: string, relation: string, objectType: string, objectId: string) {
  return {
    subjectType,
    subjectId,
    subject: `${subjectType}:${subjectId}`,
    relation,
    objectType,
    objectId,
    object: `${objectType}:${objectId}`,
  };
}

function serializeRelation(relation: Relation) {
  const serialized: Record<string, unknown> = {
    ...relation,
    subject: `${relation.subjectType}:${relation.subjectId}`,
    object: `${relation.objectType}:${relation.objectId}`,
    active: isRelationActive(relation),
  };

  if (relation.objectType === "toolgroup" && relation.objectId !== "*") {
    serialized.objectMembers = resolveToolGroup(relation.objectId) ?? [];
  }

  return serialized;
}

function buildGrantOptions(input: {
  ttl?: string;
  expiresAt?: string;
  permanent?: boolean;
  reason?: string;
}): GrantRelationOptions {
  if (input.permanent && (input.ttl || input.expiresAt)) {
    fail("--permanent cannot be combined with --ttl or --expires-at");
  }

  return {
    permanent: input.permanent === true,
    ttlMs: input.ttl ? parseDurationMs(input.ttl, "--ttl") : undefined,
    expiresAt: input.expiresAt ? parseExpiresAt(input.expiresAt) : undefined,
    reason: input.reason,
    issuedBy: resolveIssuedBy(),
  };
}

function parseDurationMs(value: string, label: string): number {
  const trimmed = value.trim();
  const match = /^(\d+)(ms|s|m|h|d|w)?$/i.exec(trimmed);
  if (!match) {
    fail(`${label} must be a duration like 15m, 2h, 7d, or seconds as a bare number.`);
  }
  const amount = Number(match?.[1]);
  const unit = (match?.[2] ?? "s").toLowerCase();
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 3_600_000
            : unit === "d"
              ? 86_400_000
              : 604_800_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    fail(`${label} must be a positive safe duration.`);
  }
  return duration;
}

function parseExpiresAt(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }

  const timestampMs = Date.parse(trimmed);
  if (!Number.isFinite(timestampMs)) {
    fail("--expires-at must be an ISO timestamp or epoch seconds.");
  }
  return Math.floor(timestampMs / 1000);
}

function resolveIssuedBy(): string | null {
  const ctx = getContext();
  if (ctx?.contextId) return `context:${ctx.contextId}`;
  if (ctx?.sessionName) return `session:${ctx.sessionName}`;
  if (ctx?.sessionKey) return `session:${ctx.sessionKey}`;
  if (ctx?.agentId) return `agent:${ctx.agentId}`;
  return "operator:cli";
}

function formatLifetime(relation: Relation | null): string {
  if (!relation) return `  lifetime: temporary, default ttl ${Math.round(DEFAULT_MANUAL_GRANT_TTL_MS / 1000)}s`;
  return `  lifetime: ${formatRelationLifetime(relation)}`;
}

function formatRelationLifetime(relation: Relation): string {
  if (relation.revokedAt) return `revoked ${formatEpochSeconds(relation.revokedAt)}`;
  if (relation.grantMode === "temporary") {
    if (!relation.expiresAt) return "temporary";
    return relation.expiresAt <= Math.floor(Date.now() / 1000)
      ? `expired ${formatEpochSeconds(relation.expiresAt)}`
      : `temporary until ${formatEpochSeconds(relation.expiresAt)}`;
  }
  return "permanent";
}

function isRelationActive(relation: Relation): boolean {
  if (relation.revokedAt) return false;
  return !relation.expiresAt || relation.expiresAt > Math.floor(Date.now() / 1000);
}

function formatEpochSeconds(value: number): string {
  return new Date(value * 1000).toISOString();
}
