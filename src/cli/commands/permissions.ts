/**
 * Permissions Commands - legacy relation-ledger management CLI.
 */

import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Group, Command, Arg, Option, Returns } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { buildCliOffsetPagination, paginateCliItems } from "../pagination.js";
import {
  DEFAULT_MANUAL_GRANT_TTL_MS,
  canSubjectWithLocalGrants,
  grantRelation,
  revokeRelation,
  revokeRelationIfSource,
  hasRelation,
  listRelations,
  clearRelations,
  restoreRelationsRevocationBatch,
  restoreRelationsRevokedAt,
  pruneRevokedRelations,
  syncRelationsFromConfig,
  type RelationFilter,
  type Relation,
  type GrantRelationOptions,
} from "../../permissions/local-grants-provider.js";
import { DELEGATION_OVERRIDE_RELATION_PREFIX, DENY_RELATION_PREFIX } from "../../permissions/delegation.js";
import {
  explainPermissionDecision,
  explainPermissionDenial,
  type ExplainPermissionDecision,
} from "../../permissions/explain.js";
import { notifyPermissionGrantCreated, notifyPermissionGrantsCreated } from "../../permissions/grant-notifications.js";
import {
  applyPermissionPolicies,
  dryRunPermissionPolicies,
  explainPermissionPoliciesForAsset,
  listPermissionPolicyMaterializations,
  loadPermissionPolicyRulesFromDirectory,
  reconcilePermissionPolicies,
  validatePermissionPolicies,
  type PermissionPolicyRunResult,
} from "../../permissions/policies.js";
import { SDK_TOOLS, TOOL_GROUPS, resolveToolGroup } from "../tool-registry.js";
import { getDefaultAllowlist } from "../../bash/permissions.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

const LEGACY_LOCAL_GRANTS_MUTATION_ENV = "RAVI_ENABLE_LEGACY_LOCAL_GRANTS_MUTATION";

