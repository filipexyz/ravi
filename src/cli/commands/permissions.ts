/**
 * Permissions Commands - REBAC relation management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import {
  grantRelation,
  revokeRelation,
  hasRelation,
  listRelations,
  clearRelations,
  syncRelationsFromConfig,
  type RelationFilter,
  type Relation,
} from "../../permissions/relations.js";
import { can } from "../../permissions/engine.js";
import { SDK_TOOLS, TOOL_GROUPS, resolveToolGroup } from "../tool-registry.js";
import { getDefaultAllowlist } from "../../bash/permissions.js";

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

@Group({
  name: "permissions",
  description: "REBAC permission management",
  scope: "superadmin",
})
export class PermissionsCommands {
  @Command({ name: "grant", description: "Grant a relation" })
  grant(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" }) subject: string,
    @Arg("relation", { description: "Relation (e.g., admin, access, execute, write_contacts)" }) relation: string,
    @Arg("object", { description: "Object (e.g., system:*, group:contacts, session:dev-*)" }) object: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);
    validateRelation(relation);
    if (objectType === "toolgroup" && objectId !== "*" && !TOOL_GROUPS[objectId]) {
      fail(`Unknown tool group: "${objectId}". Available: ${Object.keys(TOOL_GROUPS).join(", ")}`);
      return;
    }

    const exactFilter: RelationFilter = { subjectType, subjectId, relation, objectType, objectId };
    const existedAsManual = listRelations(exactFilter).some((item) => item.source === "manual");
    grantRelation(subjectType, subjectId, relation, objectType, objectId, "manual");
    if (!asJson) {
      console.log(`✓ Granted: (${subject}) ${relation} (${object})`);
    }

    // Warn about redundancy
    const warnings: Array<Record<string, unknown>> = [];
    if (objectId === "*") {
      const individuals = listRelations({ subjectType, subjectId, relation, objectType }).filter(
        (r) => r.objectId !== "*",
      );
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
      const granted = listRelations(exactFilter)[0] ?? null;
      printJson({
        status: "granted",
        target: relationTarget(subject, relation, object),
        changedCount: existedAsManual ? 0 : 1,
        relation: granted
          ? serializeRelation(granted)
          : relationTuple(subjectType, subjectId, relation, objectType, objectId),
        warnings,
      });
    }
  }

  @Command({ name: "revoke", description: "Revoke a relation" })
  revoke(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" }) subject: string,
    @Arg("relation", { description: "Relation" }) relation: string,
    @Arg("object", { description: "Object (e.g., system:*, group:contacts)" }) object: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);
    if (objectType === "toolgroup" && objectId !== "*" && !TOOL_GROUPS[objectId]) {
      fail(`Unknown tool group: "${objectId}". Available: ${Object.keys(TOOL_GROUPS).join(", ")}`);
      return;
    }

    const exactFilter: RelationFilter = { subjectType, subjectId, relation, objectType, objectId };
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
          ? listRelations({ subjectType, subjectId, relation, objectType }).filter((r) => r.objectId !== "*")
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

      if (asJson) {
        printJson({
          status: "revoked",
          target: relationTarget(subject, relation, object),
          changedCount: 1,
          relation: "id" in relationBefore ? serializeRelation(relationBefore) : relationBefore,
          remainingIndividualRelations: remaining.map(serializeRelation),
        });
      }
    } else {
      fail("Relation not found");
    }
  }

  @Command({ name: "check", description: "Check if a subject has a permission on an object" })
  check(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" }) subject: string,
    @Arg("permission", { description: "Permission (e.g., execute, access, admin)" }) permission: string,
    @Arg("object", { description: "Object (e.g., group:contacts, session:dev-grupo1)" }) object: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);

    const allowed = can(subjectType, subjectId, permission, objectType, objectId);
    if (asJson) {
      printJson({
        subject: { raw: subject, type: subjectType, id: subjectId },
        permission,
        object: { raw: object, type: objectType, id: objectId },
        allowed,
      });
      return;
    }

    if (allowed) {
      console.log(`✓ ALLOWED: (${subject}) ${permission} (${object})`);
    } else {
      console.log(`✗ DENIED: (${subject}) ${permission} (${object})`);
    }
  }

  @Command({ name: "list", description: "List relations" })
  list(
    @Option({ flags: "--subject <s>", description: "Filter by subject (e.g., agent:dev)" }) subject?: string,
    @Option({ flags: "--object <o>", description: "Filter by object (e.g., group:contacts)" }) object?: string,
    @Option({ flags: "--relation <r>", description: "Filter by relation" }) relation?: string,
    @Option({ flags: "--source <src>", description: "Filter by source (config|manual)" }) source?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
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

    const relations = listRelations(Object.keys(filter).length > 0 ? filter : undefined);

    if (asJson) {
      printJson({
        total: relations.length,
        filter,
        relations: relations.map(serializeRelation),
      });
      return;
    }

    if (relations.length === 0) {
      console.log("No relations found.");
      return;
    }

    console.log(`\nRelations (${relations.length}):\n`);
    console.log("  SUBJECT              RELATION              OBJECT                SOURCE");
    console.log("  -------------------  --------------------  --------------------  ------");

    for (const r of relations) {
      const sub = `${r.subjectType}:${r.subjectId}`.padEnd(19);
      const rel = r.relation.padEnd(20);
      let objStr = `${r.objectType}:${r.objectId}`;
      if (r.objectType === "toolgroup" && r.objectId !== "*") {
        const members = resolveToolGroup(r.objectId);
        if (members) objStr += ` (${members.join(", ")})`;
      }
      const obj = objStr.padEnd(20);
      const src = r.source;
      console.log(`  ${sub}  ${rel}  ${obj}  ${src}`);
    }
  }

  @Command({ name: "sync", description: "Re-sync relations from agent configs" })
  sync(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    syncRelationsFromConfig();
    const relations = listRelations({ source: "config" });
    if (asJson) {
      printJson({
        status: "synced",
        target: { type: "permission-relations", source: "config" },
        changedCount: relations.length,
        relations: relations.map(serializeRelation),
      });
      return;
    }
    console.log(`✓ Synced ${relations.length} config relations`);
  }

  @Command({ name: "init", description: "Apply a permission template to an agent" })
  init(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" }) subject: string,
    @Arg("template", { description: "Template: sdk-tools, all-tools, safe-executables, full-access, tool-groups" })
    template: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const [subjectType, subjectId] = parseEntity(subject);

    const templates: Record<string, () => number> = {
      "sdk-tools": () => {
        let count = 0;
        for (const tool of SDK_TOOLS) {
          grantRelation(subjectType, subjectId, "use", "tool", tool, "manual");
          count++;
        }
        return count;
      },
      "all-tools": () => {
        grantRelation(subjectType, subjectId, "use", "tool", "*", "manual");
        return 1;
      },
      "safe-executables": () => {
        let count = 0;
        for (const cli of [...getDefaultAllowlist(), "ravi"]) {
          grantRelation(subjectType, subjectId, "execute", "executable", cli, "manual");
          count++;
        }
        return count;
      },
      "full-access": () => {
        grantRelation(subjectType, subjectId, "use", "tool", "*", "manual");
        grantRelation(subjectType, subjectId, "execute", "executable", "*", "manual");
        return 2;
      },
      "tool-groups": () => {
        let count = 0;
        for (const groupName of Object.keys(TOOL_GROUPS)) {
          grantRelation(subjectType, subjectId, "use", "toolgroup", groupName, "manual");
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
    if (asJson) {
      const relations = listRelations({ subjectType, subjectId, source: "manual" });
      printJson({
        status: "applied",
        target: { type: "permission-template", subject, template },
        changedCount: count,
        relations: relations.map(serializeRelation),
      });
      return;
    }
    console.log(`✓ Applied template "${template}" to ${subject} (${count} relation(s))`);
  }

  @Command({ name: "clear", description: "Clear all manual relations" })
  clear(
    @Option({ flags: "--all", description: "Clear ALL relations (including config)" }) all?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const count = all ? clearRelations() : clearRelations({ source: "manual" });

    if (asJson) {
      printJson({
        status: "cleared",
        target: { type: "permission-relations", source: all ? "all" : "manual" },
        changedCount: count,
      });
      return;
    }

    console.log(`✓ Cleared ${count} relation(s)`);

    if (all) {
      console.log("Run 'ravi permissions sync' to regenerate config relations.");
    }
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
  };

  if (relation.objectType === "toolgroup" && relation.objectId !== "*") {
    serialized.objectMembers = resolveToolGroup(relation.objectId) ?? [];
  }

  return serialized;
}
