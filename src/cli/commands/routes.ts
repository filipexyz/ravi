/**
 * Routes Commands - Route management CLI
 */

import "reflect-metadata";
import { Group, Command, Arg } from "../decorators.js";
import {
  dbGetRoute,
  dbListRoutes,
  dbCreateRoute,
  dbUpdateRoute,
  dbDeleteRoute,
  dbGetAgent,
  dbListAgents,
  DmScopeSchema,
} from "../../router/router-db.js";
import { listSessions, deleteSession } from "../../router/sessions.js";

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
    // Session key examples: "agent:main:whatsapp:default:group:123456"

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
})
export class RoutesCommands {
  @Command({ name: "list", description: "List all routes" })
  list() {
    const routes = dbListRoutes();

    if (routes.length === 0) {
      console.log("No routes configured.");
      console.log("\nAdd a route: ravi routes add <pattern> <agent>");
      return;
    }

    console.log("\nRoutes:\n");
    console.log("  PATTERN                              AGENT           PRIORITY  DM SCOPE");
    console.log("  -----------------------------------  --------------  --------  ----------------");

    for (const route of routes) {
      const pattern = route.pattern.padEnd(35);
      const agent = route.agent.padEnd(14);
      const priority = String(route.priority ?? 0).padEnd(8);
      const dmScope = route.dmScope ?? "-";

      console.log(`  ${pattern}  ${agent}  ${priority}  ${dmScope}`);
    }

    console.log(`\n  Total: ${routes.length} routes`);
  }

  @Command({ name: "show", description: "Show route details" })
  show(@Arg("pattern", { description: "Route pattern" }) pattern: string) {
    const route = dbGetRoute(pattern);

    if (!route) {
      console.error(`Route not found: ${pattern}`);
      process.exit(1);
    }

    console.log(`\nRoute: ${route.pattern}`);
    console.log(`  Agent:     ${route.agent}`);
    console.log(`  Priority:  ${route.priority ?? 0}`);
    console.log(`  DM Scope:  ${route.dmScope ?? "-"}`);
  }

  @Command({ name: "add", description: "Add a new route" })
  add(
    @Arg("pattern", { description: "Route pattern (e.g., group:123456)" }) pattern: string,
    @Arg("agent", { description: "Agent ID" }) agent: string
  ) {
    // Verify agent exists
    if (!dbGetAgent(agent)) {
      console.error(`Agent not found: ${agent}`);
      console.log("\nAvailable agents:");
      for (const a of dbListAgents()) {
        console.log(`  - ${a.id}`);
      }
      process.exit(1);
    }

    try {
      dbCreateRoute({ pattern, agent, priority: 0 });
      console.log(`✓ Route added: ${pattern} -> ${agent}`);

      // Delete any sessions that were created with a different agent
      const deleted = deleteConflictingSessions(pattern, agent);
      if (deleted > 0) {
        console.log(`✓ Cleaned ${deleted} conflicting session(s)`);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  @Command({ name: "remove", description: "Remove a route" })
  remove(@Arg("pattern", { description: "Route pattern" }) pattern: string) {
    const deleted = dbDeleteRoute(pattern);
    if (deleted) {
      console.log(`\u2713 Route removed: ${pattern}`);
    } else {
      console.log(`Route not found: ${pattern}`);
      process.exit(1);
    }
  }

  @Command({ name: "set", description: "Set route property" })
  set(
    @Arg("pattern", { description: "Route pattern" }) pattern: string,
    @Arg("key", { description: "Property key (agent, priority, dmScope)" }) key: string,
    @Arg("value", { description: "Property value" }) value: string
  ) {
    const route = dbGetRoute(pattern);
    if (!route) {
      console.error(`Route not found: ${pattern}`);
      process.exit(1);
    }

    const validKeys = ["agent", "priority", "dmScope"];
    if (!validKeys.includes(key)) {
      console.error(`Invalid key: ${key}`);
      console.log(`Valid keys: ${validKeys.join(", ")}`);
      process.exit(1);
    }

    // Validate values
    if (key === "agent") {
      if (!dbGetAgent(value)) {
        console.error(`Agent not found: ${value}`);
        process.exit(1);
      }
    }

    if (key === "dmScope") {
      const result = DmScopeSchema.safeParse(value);
      if (!result.success) {
        console.error(`Invalid dmScope: ${value}`);
        console.log(`Valid scopes: ${DmScopeSchema.options.join(", ")}`);
        process.exit(1);
      }
    }

    if (key === "priority") {
      const priority = parseInt(value, 10);
      if (isNaN(priority)) {
        console.error(`Invalid priority: ${value}`);
        console.log("Priority must be an integer");
        process.exit(1);
      }
    }

    try {
      const updates: Record<string, unknown> = {};
      if (key === "priority") {
        updates.priority = parseInt(value, 10);
      } else {
        updates[key] = value;
      }
      dbUpdateRoute(pattern, updates);
      console.log(`✓ ${key} set: ${pattern} -> ${value}`);

      // If agent changed, clean up conflicting sessions
      if (key === "agent") {
        const deleted = deleteConflictingSessions(pattern, value);
        if (deleted > 0) {
          console.log(`✓ Cleaned ${deleted} conflicting session(s)`);
        }
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
}