function assertLegacyLocalGrantsMutationEnabled(commandName: string): void {
  if (process.env[LEGACY_LOCAL_GRANTS_MUTATION_ENV] === "1") return;
  fail(
    `Legacy local-grants mutation is disabled for '${commandName}'. ` +
      `The active runtime uses permission providers. Set ${LEGACY_LOCAL_GRANTS_MUTATION_ENV}=1 only for explicit migration/repair work.`,
  );
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
    revocationBatchId: z.string().nullable().optional(),
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

const permissionsExplainReturnSchema = z.object({}).passthrough();
const permissionsLegacyReturnSchema = z.object({}).passthrough();
const permissionPolicyRunReturnSchema = z.object({}).passthrough();
const permissionPolicyListReturnSchema = z.object({}).passthrough();

@Group({
  name: "permissions",
  description: "Legacy relation-ledger management",
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
    assertLegacyLocalGrantsMutationEnabled("permissions grant");
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
    assertLegacyLocalGrantsMutationEnabled("permissions revoke");
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
    description: "Check if the legacy relation ledger would allow a subject on an object",
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

    const allowed = canSubjectWithLocalGrants(subjectType, subjectId, permission, objectType, objectId);
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

  @Command({
    name: "explain",
    description: "Explain a permission decision using the enforcement evaluator",
  })
  @Returns(permissionsExplainReturnSchema)
  explain(
    @Arg("relation", {
      required: false,
      description: "Relation to explain (e.g., execute, use)",
    })
    relation?: string,
    @Arg("object", {
      required: false,
      description: "Object to explain (e.g., group:sessions_info)",
    })
    object?: string,
    @Option({ flags: "--agent <id>", description: "Executor agent id or agent:<id>" })
    agent?: string,
    @Option({ flags: "--actor <principal>", description: "Actor principal, e.g. contact:luis" })
    actor?: string,
    @Option({ flags: "--chat <id>", description: "Surface chat id or chat:<id>" })
    chat?: string,
    @Option({ flags: "--session <key>", description: "Session key/name for context" })
    sessionKey?: string,
    @Option({ flags: "--denial <id>", description: "Reconstruct and re-evaluate a recorded denial" })
    denialId?: string,
    @Option({ flags: "--broad", description: "Allow wildcard recommendations in output" })
    broad?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
  ) {
    if (denialId) {
      const payload = explainPermissionDenial(parsePositiveInt(denialId, "--denial"), {
        broadRecommendations: broad === true,
      });
      if (asJson) {
        printJson(payload);
      } else {
        printExplainHuman(payload.current, payload.currentlyDenied ? "currently denied" : "currently allowed");
      }
      return payload;
    }

    if (!relation || !object || !agent) {
      fail(
        "Usage: ravi permissions explain <relation> <object> --agent <agent-id> [--actor contact:<id>] [--chat <id>]",
      );
      throw new Error("unreachable");
    }
    validateRelation(relation);
    const [objectType, objectId] = parseEntity(object);
    const agentId = normalizeAgentOption(agent);
    const normalizedActor = actor ? normalizePrincipalOption(actor, "--actor") : null;
    const normalizedChat = chat ? normalizeChatOption(chat) : null;
    const payload = explainPermissionDecision({
      relation,
      objectType,
      objectId,
      agentId,
      actor: normalizedActor,
      chat: normalizedChat,
      sessionKey,
      broadRecommendations: broad === true,
    });

    if (asJson) {
      printJson(payload);
    } else {
      printExplainHuman(payload);
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
    assertLegacyLocalGrantsMutationEnabled("permissions sync");
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
    assertLegacyLocalGrantsMutationEnabled("permissions init");
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
        // Wildcards across every (relation, objectType) pair the legacy ledger recognises.
        // Covers SDK tools, system executables, tool groups, and in-process permission types.
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

  @Command({
    name: "legacy",
    description: "Plan or revoke legacy manual permanent grants",
  })
  @Returns(permissionsLegacyReturnSchema)
  legacy(
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--apply",
      description: "Revoke the selected legacy grants. Requires --confirm legacy-cleanup.",
    })
    apply?: boolean,
    @Option({
      flags: "--confirm <text>",
      description: "Required with --apply; must be exactly legacy-cleanup",
    })
    confirm?: string,
    @Option({
      flags: "--include-specific",
      description: "Also include object-specific manual permanent grants, not only wildcards/patterns",
    })
    includeSpecific?: boolean,
    @Option({
      flags: "--subject <s>",
      description: "Limit cleanup to one subject, e.g. agent:dev or chat:chat_id",
    })
    subject?: string,
    @Option({
      flags: "--limit <n>",
      description: "Maximum number of candidate grants to include/apply in this run",
    })
    limit?: string,
    @Option({
      flags: "--max-zero-subjects <n>",
      description: "Maximum subjects allowed to lose all active grants before requiring --break-glass (default: 5)",
    })
    maxZeroSubjectsOption?: string,
    @Option({
      flags: "--break-glass",
      description: "Explicitly allow high-impact cleanup after reviewing blast radius",
    })
    breakGlass?: boolean,
  ) {
    if (apply && confirm !== "legacy-cleanup") {
      fail("--apply requires --confirm legacy-cleanup");
    }

    const filter: RelationFilter = { source: "manual" };
    if (subject) {
      const [subjectType, subjectId] = parseEntity(subject);
      filter.subjectType = subjectType;
      filter.subjectId = subjectId;
    }

    const maxCandidates = limit ? parsePositiveInt(limit, "--limit") : null;
    const allCandidates = listRelations(filter).filter((relation) =>
      isLegacyManualPermanentRelation(relation, includeSpecific === true),
    );
    const candidates = maxCandidates ? allCandidates.slice(0, maxCandidates) : allCandidates;
    const activeBefore = listRelations();
    const blastRadius = simulateRevocationBlastRadius(activeBefore, candidates);
    const selfPreservation = detectSelfPreservation(candidates, activeBefore);
    const maxZeroSubjects = maxZeroSubjectsOption ? parsePositiveInt(maxZeroSubjectsOption, "--max-zero-subjects") : 5;
    const revoked: Relation[] = [];
    const stale: Relation[] = [];
    const revokedAt = Math.floor(Date.now() / 1000);
    const revocationBatchId = createRevocationBatchId();

    if (apply) {
      if (blastRadius.zeroedSubjectsCount > 0 && breakGlass !== true) {
        fail(
          `Legacy cleanup would leave ${blastRadius.zeroedSubjectsCount} subject(s) with zero active grants; review dry-run and pass --break-glass to apply.`,
        );
      }
      if (blastRadius.zeroedSubjectsCount > maxZeroSubjects && breakGlass !== true) {
        fail(
          `Legacy cleanup blast radius exceeds --max-zero-subjects (${blastRadius.zeroedSubjectsCount} > ${maxZeroSubjects}); pass --break-glass after review.`,
        );
      }
      if (selfPreservation.detected && breakGlass !== true) {
        fail(
          "Legacy cleanup detected possible self-preservation by the current runtime principal; pass --break-glass only after human review.",
        );
      }
      for (const relation of candidates) {
        const didRevoke = revokeRelationIfSource(
          relation.subjectType,
          relation.subjectId,
          relation.relation,
          relation.objectType,
          relation.objectId,
          "manual",
          { revokedAt, revocationBatchId },
        );
        if (didRevoke) {
          revoked.push(relation);
        } else {
          stale.push(relation);
        }
      }
    }

    const payload = {
      status: apply ? ("applied" as const) : ("planned" as const),
      dryRun: !apply,
      target: {
        type: "legacy-permission-grants" as const,
        source: "manual" as const,
        grantMode: "permanent" as const,
        includeSpecific: includeSpecific === true,
        subject: subject ?? null,
        limit: maxCandidates,
      },
      totalCandidates: allCandidates.length,
      selectedCount: candidates.length,
      changedCount: revoked.length,
      revokedAt: apply ? revokedAt : null,
      revocationBatchId: apply ? revocationBatchId : null,
      blastRadius,
      selfPreservation,
      staleCount: stale.length,
      summary: summarizeLegacyRelations(candidates),
      sample: candidates.slice(0, 25).map(serializeRelation),
      revoked: apply ? revoked.map(serializeRelation) : [],
      stale: stale.map(serializeRelation),
    };

    if (asJson) {
      printJson(payload);
      return payload;
    }

    console.log(
      `${apply ? "✓ Applied" : "✓ Planned"} legacy permission cleanup: ` +
        `${candidates.length}/${allCandidates.length} candidate relation(s)` +
        (apply ? `, ${revoked.length} revoked` : ""),
    );
    console.log(
      `  filter: manual permanent ${includeSpecific ? "all" : "wildcard/pattern"} grants` +
        (subject ? ` for ${subject}` : ""),
    );
    if (!apply) {
      console.log("  dry-run: pass --apply --confirm legacy-cleanup to revoke the selected candidates");
    } else if (stale.length > 0) {
      console.log(`  skipped stale/raced relation(s): ${stale.length}`);
    }
    printLegacySummary(payload.summary);
    for (const relation of candidates.slice(0, 20)) {
      console.log(
        `  ${relation.subjectType}:${relation.subjectId} ${relation.relation} ` +
          `${relation.objectType}:${relation.objectId}`,
      );
    }
    if (candidates.length > 20) {
      console.log(`  ... and ${candidates.length - 20} more candidate relation(s)`);
    }
    return payload;
  }

  @Command({
    name: "restore-batch",
    description: "Plan or restore relations revoked in the same batch",
  })
  @Returns(permissionsLegacyReturnSchema)
  restoreBatch(
    @Arg("batch", { description: "Revocation batch id. Use --revoked-at only for legacy timestamp fallback." })
    batchArg: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--apply",
      description: "Restore the batch. Requires --confirm restore-revocation.",
    })
    apply?: boolean,
    @Option({
      flags: "--confirm <text>",
      description: "Required with --apply; must be exactly restore-revocation",
    })
    confirm?: string,
    @Option({
      flags: "--revoked-at",
      description: "Interpret the batch argument as a legacy revoked_at timestamp",
    })
    byRevokedAt?: boolean,
    @Option({
      flags: "--subject <s>",
      description: "Restore only this subject's revoked grants in the batch, e.g. agent:dev or chat:chat_id",
    })
    subject?: string,
  ) {
    if (apply && confirm !== "restore-revocation") {
      fail("--apply requires --confirm restore-revocation");
    }
    if (apply) assertLegacyLocalGrantsMutationEnabled("permissions restore-batch --apply");
    const subjectFilter: { subjectType?: string; subjectId?: string } = {};
    if (subject) {
      const [subjectType, subjectId] = parseEntity(subject);
      subjectFilter.subjectType = subjectType;
      subjectFilter.subjectId = subjectId;
    }
    const revokedAt = byRevokedAt ? parseRevocationTimestamp(batchArg) : null;
    const result = revokedAt
      ? restoreRelationsRevokedAt(revokedAt, { apply: apply === true, ...subjectFilter })
      : restoreRelationsRevocationBatch(batchArg, { apply: apply === true, ...subjectFilter });
    const payload = {
      status: apply ? ("restored" as const) : ("planned" as const),
      dryRun: !apply,
      target: {
        type: "revocation-batch" as const,
        batch: batchArg,
        revokedAt,
        subject: subject ?? null,
      },
      matchedCount: result.matched,
      changedCount: result.restored,
      sample: result.relations.slice(0, 25).map(serializeRelation),
      relations: result.relations.map(serializeRelation),
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(
        `${apply ? "✓ Restored" : "✓ Planned restore for"} revocation batch ${batchArg}` +
          `${subject ? ` (subject ${subject})` : ""}: ${result.matched} relation(s)`,
      );
    }
    return payload;
  }

  @Command({
    name: "prune-revoked",
    description: "Compact the relation store by deleting old revoked relations",
  })
  @Returns(permissionsLegacyReturnSchema)
  pruneRevoked(
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({
      flags: "--apply",
      description: "Delete the matched revoked relations. Requires --confirm prune-revoked.",
    })
    apply?: boolean,
    @Option({
      flags: "--confirm <text>",
      description: "Required with --apply; must be exactly prune-revoked",
    })
    confirm?: string,
    @Option({
      flags: "--older-than-days <n>",
      description: "Only prune relations revoked at least N days ago (default: 90)",
    })
    olderThanDays?: string,
  ) {
    if (apply && confirm !== "prune-revoked") {
      fail("--apply requires --confirm prune-revoked");
    }
    if (apply) assertLegacyLocalGrantsMutationEnabled("permissions prune-revoked --apply");
    const days = olderThanDays != null ? parsePositiveInt(olderThanDays, "--older-than-days") : 90;
    const result = pruneRevokedRelations({ apply: apply === true, olderThanSeconds: days * 24 * 60 * 60 });
    const payload = {
      status: apply ? ("pruned" as const) : ("planned" as const),
      dryRun: !apply,
      target: {
        type: "revoked-relations" as const,
        olderThanDays: days,
        cutoff: result.cutoff,
      },
      matchedCount: result.matched,
      changedCount: result.pruned,
    };

    if (asJson) {
      printJson(payload);
    } else {
      console.log(
        `${apply ? "✓ Pruned" : "✓ Planned prune of"} ${result.matched} revoked relation(s) older than ${days} day(s)` +
          (apply ? "" : "; pass --apply --confirm prune-revoked to delete"),
      );
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
    assertLegacyLocalGrantsMutationEnabled("permissions clear");
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

@Group({
  name: "permissions.policies",
  description: "Tag-driven permission policies",
  scope: "superadmin",
})
export class PermissionPolicyCommands {
  @Command({ name: "list", description: "List permission policies" })
  @Returns(permissionPolicyListReturnSchema)
  list(
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--dir <path>", description: "Policy directory (default: $RAVI_STATE_DIR/permission-policies)" })
    directory?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" })
    limit?: string,
    @Option({ flags: "--offset <n>", description: "Number of policies to skip (default: 0)" })
    offset?: string,
  ) {
    const loaded = loadPermissionPolicyRulesFromDirectory(directory);
    const allPolicies = loaded.rules.map((item) => ({
      id: item.rule.id,
      version: item.rule.version,
      enabled: item.rule.enabled,
      selector: item.rule.selector,
      emits: item.rule.emits.length,
      source: item.source,
    }));
    const page = paginateCliItems(allPolicies, { limit, offset });
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "permissions", "policies", "list"],
      limit: page.limit,
      offset: page.offset,
      returned: page.items.length,
      total: page.total,
      options: ["--dir", directory],
    });
    const payload = {
      total: loaded.rules.length,
      errors: loaded.errors,
      pagination,
      policies: page.items,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (payload.policies.length === 0) {
      console.log("No permission policies found.");
    } else {
      console.log(`Permission policies (${payload.policies.length}/${payload.total}):`);
      for (const policy of payload.policies) {
        console.log(
          `  ${policy.enabled ? "✓" : "✗"} ${policy.id}@${policy.version} ${policy.selector.assetType}:${policy.selector.tag}`,
        );
      }
    }
    printPolicyErrors(payload.errors);
    return payload;
  }

  @Command({ name: "show", description: "Show a permission policy and its materializations" })
  @Returns(permissionPolicyListReturnSchema)
  show(
    @Arg("policy", { description: "Policy id" })
    policyId: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--dir <path>", description: "Policy directory (default: $RAVI_STATE_DIR/permission-policies)" })
    directory?: string,
  ) {
    const validation = validatePermissionPolicies({ directory, policyId });
    const materializations = listPermissionPolicyMaterializations(policyId);
    const payload = {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
      policies: validation.rules.map((item) => ({
        rule: item.rule,
        source: item.source,
      })),
      materializations,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (payload.policies.length === 0) {
      console.log(`Policy not found: ${policyId}`);
    } else {
      const item = payload.policies[0]!;
      console.log(`${item.rule.enabled ? "✓" : "✗"} ${item.rule.id}@${item.rule.version}`);
      console.log(`  selector: ${item.rule.selector.assetType}:${item.rule.selector.tag}`);
      console.log(`  emits: ${item.rule.emits.length}`);
      console.log(`  materializations: ${materializations.length}`);
    }
    printPolicyErrors(payload.errors);
    printPolicyWarnings(payload.warnings);
    return payload;
  }

  @Command({ name: "validate", description: "Validate permission policies" })
  @Returns(permissionPolicyRunReturnSchema)
  validate(
    @Arg("policy", { required: false, description: "Optional policy id" })
    policyId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--dir <path>", description: "Policy directory (default: $RAVI_STATE_DIR/permission-policies)" })
    directory?: string,
  ) {
    const payload = validatePermissionPolicies({ directory, policyId });
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(payload.valid ? "✓ Permission policies valid" : "✗ Permission policies invalid");
    console.log(`  policies: ${payload.rules.length}`);
    printPolicyErrors(payload.errors);
    printPolicyWarnings(payload.warnings);
    return payload;
  }

  @Command({ name: "dry-run", description: "Plan permission policy materialization without writing" })
  @Returns(permissionPolicyRunReturnSchema)
  dryRun(
    @Arg("policy", { required: false, description: "Optional policy id" })
    policyId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--dir <path>", description: "Policy directory (default: $RAVI_STATE_DIR/permission-policies)" })
    directory?: string,
  ) {
    const payload = dryRunPermissionPolicies({ directory, policyId });
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printPolicyRun(payload);
    return payload;
  }

  @Command({ name: "apply", description: "Apply permission policies and materialize grants" })
  @Returns(permissionPolicyRunReturnSchema)
  apply(
    @Arg("policy", { required: false, description: "Optional policy id" })
    policyId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--dir <path>", description: "Policy directory (default: $RAVI_STATE_DIR/permission-policies)" })
    directory?: string,
  ) {
    assertLegacyLocalGrantsMutationEnabled("permissions policies apply");
    const payload = applyPermissionPolicies({ directory, policyId });
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printPolicyRun(payload);
    return payload;
  }

  @Command({ name: "reconcile", description: "Apply policies and revoke stale policy-owned grants" })
  @Returns(permissionPolicyRunReturnSchema)
  reconcile(
    @Arg("policy", { required: false, description: "Optional policy id" })
    policyId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--dir <path>", description: "Policy directory (default: $RAVI_STATE_DIR/permission-policies)" })
    directory?: string,
  ) {
    assertLegacyLocalGrantsMutationEnabled("permissions policies reconcile");
    const payload = reconcilePermissionPolicies({ directory, policyId });
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printPolicyRun(payload);
    return payload;
  }

  @Command({ name: "explain", description: "Explain policy matches for a tagged asset" })
  @Returns(permissionPolicyRunReturnSchema)
  explain(
    @Arg("asset", { description: "Asset selector, e.g. contact:c1 or chat:chat_id" })
    asset: string,
    @Option({ flags: "--json", description: "Print raw JSON result" })
    asJson?: boolean,
    @Option({ flags: "--dir <path>", description: "Policy directory (default: $RAVI_STATE_DIR/permission-policies)" })
    directory?: string,
  ) {
    const [assetType, assetId] = parseEntity(asset);
    const payload = explainPermissionPoliciesForAsset({ assetType, assetId, directory });
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Policy explain for ${payload.assetType}:${payload.assetId}`);
    console.log(`  valid: ${payload.valid ? "yes" : "no"}`);
    console.log(`  tags: ${payload.tags.length}`);
    console.log(`  desired actions: ${payload.actions.length}`);
    console.log(`  materializations: ${payload.materializations.length}`);
    printPolicyErrors(payload.errors);
    printPolicyWarnings(payload.warnings);
    for (const action of payload.actions.slice(0, 20)) {
      console.log(
        `  action: ${action.subjectType}:${action.subjectId} ${action.relation} ${action.objectType}:${action.objectId}`,
      );
    }
    if (payload.actions.length > 20) {
      console.log(`  ... and ${payload.actions.length - 20} more action(s)`);
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
  "constrain", // surfaces/apps constrained to a role/profile boundary
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
  if (isValidRelation(relation)) {
    return;
  }
  fail(
    `Unknown relation: "${relation}". Valid relations: ${[...VALID_RELATIONS].join(", ")} or ${DELEGATION_OVERRIDE_RELATION_PREFIX}<relation> or ${DENY_RELATION_PREFIX}<relation>`,
  );
}

function isValidRelation(relation: string): boolean {
  if (VALID_RELATIONS.has(relation)) return true;
  if (relation.startsWith(DELEGATION_OVERRIDE_RELATION_PREFIX)) {
    const baseRelation = relation.slice(DELEGATION_OVERRIDE_RELATION_PREFIX.length);
    return Boolean(baseRelation && baseRelation !== "admin" && VALID_RELATIONS.has(baseRelation));
  }
  if (relation.startsWith(DENY_RELATION_PREFIX)) {
    const baseRelation = relation.slice(DENY_RELATION_PREFIX.length);
    return Boolean(baseRelation && VALID_RELATIONS.has(baseRelation));
  }
  return false;
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

function normalizeAgentOption(value: string): string {
  if (value.startsWith("agent:")) {
    return parseEntity(value)[1];
  }
  if (!value.trim()) {
    fail("--agent cannot be empty");
  }
  return value;
}

function normalizePrincipalOption(value: string, optionName: string): string {
  const [type, id] = parseEntity(value);
  if (!["agent", "contact", "chat", "role", "automation", "platform_identity"].includes(type)) {
    fail(`${optionName} must be a subject principal, got ${type}:${id}`);
  }
  return `${type}:${id}`;
}

function normalizeChatOption(value: string): string {
  if (!value.includes(":")) {
    return `chat:${value}`;
  }
  const [type, id] = parseEntity(value);
  if (type !== "chat") {
    fail(`--chat must be chat:<id> or a raw chat id, got ${type}:${id}`);
  }
  return `${type}:${id}`;
}

function parseRevocationTimestamp(value: string): number {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  const millis = Date.parse(trimmed);
  if (Number.isFinite(millis)) {
    return Math.floor(millis / 1000);
  }
  fail(`Invalid revocation timestamp: ${value}`);
}

function printExplainHuman(payload: ExplainPermissionDecision, prefix?: string): void {
  const status = payload.final.allowed ? "ALLOWED" : "DENIED";
  console.log(
    `${payload.final.allowed ? "✓" : "✗"} ${status}: ${payload.request.agent} ${payload.request.relation} ${payload.request.object}`,
  );
  if (prefix) {
    console.log(`  ${prefix}`);
  }
  console.log(`  path: ${payload.final.path}`);
  console.log(`  reason: ${payload.final.reason}`);
  for (const branch of payload.branches) {
    console.log(`  ${branch.branch}: ${branch.verdict} (${branch.grantState}) ${branch.principal ?? ""}`.trimEnd());
  }
  if (payload.nearMissRelations.length > 0) {
    console.log(`  near-miss: ${payload.nearMissRelations.length} inactive relation(s) would have matched`);
  }
  if (payload.revocationEvents.length > 0) {
    console.log(`  revocation events: ${payload.revocationEvents.map((event) => event.id).join(", ")}`);
  }
}

function simulateRevocationBlastRadius(activeRelations: Relation[], candidates: Relation[]) {
  const candidateIds = new Set(candidates.map((relation) => relation.id));
  const beforeBySubject = countRelationsBySubject(activeRelations);
  const afterBySubject = countRelationsBySubject(activeRelations.filter((relation) => !candidateIds.has(relation.id)));
  const zeroedSubjects = [...beforeBySubject.keys()]
    .filter((subject) => beforeBySubject.get(subject)! > 0 && (afterBySubject.get(subject) ?? 0) === 0)
    .sort();
  const affectedSubjects = [...new Set(candidates.map((relation) => relationSubject(relation)))].sort();
  return {
    selectedRelationCount: candidates.length,
    affectedSubjectsCount: affectedSubjects.length,
    zeroedSubjectsCount: zeroedSubjects.length,
    zeroedSubjects: zeroedSubjects.slice(0, 25),
    byType: summarizeSubjectsByType(zeroedSubjects),
    sample: candidates.slice(0, 25).map(serializeRelation),
  };
}

function detectSelfPreservation(candidates: Relation[], activeRelations: Relation[]) {
  const ctx = getContext();
  const currentSubjects = currentRuntimeSubjects(ctx);
  if (currentSubjects.length === 0 || candidates.length === 0) {
    return { detected: false, subjects: [], preservedRelations: [] };
  }
  const candidateIds = new Set(candidates.map((relation) => relation.id));
  const minCandidateCreatedAt = Math.min(...candidates.map((relation) => relation.createdAt));
  const preservedRelations = activeRelations.filter(
    (relation) =>
      currentSubjects.includes(relationSubject(relation)) &&
      !candidateIds.has(relation.id) &&
      relation.source === "manual" &&
      relation.createdAt >= minCandidateCreatedAt,
  );
  return {
    detected: preservedRelations.length > 0,
    subjects: currentSubjects,
    preservedRelations: preservedRelations.slice(0, 10).map(serializeRelation),
  };
}

function currentRuntimeSubjects(ctx: ReturnType<typeof getContext>): string[] {
  const subjects: string[] = [];
  if (ctx?.agentId) subjects.push(`agent:${ctx.agentId}`);
  const metadata = ctx?.context?.metadata;
  for (const key of ["actorPrincipal", "surfacePrincipal"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.includes(":")) {
      subjects.push(value);
    }
  }
  return [...new Set(subjects)];
}

function countRelationsBySubject(relations: Relation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const relation of relations) {
    const subject = relationSubject(relation);
    counts.set(subject, (counts.get(subject) ?? 0) + 1);
  }
  return counts;
}

function relationSubject(relation: Relation): string {
  return `${relation.subjectType}:${relation.subjectId}`;
}

function summarizeSubjectsByType(subjects: string[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const subject of subjects) {
    const type = subject.split(":", 1)[0] ?? "unknown";
    summary[type] = (summary[type] ?? 0) + 1;
  }
  return summary;
}

function relationTarget(subject: string, relation: string, object: string) {
  return {
    type: "permission-relation",
    subject,
    relation,
    object,
  };
}

function createRevocationBatchId(): string {
  return `rev_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    fail(`${label} must be a positive integer.`);
  }
  return parsed;
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

function isLegacyManualPermanentRelation(relation: Relation, includeSpecific: boolean): boolean {
  if (!isRelationActive(relation)) return false;
  if (relation.source !== "manual") return false;
  if (relation.grantMode !== "permanent") return false;
  if (includeSpecific) return true;
  return isWildcardObjectId(relation.objectId);
}

function isWildcardObjectId(objectId: string): boolean {
  return objectId === "*" || objectId.endsWith("*");
}

function summarizeLegacyRelations(relations: Relation[]) {
  return {
    bySubjectType: countBy(relations, (relation) => relation.subjectType),
    byRelation: countBy(relations, (relation) => relation.relation),
    byObjectType: countBy(relations, (relation) => relation.objectType),
    topSubjects: topCounts(relations, (relation) => `${relation.subjectType}:${relation.subjectId}`, 10),
    topObjects: topCounts(relations, (relation) => `${relation.objectType}:${relation.objectId}`, 10),
  };
}

function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function topCounts<T>(items: T[], keyFn: (item: T) => string, limit: number): Array<{ key: string; count: number }> {
  return Object.entries(countBy(items, keyFn))
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function printLegacySummary(summary: ReturnType<typeof summarizeLegacyRelations>): void {
  const subjectTypes = Object.entries(summary.bySubjectType)
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");
  const objectTypes = Object.entries(summary.byObjectType)
    .map(([key, count]) => `${key}:${count}`)
    .join(", ");
  console.log(`  subject types: ${subjectTypes || "none"}`);
  console.log(`  object types: ${objectTypes || "none"}`);
  for (const item of summary.topSubjects.slice(0, 5)) {
    console.log(`  top subject: ${item.key} (${item.count})`);
  }
}

function formatEpochSeconds(value: number): string {
  return new Date(value * 1000).toISOString();
}

function printPolicyRun(payload: PermissionPolicyRunResult): void {
  console.log(
    `${payload.valid ? "✓" : "✗"} Permission policies ${payload.mode}: ` +
      `${payload.summary.actions} action(s), ` +
      `${payload.summary.conflicts} conflict(s), ` +
      `${payload.summary.revoked} revoked`,
  );
  console.log(`  policies: ${payload.summary.rules}`);
  console.log(`  create/refresh: ${payload.summary.created}/${payload.summary.refreshed}`);
  printPolicyErrors(payload.errors);
  printPolicyWarnings(payload.warnings);
  for (const action of payload.actions.slice(0, 20)) {
    console.log(
      `  ${action.status}: ${action.subjectType}:${action.subjectId} ${action.relation} ` +
        `${action.objectType}:${action.objectId} via ${action.policyId}`,
    );
    if (action.conflictSource) {
      console.log(`    conflict source: ${action.conflictSource}`);
    }
  }
  if (payload.actions.length > 20) {
    console.log(`  ... and ${payload.actions.length - 20} more action(s)`);
  }
}

function printPolicyErrors(errors: Array<{ source: string; error: string }>): void {
  for (const error of errors) {
    console.log(`  error: ${error.source}: ${error.error}`);
  }
}

function printPolicyWarnings(warnings: Array<{ policyId: string; message: string }>): void {
  for (const warning of warnings) {
    console.log(`  warning: ${warning.policyId}: ${warning.message}`);
  }
}
