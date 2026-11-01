import { z } from "zod";
import { configStore } from "../config-store.js";
import {
  getSession,
  getOrCreateSession,
  updateSessionModelOverride,
  updateSessionEffortOverride,
} from "../router/sessions.js";
import { resolveEffectiveSessionRuntime } from "../runtime/runtime-selection.js";
import { listRuntimeModels } from "../runtime/model-catalog.js";
import { RUNTIME_EFFORT_LEVELS } from "../runtime/effort.js";
import { currentConsoleInvocation, consoleInvocationLive } from "../sdk/gateway/console-context.js";
import { BridgeError } from "./protocol.js";
import { conversationAgentsAllowed } from "./teams.js";
import { consoleConversationCwd } from "./native.js";

export const desktopSessionSchema = z.object({
  provider: z.string(),
  model: z.string(),
  effort: z.enum(RUNTIME_EFFORT_LEVELS),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
});
function target(id: string, action: string) {
  const invocation = currentConsoleInvocation();
  if (
    !invocation ||
    !consoleInvocationLive(invocation) ||
    invocation.grant.access.resource !== "desktop.session" ||
    invocation.grant.access.action !== action ||
    invocation.grant.scope.kind !== "session" ||
    invocation.grant.scope.conversationId !== id
  )
    throw new BridgeError("CONSOLE_AUTHORITY_REQUIRED");
  const { grant, service, enrollment } = invocation;
  const c = service.store.authorizedConversation(id, enrollment, grant.sub, grant.projectId);
  if (!conversationAgentsAllowed(service.store, c, grant)) throw new BridgeError("NOT_FOUND_OR_DENIED");
  return c;
}
function configuration(c: ReturnType<typeof target>) {
  const agent = configStore.getConfig().agents[c.agent_id];
  if (!agent) throw new BridgeError("NOT_FOUND_OR_DENIED");
  const session = getSession(c.session_key);
  const selected = resolveEffectiveSessionRuntime({ session: session ?? { agentId: agent.id }, agent });
  if (selected.model.error) throw new BridgeError("MODEL_CONFIGURATION_INVALID");
  const model = selected.model.value ?? "default";
  // A custom isolated endpoint has its own model namespace; never advertise
  // unrelated cached OpenAI models as supported by that endpoint.
  const models = process.env.RAVI_BRIDGE_CODEX_PROVIDER_FILE
    ? []
    : listRuntimeModels("codex").map((m) => ({ id: m.id, label: m.name }));
  if (!models.some((m) => m.id === model)) models.unshift({ id: model, label: model });
  return { provider: selected.provider.value, model, effort: selected.effort.value, models };
}
export function desktopSessionRead(id: string) {
  return configuration(target(id, "read"));
}
export function desktopSessionConfigure(id: string, model: string, effort: (typeof RUNTIME_EFFORT_LEVELS)[number]) {
  const c = target(id, "configure"),
    current = configuration(c);
  if (current.provider !== "codex" || !current.models.some((item) => item.id === model))
    throw new BridgeError("MODEL_NOT_AVAILABLE");
  getOrCreateSession(c.session_key, c.agent_id, consoleConversationCwd(c.id), {
    name: c.session_name,
    channel: "console",
  });
  updateSessionModelOverride(c.session_key, model);
  updateSessionEffortOverride(c.session_key, effort);
  return configuration(c);
}
