/**
 * Triggers Commands - Manage event-driven triggers
 */

import "reflect-metadata";
import { Group, Command, Arg, Option } from "../decorators.js";
import { fail, getContext } from "../context.js";
import { nats } from "../../nats.js";
import { getScopeContext, isScopeEnforced, canAccessResource } from "../../permissions/scope.js";
import { getAgent } from "../../router/config.js";
import { getAccountForAgent } from "../../router/router-db.js";
import { parseDurationMs, formatDurationMs } from "../../cron/schedule.js";
import {
  dbCreateTrigger,
  dbGetTrigger,
  dbListTriggers,
  dbUpdateTrigger,
  dbDeleteTrigger,
  type TriggerInput,
} from "../../triggers/index.js";

@Group({
  name: "triggers",
  description: "Event triggers",
  scope: "resource",
})
export class TriggersCommands {
  @Command({ name: "list", description: "List all event triggers" })
  list() {
    let triggers = dbListTriggers();

    // Scope isolation: filter to own agent's triggers
    const scopeCtx = getScopeContext();
    if (isScopeEnforced(scopeCtx)) {
      triggers = triggers.filter((t) => canAccessResource(scopeCtx, t.agentId));
    }

    if (triggers.length === 0) {
      console.log("\nNo triggers configured.\n");
      console.log("Usage:");
      console.log(
        '  ravi triggers add "Lead Qualificado" --topic "ravi.*.cli.outbound.qualify" --message "Notifica o grupo"',
      );
      console.log('  ravi triggers add "Agent Error" --topic "ravi.*.tool" --message "Analise o erro" --cooldown 1m');
      console.log("\nAvailable topics:");
      console.log("  ravi.*.cli.{group}.{command}   CLI tool executions (e.g., ravi.*.cli.contacts.add)");
      console.log("  ravi.*.tool                    SDK tool executions (Bash, Read, etc.)");
      console.log("  ravi.*.response                Agent responses");
      console.log("  whatsapp.*.inbound             WhatsApp messages");
      console.log("  matrix.*.inbound               Matrix messages");
      return;
    }

    console.log("\nEvent Triggers:\n");
    console.log("  ID        NAME                      ENABLED  TOPIC                           FIRES");
    console.log("  --------  ------------------------  -------  ------------------------------  -----");

    for (const t of triggers) {
      const id = t.id.padEnd(8);
      const name = t.name.slice(0, 24).padEnd(24);
      const enabled = (t.enabled ? "yes" : "no").padEnd(7);
      const topic = t.topic.slice(0, 30).padEnd(30);
      const fires = String(t.fireCount);

      console.log(`  ${id}  ${name}  ${enabled}  ${topic}  ${fires}`);
    }

    console.log(`\n  Total: ${triggers.length} triggers`);
    console.log("\nUsage:");
    console.log("  ravi triggers show <id>     # Show trigger details");
    console.log("  ravi triggers test <id>     # Test trigger with fake event");
    console.log("  ravi triggers rm <id>       # Delete trigger");
  }

