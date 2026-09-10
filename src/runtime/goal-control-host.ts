import { getSession, getSessionByName } from "../router/sessions.js";
import { createRuntimeProvider } from "./provider-registry.js";
import { syncRuntimeSessionGoal } from "./session-goals.js";
import { resolveRuntimeControlSession, type RuntimeControlNatsRequest, type RuntimeSafeEmit } from "./control-host.js";
import type { RuntimeHostStreamingSession } from "./host-session.js";
import type { RuntimeControlRequest, RuntimeControlResult, RuntimeGoal } from "./types.js";
import { validateRuntimeSessionState } from "./session-state.js";

export function isRuntimeGoalOperation(operation: string): boolean {
  return ["goal.get", "goal.set", "goal.clear"].includes(operation);
}

export async function handleRuntimeGoalControl(
  data: RuntimeControlNatsRequest,
  options: {
    streamingSessions: Map<string, RuntimeHostStreamingSession>;
    safeEmit: RuntimeSafeEmit;
    retireIdle(name: string, session: RuntimeHostStreamingSession): Promise<void>;
    wake(name: string, goal: RuntimeGoal): Promise<void>;
    providerFactory?: typeof createRuntimeProvider;
  },
): Promise<void> {
  const request = data.request!;
  let result: RuntimeControlResult;
  try {
    const session =
      (data.sessionKey ? getSession(data.sessionKey) : undefined) ??
      (data.sessionName ? getSessionByName(data.sessionName) : undefined);
    if (!session) throw new Error("Session not found for runtime goal control");
    const name = session.name ?? data.sessionName;
    if (!name) throw new Error("Runtime goal control requires a named session");
    const resolved = resolveRuntimeControlSession(options.streamingSessions, name, session.sessionKey);
    const live = resolved?.session;
    const providerId = live?.queryHandle.provider ?? session.runtimeProvider;
    if (!providerId) throw new Error("Initialize the session runtime before setting a goal");
    if (session.runtimeProviderOverride && session.runtimeProviderOverride !== providerId)
      throw new Error("Start a turn with the selected provider before controlling its goal");
    const provider = (options.providerFactory ?? createRuntimeProvider)(providerId);
    if (!provider.getCapabilities().runtimeControl.operations.includes(request.operation))
      throw new Error(`Runtime provider '${providerId}' does not support native goals`);
    const activate =
      request.operation === "goal.set" &&
      (request.goal?.status === "active" || (!!request.goal?.objective && request.goal.status === undefined));
    if (live?.starting) throw new Error("Runtime is starting; retry goal control when the turn is ready");
    // Bind the request to this session; caller-supplied provider ids cannot redirect it.
    const scopedRequest: RuntimeControlRequest = {
      ...request,
      threadId: session.providerSessionId ?? session.runtimeSessionDisplayId,
    };
    let liveResult: RuntimeControlResult | undefined;
    if (live && (live.turnActive || !activate)) {
      if (!live.queryHandle.control) throw new Error("Runtime control is unavailable");
      liveResult = await live.queryHandle.control(scopedRequest);
    }
    // A provider can finish its physical turn before the host consumes the
    // terminal event. It must refuse untracked activation and request a wake.
    const storedControl =
      !liveResult ||
      (activate &&
        !liveResult.ok &&
        liveResult.data?.execution === "requires_managed_wake" &&
        liveResult.state?.activeTurn === false);
    if (storedControl) {
      // Activating on a loaded idle thread can start provider work immediately.
      // Unload first, update persisted metadata, then launch through the host.
      if (!provider.controlSession || !scopedRequest.threadId)
        throw new Error("Runtime does not support goal control for this stored session");
      const validation = validateRuntimeSessionState({
        capabilities: provider.getCapabilities(),
        storedProviderSessionId: scopedRequest.threadId,
        storedRuntimeSessionParams: session.runtimeSessionParams,
        sessionCwd: session.agentCwd,
      });
      if (!validation.valid) throw new Error(`Invalid stored runtime session: ${validation.reason}`);
      if (live) await options.retireIdle(name, live);
      result = await provider.controlSession(
        { cwd: session.agentCwd, sessionId: scopedRequest.threadId, sessionParams: session.runtimeSessionParams },
        scopedRequest,
      );
    } else {
      result = liveResult!;
    }
    if (result.ok) {
      if (result.goal === undefined) throw new Error("Runtime goal control did not return a confirmed snapshot");
      syncRuntimeSessionGoal(session.sessionKey, result.goal, data.goalMetadata);
      if (activate && result.goal?.status === "active" && storedControl && result.data?.changed !== false) {
        await options.wake(name, result.goal);
        result.data = { ...result.data, execution: "queued" };
      }
    }
  } catch (error) {
    result = { ok: false, operation: request.operation, error: error instanceof Error ? error.message : String(error) };
  }
  if (data.replyTopic) await options.safeEmit(data.replyTopic, { result });
}
