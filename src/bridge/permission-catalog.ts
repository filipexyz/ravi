import { readdirSync, accessSync, statSync, constants } from "node:fs";
import { join, delimiter, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { dbListAgents } from "../router/router-db.js";
import { RUNTIME_BUILTIN_TOOLS } from "../cli/tool-registry.js";
import { currentConsoleInvocation, consoleInvocationLive } from "../sdk/gateway/console-context.js";
import { BridgeError } from "./protocol.js";

const capability = z.object({ permission: z.string(), objectType: z.string(), objectId: z.string() });
export const permissionCatalogSchema = z.object({
  digest: z.string(),
  agents: z.array(z.object({ id: z.string(), name: z.string() })).max(1000),
  actions: z
    .array(
      z.object({
        label: z.string(),
        category: z.enum(["tool", "command", "executable", "protocol"]),
        description: z.string(),
        capability,
        prerequisites: z.array(capability),
      }),
    )
    .max(3000),
  truncated: z.boolean(),
});
const bash = { permission: "use", objectType: "tool", objectId: "Bash" };
const hook = { permission: "mutate", objectType: "context.bridge-tool-hook", objectId: "*" };
const ravi = { permission: "execute", objectType: "executable", objectId: "ravi" };

/** Installation metadata only. Never prompts, paths, credentials, local grants or
 * private history. Catalog presence confers no execution/assignment authority. */
export async function permissionCatalog() {
  const invocation = currentConsoleInvocation();
  if (
    !invocation ||
    !consoleInvocationLive(invocation) ||
    invocation.grant.scope.kind !== "installation" ||
    invocation.grant.command !== "desktop.permissions.catalog" ||
    invocation.grant.access.kind !== "read" ||
    invocation.grant.access.resource !== "desktop.permissions" ||
    invocation.grant.access.action !== "catalog"
  )
    throw new BridgeError("CONSOLE_AUTHORITY_REQUIRED");
  const { extractTools } = await import("../cli/tools-export.js");
  const { getAllCommandClasses } = await import("../cli/tool-definitions.js");
  const agents = dbListAgents()
    .map((agent) => ({ id: agent.id, name: agent.name || agent.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const actions: z.infer<typeof permissionCatalogSchema>["actions"] = RUNTIME_BUILTIN_TOOLS.map((tool) => ({
    label: tool.nativeName,
    description: tool.description,
    category: "tool",
    prerequisites: tool.nativeName === "Bash" ? [hook] : [],
    capability: { permission: "use", objectType: "tool", objectId: tool.nativeName },
  }));
  actions.push({
    label: "Bridge tool approval checks",
    description: "Protocol prerequisite for exact-action checks; grants no tool or executable by itself.",
    category: "protocol",
    capability: hook,
    prerequisites: [],
  });
  for (const tool of extractTools(getAllCommandClasses())) {
    const access = tool.metadata.access;
    if (!access || access.consoleOnly || tool.metadata.scope === "superadmin" || /[*?]/.test(access.action)) continue;
    actions.push({
      label: `ravi ${tool.metadata.group.replaceAll(".", " ")} ${tool.metadata.command}`,
      description: tool.description,
      category: "command",
      capability: { permission: access.kind, objectType: access.resource, objectId: access.action },
      prerequisites: [bash, hook, ravi],
    });
  }
  // Enumerate executable names without executing anything or returning PATH.
  const executables = new Set<string>();
  let truncated = false;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute).slice(0, 20)) {
    let entries: string[];
    try {
      entries = readdirSync(directory).sort();
    } catch {
      continue;
    }
    for (const name of entries.slice(0, 4000)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,79}$/.test(name)) continue;
      try {
        accessSync(join(directory, name), constants.X_OK);
        if (!statSync(join(directory, name)).isFile()) continue;
      } catch {
        continue;
      }
      if (executables.size >= 1000) {
        truncated = true;
        break;
      }
      executables.add(name);
    }
    truncated ||= entries.length > 4000;
  }
  for (const name of [...executables].sort())
    actions.push({
      label: `Run ${name}`,
      category: "executable",
      description:
        "Run this executable through the agent's shell. Arguments remain subject to exact-action approval and runtime checks.",
      capability: { permission: "execute", objectType: "executable", objectId: name },
      prerequisites: [bash, hook],
    });
  const bounded = {
    agents: agents.slice(0, 1000),
    actions: actions.slice(0, 3000),
    truncated: truncated || agents.length > 1000 || actions.length > 3000,
  };
  // Authority can expire/revoke while metadata is loaded.
  if (!consoleInvocationLive(invocation)) throw new BridgeError("CONSOLE_AUTHORITY_REQUIRED");
  return permissionCatalogSchema.parse({
    ...bounded,
    digest: createHash("sha256").update(JSON.stringify(bounded)).digest("hex"),
  });
}
