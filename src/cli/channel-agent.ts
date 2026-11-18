/**
 * Shared helper for channel creation commands (`whatsapp group create`,
 * `slack channels-create`) that route the new chat to an agent in the same
 * call, optionally creating the agent first.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { fail, getContext } from "./context.js";
import { createAgent, getAgent } from "../router/config.js";
import { expandHome } from "../router/resolver.js";
import { ensureAgentInstructionFiles } from "../runtime/agent-instructions.js";
import { validateRuntimeModelSelector } from "../runtime/model-validation.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "../runtime/provider-registry.js";
import { ensureAgentCanViewAgent } from "../permissions/agent-default-capabilities-provider.js";
import { dbCreateRoute } from "../router/router-db.js";
import { nats } from "../nats.js";

export function defaultAgentCwd(agentId: string): string {
  return `${homedir()}/ravi/${agentId}`;
}

export function ensureChannelAgent(input: {
  agentId: string;
  createIfMissing?: boolean;
  cwd?: string;
  provider?: string;
  model?: string;
}): {
  status: "existing" | "created";
  agentId: string;
  cwd: string;
  provider?: string;
  model?: string;
} {
  const existing = getAgent(input.agentId);
  if (existing) {
    return {
      status: "existing",
      agentId: existing.id,
      cwd: expandHome(existing.cwd),
      ...(existing.provider ? { provider: existing.provider } : {}),
      ...(existing.model ? { model: existing.model } : {}),
    };
  }

  if (!input.createIfMissing) {
    fail(`Agent not found: ${input.agentId}. Pass --create-agent to create it before routing the channel.`);
  }

  const provider = input.provider?.trim() || undefined;
  const model = input.model?.trim() || undefined;
  if (model) {
    const result = validateRuntimeModelSelector(provider ?? DEFAULT_RUNTIME_PROVIDER_ID, model);
    if (!result.ok) fail(result.error ?? `Invalid model: ${model}`);
  }

  const cwd = expandHome(input.cwd?.trim() || defaultAgentCwd(input.agentId));
  mkdirSync(cwd, { recursive: true });
  const created = createAgent({
    id: input.agentId,
    cwd,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  });
  const creatorAgentId = getContext()?.agentId;
  if (creatorAgentId && creatorAgentId !== created.id) {
    ensureAgentCanViewAgent(creatorAgentId, created.id);
  }
  ensureAgentInstructionFiles(cwd, {
    createAgentsStub: `# ${input.agentId}\n\nInstruções do agente aqui.\n`,
  });
  return {
    status: "created",
    agentId: created.id,
    cwd,
    ...(created.provider ? { provider: created.provider } : {}),
    ...(created.model ? { model: created.model } : {}),
  };
}

/**
 * Fail before any provider call when the requested route target is not usable:
 * `--create-agent` needs `--agent`, and an existing agent is required unless the
 * caller asked to create it.
 */
export function assertChannelAgentRequest(agentId?: string, createIfMissing?: boolean): void {
  if (!agentId && createIfMissing) fail("--create-agent requires --agent <id>");
  if (agentId && !createIfMissing && !getAgent(agentId)) {
    fail(`Agent not found: ${agentId}. Pass --create-agent to create it before routing the channel.`);
  }
}

export interface ChannelRouteResult {
  status: "created";
  pattern: string;
  agent: string;
  accountId: string;
  route: unknown;
}

/**
 * Route one chat (exact `group:<id>` pattern) to an agent and notify the daemon
 * so the live router picks it up before the first message arrives. A failed
 * route write throws: the caller must not report a routed chat that is not.
 */
export function routeChatToAgent(input: {
  pattern: string;
  agent: string;
  accountId: string;
  channel: string;
}): ChannelRouteResult {
  const route = dbCreateRoute({
    pattern: input.pattern,
    agent: input.agent,
    accountId: input.accountId,
    priority: 0,
    channel: input.channel,
  });
  void nats.emit("ravi.config.changed", {}).catch((error: unknown) => {
    // The route row is already committed; the daemon also reloads on its own cadence.
    console.warn("ravi.config.changed notification failed after routing the channel:", error);
  });
  return { status: "created", pattern: input.pattern, agent: input.agent, accountId: input.accountId, route };
}
