/**
 * Routes Commands - Route management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail } from "../context.js";
import { nats } from "../../nats.js";

/** Notify gateway that config changed (routes, agents, settings, contacts) */
function emitConfigChanged() {
  nats.emit("ravi.config.changed", {}).catch(() => {});
}
import {
  dbGetRoute,
  dbListRoutes,
  dbCreateRoute,
  dbUpdateRoute,
  dbDeleteRoute,
  dbGetAgent,
  dbListAgents,
  DmScopeSchema,
  getFirstAccountName,
} from "../../router/router-db.js";
import { listSessions, deleteSession } from "../../router/sessions.js";
import { getContact, removeAccountPending, type ContactStatus } from "../../contacts.js";

function routeStatusIcon(status?: ContactStatus | null): string {
  if (!status) return "\x1b[33m?\x1b[0m";
  switch (status) {
    case "allowed": return "\x1b[32m✓\x1b[0m";
    case "pending": return "\x1b[33m?\x1b[0m";
    case "blocked": return "\x1b[31m✗\x1b[0m";
    case "discovered": return "\x1b[36m○\x1b[0m";
  }
}

/**
 * Delete sessions that conflict with a new route.
 * When a route is added/changed, existing sessions with different agents need to be reset.
 */
function deleteConflictingSessions(pattern: string, targetAgent: string): number {
  const sessions = listSessions();
  let deleted = 0;

  for (const session of sessions) {
    // Check if session key contains the pattern
    // Pattern examples: "group:123456", "5511*", "lid:123"
    // Session key examples: "agent:main:whatsapp:main:group:123456"

    // For group patterns, check if session contains the group ID
    if (pattern.startsWith("group:")) {
      const groupId = pattern.replace("group:", "");
      if (session.sessionKey.includes(`group:${groupId}`) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    }
    // For lid patterns
    else if (pattern.startsWith("lid:")) {
      const lid = pattern.replace("lid:", "");
      if (session.sessionKey.includes(`lid:${lid}`) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    }
    // For phone patterns (with wildcards)
    else if (pattern.includes("*")) {
      // Convert pattern to regex
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      // Extract phone/peer from session key (last segment after dm: or similar)
      const match = session.sessionKey.match(/dm:(\d+)/);
      if (match && regex.test(match[1]) && session.agentId !== targetAgent) {
        deleteSession(session.sessionKey);
        console.log(`  Deleted conflicting session: ${session.sessionKey}`);
        deleted++;
      }
    }
  }

  return deleted;
}

@Group({
  name: "routes",
  description: "Route management",
  scope: "admin",
})
export class RoutesCommands {
  @Command({ name: "list", description: "List all routes" })
  list(
    @Option({ flags: "-a, --account <id>", description: "Filter by account ID" }) account?: string
  ) {
    const routes = dbListRoutes(account);

    if (routes.length === 0) {
      console.log("No routes configured.");
      console.log("\nAdd a route: ravi routes add <pattern> <agent>");
      return;
    }

    console.log("\nRoutes:\n");
    console.log("  ST  PATTERN                              AGENT           ACCOUNT         NAME                  PRI");
    console.log("  --  -----------------------------------  --------------  --------------  --------------------  ---");

    for (const route of routes) {
      const contact = getContact(route.pattern);
      const icon = routeStatusIcon(contact?.status);
      const pattern = route.pattern.padEnd(35);
      const agent = route.agent.padEnd(14);
      const acct = route.accountId.padEnd(14);
      const name = (contact?.name ?? "-").slice(0, 20).padEnd(20);
      const priority = String(route.priority ?? 0);

      console.log(`  ${icon}   ${pattern}  ${agent}  ${acct}  ${name}  ${priority}`);
    }

    console.log(`\n  Total: ${routes.length} routes`);
  }

  @Command({ name: "show", description: "Show route details" })
  show(
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({ flags: "-a, --account <id>", description: "Account (omni instance name)" }) account?: string
  ) {
    const acct = account ?? getFirstAccountName();
    if (!acct) {
      fail("No account configured. Use --account <name> or run 'ravi whatsapp connect' first.");
    }

    const route = dbGetRoute(pattern, acct);

    if (!route) {
      fail(`Route not found: ${pattern} (account: ${acct})`);
    }

    console.log(`\nRoute: ${route.pattern}`);
    console.log(`  Account:   ${route.accountId}`);
    console.log(`  Agent:     ${route.agent}`);
    console.log(`  Session:   ${route.session ?? "(auto)"}`);
    console.log(`  Priority:  ${route.priority ?? 0}`);
    console.log(`  DM Scope:  ${route.dmScope ?? "-"}`);
  }

  @Command({ name: "add", description: "Add a new route" })
  add(
    @Arg("pattern", { description: "Route pattern (e.g., group:123456)" }) pattern: string,
    @Arg("agent", { description: "Agent ID" }) agent: string,
    @Option({ flags: "-a, --account <id>", description: "Account (omni instance name)" }) account?: string
  ) {
    const acct = account ?? getFirstAccountName();
    if (!acct) {
      fail("No account configured. Use --account <name> or run 'ravi whatsapp connect' first.");
    }

    // Verify agent exists
    if (!dbGetAgent(agent)) {
      fail(`Agent not found: ${agent}. Available: ${dbListAgents().map(a => a.id).join(", ")}`);
    }

    try {
      dbCreateRoute({ pattern, agent, accountId: acct, priority: 0 });
      console.log(`✓ Route added: ${pattern} -> ${agent} (account: ${acct})`);
      emitConfigChanged();

      // Remove from account pending if it was there (try pattern + linked identities)
      let removedPending = removeAccountPending(acct, pattern);
      if (!removedPending) {
        // Pattern might be a phone but pending was saved with LID (or vice versa)
        const contact = getContact(pattern);
        if (contact) {
          for (const id of contact.identities) {
            if (removeAccountPending(acct, id.value)) {
              removedPending = true;
              break;
            }
          }
        }
      }
      if (removedPending) {
        console.log(`✓ Removed from account pending`);
      }

      // Delete any sessions that were created with a different agent
      const deleted = deleteConflictingSessions(pattern, agent);
      if (deleted > 0) {
        console.log(`✓ Cleaned ${deleted} conflicting session(s)`);
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "remove", description: "Remove a route" })
  remove(
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Option({ flags: "-a, --account <id>", description: "Account (omni instance name)" }) account?: string
  ) {
    const acct = account ?? getFirstAccountName();
    if (!acct) {
      fail("No account configured. Use --account <name> or run 'ravi whatsapp connect' first.");
    }

    const deleted = dbDeleteRoute(pattern, acct);
    if (deleted) {
      console.log(`✓ Route removed: ${pattern} (account: ${acct})`);
      emitConfigChanged();
    } else {
      fail(`Route not found: ${pattern} (account: ${acct})`);
    }
  }

  @Command({ name: "set", description: "Set route property" })
  set(
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Arg("key", { description: "Property key (agent, priority, dmScope)" }) key: string,
    @Arg("value", { description: "Property value" }) value: string,
    @Option({ flags: "-a, --account <id>", description: "Account (omni instance name)" }) account?: string
  ) {
    const acct = account ?? getFirstAccountName();
    if (!acct) {
      fail("No account configured. Use --account <name> or run 'ravi whatsapp connect' first.");
    }
    const route = dbGetRoute(pattern, acct);
    if (!route) {
      fail(`Route not found: ${pattern} (account: ${acct})`);
    }

    const validKeys = ["agent", "priority", "dmScope", "session"];
    if (!validKeys.includes(key)) {
      fail(`Invalid key: ${key}. Valid keys: ${validKeys.join(", ")}`);
    }

    // Validate values
    if (key === "agent") {
      if (!dbGetAgent(value)) {
        fail(`Agent not found: ${value}`);
      }
    }

    if (key === "dmScope") {
      const result = DmScopeSchema.safeParse(value);
      if (!result.success) {
        fail(`Invalid dmScope: ${value}. Valid scopes: ${DmScopeSchema.options.join(", ")}`);
      }
    }

    if (key === "priority") {
      const priority = parseInt(value, 10);
      if (isNaN(priority)) {
        fail(`Invalid priority: ${value}. Priority must be an integer`);
      }
    }

    if (key === "session" && value.includes(".")) {
      fail(`Session name must not contain dots: "${value}"`);
    }

    try {
      const updates: Record<string, unknown> = {};
      if (key === "priority") {
        updates.priority = parseInt(value, 10);
      } else {
        updates[key] = value;
      }
      dbUpdateRoute(pattern, updates, acct);
      console.log(`✓ ${key} set: ${pattern} -> ${value}`);
      emitConfigChanged();

      // If agent changed, clean up conflicting sessions
      if (key === "agent") {
        const deleted = deleteConflictingSessions(pattern, value);
        if (deleted > 0) {
          console.log(`✓ Cleaned ${deleted} conflicting session(s)`);
        }
      }
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
