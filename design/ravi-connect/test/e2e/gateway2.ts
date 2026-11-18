// Real gateway code (Ravi source at $RAVI_SRC) on a FIXED loopback port, isolated state. Admin key -> 0600 file.
// Like a real `init-admin-key`, the admin context is bound to agent `bootstrap`. Three agents and three sessions exist
// so that resource scoping (access:session:<name>, view:agent:<id>) is visible: scoped keys must see only their scope.
import "reflect-metadata";
import { writeFileSync, chmodSync } from "node:fs";
const ROOT = (process.env.RAVI_SRC || process.env.RAVI_COPY)!;
const { buildRegistry } = await import(`${ROOT}/src/cli/registry-snapshot.ts`);
const { ContextCommands } = await import(`${ROOT}/src/cli/commands/context.ts`);
const { SessionCommands } = await import(`${ROOT}/src/cli/commands/sessions.ts`);
const { AgentsCommands } = await import(`${ROOT}/src/cli/commands/agents.ts`);
const { startGateway } = await import(`${ROOT}/src/sdk/gateway/server.ts`);
const { ADMIN_BOOTSTRAP_KIND, createRuntimeContext } = await import(`${ROOT}/src/runtime/context-registry.ts`);
const { dbCreateAgent, dbListAgents } = await import(`${ROOT}/src/router/router-db.ts`);
const { getOrCreateSession } = await import(`${ROOT}/src/router/sessions.ts`);
const have = dbListAgents().map((a: any) => a.id);
for (const id of ["bootstrap", "outro", "terceiro"]) if (!have.includes(id)) dbCreateAgent({ id, cwd: `/tmp/agent-${id}` });
getOrCreateSession("agent:main:main", "main", "/tmp/agent-main", { name: "main" });
getOrCreateSession("agent:outro:main", "outro", "/tmp/agent-outro", { name: "outro-main" });
getOrCreateSession("agent:terceiro:main", "terceiro", "/tmp/agent-terceiro", { name: "segredo" });
const admin = createRuntimeContext({ kind: ADMIN_BOOTSTRAP_KIND, agentId: "bootstrap", capabilities: [{ permission: "admin", objectType: "system", objectId: "*" }], ttlMs: 90 * 24 * 60 * 60 * 1000 });
const gw = startGateway({ host: "127.0.0.1", port: Number(process.env.GW_PORT), registry: buildRegistry([ContextCommands, SessionCommands, AgentsCommands]) });
writeFileSync(process.env.ADMIN_KEY_FILE!, admin.contextKey + "\n", { mode: 0o600 });
chmodSync(process.env.ADMIN_KEY_FILE!, 0o600);
writeFileSync(process.env.READY_FILE!, String(gw.port));
await new Promise((r) => setTimeout(r, Number(process.env.KEEP_MS ?? 600000)));
await gw.stop();
process.exit(0);
