import { hostname, platform, release, cpus, freemem, totalmem, uptime } from "node:os";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { BridgeError } from "./protocol.js";
import { currentConsoleInvocation, consoleInvocationLive } from "../sdk/gateway/console-context.js";
import { consoleConversationCwd } from "./native.js";
import { dbListCronJobs, dbGetCronJob, dbUpdateCronJob } from "../cron/cron-db.js";
import { cronOwnershipError } from "../cron/ownership.js";
import { dbListTriggers, dbGetTrigger, dbUpdateTrigger } from "../triggers/triggers-db.js";
import { resolveTriggerActivation } from "../triggers/activation.js";
import { dbListAgents, dbListChannels, dbGetChannel, dbUpdateChannel } from "../router/router-db.js";
import { getAgentHeartbeatConfig, updateAgentHeartbeatConfig } from "../heartbeat/config.js";
import { nats } from "../nats.js";
import { CHANNELS_PM2_PROCESS_NAME, getPm2Process } from "../pm2.js";
import { probeChannelRunnerHealth, type ChannelAdapterHealth } from "../channels/health.js";
import { conversationAgentsAllowed } from "./teams.js";

export const loopSchema = z.object({
  id: z.string(),
  kind: z.enum(["cron", "trigger", "heartbeat"]),
  name: z.string(),
  schedule: z.string(),
  enabled: z.boolean(),
  lastResult: z.enum(["ok", "failed", "skipped", "never", "unknown"]),
  lastRunAt: z.string().optional(),
  nextRunAt: z.string().optional(),
});
export const computerSchema = z.object({
  host: z.string(),
  os: z.string(),
  cwd: z.string(),
  branch: z.string(),
  uptime: z.string(),
  cpu: z.number(),
  memory: z.number(),
  processes: z.array(
    z.object({ id: z.string(), name: z.string(), detail: z.string(), status: z.enum(["running", "idle", "failed"]) }),
  ),
  changes: z.array(
    z.object({ path: z.string(), change: z.enum(["M", "A", "D"]), additions: z.number(), deletions: z.number() }),
  ),
  terminal: z.array(z.string()),
});
export const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  enabled: z.boolean(),
  status: z.enum([
    "disabled",
    "unknown",
    "starting",
    "connected",
    "degraded",
    "reconnecting",
    "disconnected",
    "failed",
  ]),
});
const iso = (time: number | undefined) => (time ? new Date(time).toISOString() : undefined);