  @Command({ name: "show", description: "Show trigger details" })
  show(@Arg("id", { description: "Trigger ID" }) id: string) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
    }

    console.log(`\nTrigger: ${trigger.name}\n`);
    console.log(`  ID:              ${trigger.id}`);
    console.log(`  Agent:           ${trigger.agentId ?? "(default)"}`);
    console.log(`  Account:         ${trigger.accountId ?? "(auto)"}`);
    console.log(`  Enabled:         ${trigger.enabled ? "yes" : "no"}`);
    console.log(`  Topic:           ${trigger.topic}`);
    console.log(`  Session:         ${trigger.session}`);
    if (trigger.replySession) {
      console.log(`  Reply session:   ${trigger.replySession}`);
    }
    console.log(`  Cooldown:        ${formatDurationMs(trigger.cooldownMs)}`);
    if (trigger.filter) {
      console.log(`  Filter:          ${trigger.filter}`);
    }
    console.log("");
    console.log(`  Message:`);
    console.log(`    ${trigger.message.split("\n").join("\n    ")}`);
    console.log("");
    console.log(`  Fire count:      ${trigger.fireCount}`);
    if (trigger.lastFiredAt) {
      console.log(`  Last fired:      ${new Date(trigger.lastFiredAt).toLocaleString()}`);
    }
    console.log(`  Created:         ${new Date(trigger.createdAt).toLocaleString()}`);

    console.log("\nAvailable topics:");
    console.log("  ravi.*.cli.{group}.{command}   CLI tool executions");
    console.log("  ravi.*.tool                    SDK tool executions");
    console.log("  ravi.*.response                Agent responses");
    console.log("  whatsapp.*.inbound             WhatsApp messages");
    console.log("  matrix.*.inbound               Matrix messages");
  }

  @Command({ name: "add", description: "Add a new event trigger" })
  async add(
    @Arg("name", { description: "Trigger name" }) name: string,
    @Option({
      flags: "--topic <pattern>",
      description: "Notif topic pattern to subscribe to",
    })
    topic?: string,
    @Option({ flags: "--message <text>", description: "Prompt message" })
    message?: string,
    @Option({
      flags: "--agent <id>",
      description: "Agent ID (default: default agent)",
    })
    agent?: string,
    @Option({
      flags: "--account <name>",
      description: "Account for outbound routing (auto-detected from agent)",
    })
    account?: string,
    @Option({
      flags: "--cooldown <duration>",
      description: "Cooldown between fires (e.g., 5s, 30s, 1m)",
    })
    cooldown?: string,
    @Option({
      flags: "--session <type>",
      description: "Session: main or isolated (default: isolated)",
    })
    session?: string,
    @Option({
      flags: "--filter <expression>",
      description: "Filter expression (e.g. 'data.cwd == \"/Users/luis/ravi\"')",
    })
    filter?: string,
  ) {
    if (!topic) {
      fail("--topic is required");
    }
    if (!message) {
      fail("--message is required");
    }

    // Validate agent if provided
    if (agent) {
      const ag = getAgent(agent);
      if (!ag) {
        fail(`Agent not found: ${agent}`);
      }
    }

    // Parse cooldown
    let cooldownMs = 5000;
    if (cooldown) {
      try {
        cooldownMs = parseDurationMs(cooldown);
      } catch (err) {
        fail(`Invalid cooldown: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Validate session
    let sessionTarget: "main" | "isolated" = "isolated";
    if (session) {
      if (session !== "main" && session !== "isolated") {
        fail(`Invalid session: ${session}. Valid: main, isolated`);
      }
      sessionTarget = session;
    }

    // Resolve agent: explicit flag > caller agent (from session context)
    const ctx = getContext();
    const resolvedAgent = agent ?? ctx?.agentId;

    // Resolve account: explicit flag > auto-detect from agent's account mapping
    const resolvedAccount = account ?? (resolvedAgent ? getAccountForAgent(resolvedAgent) : undefined);

    // Capture reply session from caller context for source routing
    const replySession = ctx?.sessionKey;

    // Warn about blocked topics
    const blockedPatterns = [".prompt", ".response", ".claude"];
    if (blockedPatterns.some((p) => topic.includes(p))) {
      console.log("Warning: triggers on .prompt, .response, and .claude topics are skipped to prevent loops");
    }

    const input: TriggerInput = {
      name,
      topic,
      message,
      agentId: resolvedAgent,
      accountId: resolvedAccount,
      replySession,
      session: sessionTarget,
      cooldownMs,
      filter,
    };

    try {
      const trigger = dbCreateTrigger(input);

      await nats.emit("ravi.triggers.refresh", {});

      console.log(`\n✓ Created trigger: ${trigger.id}`);
      console.log(`  Name:       ${trigger.name}`);
      console.log(`  Topic:      ${trigger.topic}`);
      console.log(`  Cooldown:   ${formatDurationMs(trigger.cooldownMs)}`);
      console.log(`  Session:    ${trigger.session}`);
    } catch (err) {
      fail(`Error creating trigger: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "enable", description: "Enable a trigger" })
  async enable(@Arg("id", { description: "Trigger ID" }) id: string) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
    }

    try {
      dbUpdateTrigger(id, { enabled: true });
      await nats.emit("ravi.triggers.refresh", {});
      console.log(`✓ Enabled trigger: ${id} (${trigger.name})`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "disable", description: "Disable a trigger" })
  async disable(@Arg("id", { description: "Trigger ID" }) id: string) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
    }

    try {
      dbUpdateTrigger(id, { enabled: false });
      await nats.emit("ravi.triggers.refresh", {});
      console.log(`✓ Disabled trigger: ${id} (${trigger.name})`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "set", description: "Set trigger property" })
  async set(
    @Arg("id", { description: "Trigger ID" }) id: string,
    @Arg("key", {
      description: "Property: name, message, topic, agent, account, session, cooldown",
    })
    key: string,
    @Arg("value", { description: "Property value" }) value: string,
  ) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
    }

    try {
      switch (key) {
        case "name":
          dbUpdateTrigger(id, { name: value });
          console.log(`✓ Name set: ${id} -> ${value}`);
          break;

        case "message":
          dbUpdateTrigger(id, { message: value });
          console.log(`✓ Message set: ${id}`);
          break;

        case "topic": {
          const blocked = [".prompt", ".response", ".claude"];
          if (blocked.some((p) => value.includes(p))) {
            console.log("Warning: triggers on .prompt, .response, and .claude topics are skipped to prevent loops");
          }
          dbUpdateTrigger(id, { topic: value });
          console.log(`✓ Topic set: ${id} -> ${value}`);
          break;
        }

        case "agent": {
          const agentId = value === "null" || value === "-" ? undefined : value;
          if (agentId) {
            const ag = getAgent(agentId);
            if (!ag) {
              fail(`Agent not found: ${agentId}`);
            }
          }
          dbUpdateTrigger(id, { agentId });
          console.log(`✓ Agent set: ${id} -> ${agentId ?? "(default)"}`);
          break;
        }

        case "account": {
          const accountId = value === "null" || value === "-" ? undefined : value;
          dbUpdateTrigger(id, { accountId });
          console.log(`✓ Account set: ${id} -> ${accountId ?? "(auto)"}`);
          break;
        }

        case "session": {
          const validValues = ["main", "isolated"];
          if (!validValues.includes(value)) {
            fail(`Invalid session value: ${value}. Valid: ${validValues.join(", ")}`);
          }
          dbUpdateTrigger(id, {
            session: value as "main" | "isolated",
          });
          console.log(`✓ Session set: ${id} -> ${value}`);
          break;
        }

        case "cooldown": {
          const ms = parseDurationMs(value);
          dbUpdateTrigger(id, { cooldownMs: ms });
          console.log(`✓ Cooldown set: ${id} -> ${formatDurationMs(ms)}`);
          break;
        }

        case "filter": {
          const filterValue = value === "null" || value === "-" ? undefined : value;
          dbUpdateTrigger(id, { filter: filterValue });
          console.log(`✓ Filter set: ${id} -> ${filterValue ?? "(none)"}`);
          break;
        }

        default:
          fail(`Unknown property: ${key}. Valid: name, message, topic, agent, account, session, cooldown, filter`);
      }

      await nats.emit("ravi.triggers.refresh", {});
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({ name: "test", description: "Test trigger with fake event data" })
  async test(@Arg("id", { description: "Trigger ID" }) id: string) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
    }

    console.log(`\nTesting trigger: ${trigger.name}`);
    console.log(`  Topic: ${trigger.topic}`);

    try {
      await nats.emit("ravi.triggers.test", { triggerId: id });
      console.log("✓ Test event sent");
      console.log("  Check daemon logs: ravi daemon logs -f");
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }

  @Command({
    name: "rm",
    description: "Delete a trigger",
    aliases: ["delete", "remove"],
  })
  async rm(@Arg("id", { description: "Trigger ID" }) id: string) {
    const trigger = dbGetTrigger(id);
    if (!trigger || !canAccessResource(getScopeContext(), trigger.agentId)) {
      fail(`Trigger not found: ${id}`);
    }

    try {
      dbDeleteTrigger(id);
      await nats.emit("ravi.triggers.refresh", {});
      console.log(`✓ Deleted trigger: ${id} (${trigger.name})`);
    } catch (err) {
      fail(`Error: ${err instanceof Error ? err.message : err}`);
    }
  }
}
