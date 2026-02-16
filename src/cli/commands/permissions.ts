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
} from "../../permissions/relations.js";
import { can } from "../../permissions/engine.js";
import { SDK_TOOLS } from "../tool-registry.js";
import { getDefaultAllowlist } from "../../bash/permissions.js";

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
    @Arg("object", { description: "Object (e.g., system:*, group:contacts, session:dev-*)" }) object: string
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);
    validateRelation(relation);

    grantRelation(subjectType, subjectId, relation, objectType, objectId, "manual");
    console.log(`✓ Granted: (${subject}) ${relation} (${object})`);

    // Warn about redundancy
    if (objectId === "*") {
      const individuals = listRelations({ subjectType, subjectId, relation, objectType })
        .filter(r => r.objectId !== "*");
      if (individuals.length > 0) {
        console.log(`⚠ ${individuals.length} individual relation(s) are now redundant (covered by wildcard)`);
      }
    } else if (hasRelation(subjectType, subjectId, relation, objectType, "*")) {
      console.log(`⚠ Redundant: wildcard ${objectType}:* already covers this`);
    }
  }

  @Command({ name: "revoke", description: "Revoke a relation" })
  revoke(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" }) subject: string,
    @Arg("relation", { description: "Relation" }) relation: string,
    @Arg("object", { description: "Object (e.g., system:*, group:contacts)" }) object: string
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);

    const deleted = revokeRelation(subjectType, subjectId, relation, objectType, objectId);
    if (deleted) {
      console.log(`✓ Revoked: (${subject}) ${relation} (${object})`);

      // Warn about remaining individual grants after revoking wildcard
      if (objectId === "*") {
        const remaining = listRelations({ subjectType, subjectId, relation, objectType })
          .filter(r => r.objectId !== "*");
        if (remaining.length > 0) {
          console.log(`⚠ ${remaining.length} individual relation(s) still active:`);
          for (const r of remaining.slice(0, 10)) {
            console.log(`    ${objectType}:${r.objectId}`);
          }
          if (remaining.length > 10) {
            console.log(`    ... and ${remaining.length - 10} more`);
          }
        }
      }
    } else {
      fail("Relation not found");
    }
  }

  @Command({ name: "check", description: "Check if a subject has a permission on an object" })
  check(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" }) subject: string,
    @Arg("permission", { description: "Permission (e.g., execute, access, admin)" }) permission: string,
    @Arg("object", { description: "Object (e.g., group:contacts, session:dev-grupo1)" }) object: string
  ) {
    const [subjectType, subjectId] = parseEntity(subject);
    const [objectType, objectId] = parseEntity(object);

    const allowed = can(subjectType, subjectId, permission, objectType, objectId);
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
    @Option({ flags: "--source <src>", description: "Filter by source (config|manual)" }) source?: string
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
      const obj = `${r.objectType}:${r.objectId}`.padEnd(20);
      const src = r.source;
      console.log(`  ${sub}  ${rel}  ${obj}  ${src}`);
    }
  }

  @Command({ name: "sync", description: "Re-sync relations from agent configs" })
  sync() {
    syncRelationsFromConfig();
    const relations = listRelations({ source: "config" });
    console.log(`✓ Synced ${relations.length} config relations`);
  }

  @Command({ name: "init", description: "Apply a permission template to an agent" })
  init(
    @Arg("subject", { description: "Subject (e.g., agent:dev)" }) subject: string,
    @Arg("template", { description: "Template: sdk-tools, all-tools, safe-executables, full-access" }) template: string
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
    };

    const fn = templates[template];
    if (!fn) {
      fail(`Unknown template: "${template}". Available: ${Object.keys(templates).join(", ")}`);
      return;
    }

    const count = fn();
    console.log(`✓ Applied template "${template}" to ${subject} (${count} relation(s))`);
  }

  @Command({ name: "clear", description: "Clear all manual relations" })
  clear(
    @Option({ flags: "--all", description: "Clear ALL relations (including config)" }) all?: boolean
  ) {
    const count = all
      ? clearRelations()
      : clearRelations({ source: "manual" });

    console.log(`✓ Cleared ${count} relation(s)`);

    if (all) {
      console.log("Run 'ravi permissions sync' to regenerate config relations.");
    }
  }
}

/** Valid relations recognized by the engine */
const VALID_RELATIONS = new Set([
  "admin",                  // superadmin: (agent, admin, system, *)
  "use",                    // SDK tools: (agent, use, tool, Bash)
  "execute",                // executables + CLI groups: (agent, execute, executable, git) or (agent, execute, group, contacts)
  "access",                 // sessions: (agent, access, session, dev-*)
  "modify",                 // sessions: (agent, modify, session, dev-*)
  "write_contacts",         // contacts: (agent, write_contacts, system, *)
  "read_own_contacts",      // contacts: (agent, read_own_contacts, system, *)
  "read_tagged_contacts",   // contacts: (agent, read_tagged_contacts, system, tag)
  "read_contact",           // contacts: (agent, read_contact, contact, id)
]);

/** Valid entity types for relations */
const VALID_ENTITY_TYPES = new Set([
  "agent", "system", "group", "session", "contact",
  "cron", "trigger", "outbound", "team",
  "tool", "executable",
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