function authority(resource: string, action: string) {
  const invocation = currentConsoleInvocation();
  if (
    !invocation ||
    !consoleInvocationLive(invocation) ||
    invocation.grant.access.resource !== resource ||
    invocation.grant.access.action !== action
  )
    throw new BridgeError("CONSOLE_AUTHORITY_REQUIRED");
  return invocation;
}
/** Fixed, bounded projection. No operator processes, credentials, arbitrary paths or raw terminal logs. */
export async function desktopComputer(conversationId: string) {
  const { grant, service, enrollment } = authority("desktop.computer", "read");
  if (grant.scope.kind !== "session" || grant.scope.conversationId !== conversationId)
    throw new BridgeError("NOT_FOUND_OR_DENIED");
  const conversation = service.store.authorizedConversation(conversationId, enrollment, grant.sub, grant.projectId);
  if (!conversationAgentsAllowed(service.store, conversation, grant)) throw new BridgeError("NOT_FOUND_OR_DENIED");
  const cwd = consoleConversationCwd(conversationId);
  const git = (args: string[]) => {
    const result = spawnSync("git", ["--no-pager", "-c", "core.fsmonitor=false", "-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 1000,
      maxBuffer: 65_536,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return result.status === 0 ? result.stdout.trim() : "";
  };
  const branch = git(["branch", "--show-current"]);
  const changes = git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--"])
    .split("\n")
    .filter(Boolean)
    .slice(0, 100)
    .map((line) => {
      const [add, del, ...path] = line.split("\t");
      return { path: path.join("\t"), change: "M" as const, additions: Number(add) || 0, deletions: Number(del) || 0 };
    });
  const sample = () =>
    cpus().reduce(
      (sum, cpu) => ({
        idle: sum.idle + cpu.times.idle,
        total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
      }),
      { idle: 0, total: 0 },
    );
  const before = sample();
  await new Promise((resolve) => setTimeout(resolve, 80));
  const after = sample();
  if (!consoleInvocationLive(currentConsoleInvocation()!)) throw new BridgeError("ACCESS_REVOKED");
  const events = service.store.db
    .query<{ data: string }, [string]>(
      "SELECT data FROM events WHERE conversation_id=? AND type='turn.activity' ORDER BY sequence DESC LIMIT 12",
    )
    .all(conversationId)
    .reverse();
  return {
    host: hostname(),
    os: `${platform()} ${release()}`,
    cwd,
    branch: branch || "No Git branch",
    uptime: `${Math.floor(uptime() / 60)}m`,
    cpu:
      after.total > before.total
        ? Math.round(100 * (1 - (after.idle - before.idle) / (after.total - before.total)))
        : 0,
    memory: Math.round(100 * (1 - freemem() / totalmem())),
    processes: [{ id: String(process.pid), name: "Ravi", detail: "This runtime", status: "running" as const }],
    changes,
    terminal: events.map((event) => String(JSON.parse(event.data).status).slice(0, 200)),
  };
}

export function desktopLoops() {
  const { grant } = authority("desktop.loops", "list");
  return listLoops(grant.agents.map((agent) => agent.id));
}
function listLoops(agentIds: string[]): z.infer<typeof loopSchema>[] {
  const allowed = (agent: string | undefined) => Boolean(agent && agentIds.includes(agent));
  return [
    ...dbListCronJobs()
      .filter((job) => allowed(job.agentId))
      .map((job) => ({
        id: `cron:${job.id}`,
        kind: "cron" as const,
        name: job.name,
        schedule:
          job.schedule.cron ??
          (job.schedule.every ? `Every ${Math.round(job.schedule.every / 1000)}s` : `At ${iso(job.schedule.at)}`),
        enabled: job.enabled,
        lastResult:
          job.lastStatus === "ok"
            ? ("ok" as const)
            : job.lastStatus === "error"
              ? ("failed" as const)
              : job.lastRunAt
                ? ("unknown" as const)
                : ("never" as const),
        lastRunAt: iso(job.lastRunAt),
        nextRunAt: iso(job.nextRunAt),
      })),
    ...dbListTriggers()
      .filter((trigger) => allowed(trigger.agentId))
      .map((trigger) => ({
        id: `trigger:${trigger.id}`,
        kind: "trigger" as const,
        name: trigger.name,
        schedule: trigger.topic,
        enabled: trigger.enabled,
        lastResult: trigger.lastFiredAt ? ("unknown" as const) : ("never" as const),
        lastRunAt: iso(trigger.lastFiredAt),
      })),
    ...dbListAgents()
      .filter((agent) => allowed(agent.id))
      .map((agent) => {
        const heartbeat = getAgentHeartbeatConfig(agent.id)!;
        return {
          id: `heartbeat:${agent.id}`,
          kind: "heartbeat" as const,
          name: `${agent.id} heartbeat`,
          schedule: `Every ${Math.round(heartbeat.intervalMs / 60000)}m`,
          enabled: heartbeat.enabled,
          lastResult: heartbeat.lastRunAt ? ("unknown" as const) : ("never" as const),
          lastRunAt: iso(heartbeat.lastRunAt),
        };
      }),
  ];
}
export async function desktopSetLoop(
  id: string,
  enabled: boolean,
  notify: (topic: string) => Promise<unknown> = (topic) => nats.emit(topic, {}),
) {
  const { grant } = authority("desktop.loops", "set-enabled");
  const agents = grant.agents.map((agent) => agent.id);
  if (!listLoops(agents).some((loop) => loop.id === id)) throw new BridgeError("NOT_FOUND_OR_DENIED");
  const [kind, key] = id.split(":");
  if (kind === "cron") {
    const job = dbGetCronJob(key!)!;
    if (enabled && cronOwnershipError(job)) throw new BridgeError("CRON_SHELL_NOT_OPERATOR");
    dbUpdateCronJob(key!, { enabled, ...(enabled ? { schedule: { ...job.schedule } } : {}) });
  } else if (kind === "trigger") {
    const trigger = dbGetTrigger(key!)!;
    if (enabled && resolveTriggerActivation({ ...trigger, enabled: true }).state !== "active")
      throw new BridgeError("TRIGGER_NOT_READY");
    dbUpdateTrigger(key!, { enabled });
  } else if (kind === "heartbeat") updateAgentHeartbeatConfig(key!, { enabled });
  else throw new BridgeError("NOT_FOUND_OR_DENIED");
  await notify(`ravi.${kind === "trigger" ? "triggers" : kind}.refresh`);
  return listLoops(agents);
}
async function observedChannels(): Promise<ChannelAdapterHealth[]> {
  const runner = getPm2Process(CHANNELS_PM2_PROCESS_NAME);
  if (!runner || runner.status !== "online" || !runner.pid) return [];
  const health = await probeChannelRunnerHealth({ pid: runner.pid });
  return health.reachable && Date.now() - health.snapshot.observedAt < 5_000 ? health.snapshot.adapters : [];
}
export async function desktopChannels(observe: () => Promise<ChannelAdapterHealth[]> = observedChannels) {
  authority("desktop.channels", "list");
  const observed = await observe();
  authority("desktop.channels", "list");
  return channels().map((channel) => ({
    ...channel,
    status: !channel.enabled
      ? ("disabled" as const)
      : (observed.find((adapter) => adapter.id === channel.id || adapter.id === `${channel.provider}:${channel.id}`)
          ?.status ?? ("unknown" as const)),
  }));
}
function channels() {
  return dbListChannels().map((channel) => ({
    id: channel.name,
    name: channel.name,
    provider: channel.provider,
    enabled: channel.enabled !== false,
    status: channel.enabled === false ? ("disabled" as const) : ("unknown" as const),
  }));
}
export async function desktopSetChannel(
  id: string,
  enabled: boolean,
  notify: (topic: string) => Promise<unknown> = (topic) => nats.emit(topic, {}),
) {
  authority("desktop.channels", "set-enabled");
  const channel = dbGetChannel(id);
  if (!channel) throw new BridgeError("NOT_FOUND_OR_DENIED");
  if (enabled && !channel.credentialConnection) throw new BridgeError("CHANNEL_CREDENTIAL_REQUIRED");
  dbUpdateChannel(id, { enabled });
  await notify("ravi.config.changed");
  return channels();
}
