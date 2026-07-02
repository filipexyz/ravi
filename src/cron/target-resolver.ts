/**
 * Cron Target Resolver
 *
 * Computes read-only target resolution state for cron jobs at inspection time.
 * Used by cron list, cron show, and doctor. Never persists health state.
 */

import type { CronJob } from "./types.js";
import type { CronRoutingResolution } from "../cli/cron-show-output.js";

export type CronTargetState = "ok" | "agent_missing" | "reply_session_missing" | "derived_key" | "unresolved";

export interface CronTargetResolution {
  state: CronTargetState;
  agentExists: boolean | null;
  replySessionLive: boolean | null;
  routingKind: CronRoutingResolution["kind"];
  detail?: string;
}

export interface CronTargetResolverDeps {
  getAgent: (id: string) => unknown | null;
  getDefaultAgentId: () => string;
  resolveSession: (nameOrKey: string) => { name?: string } | null;
  deriveSourceFromSessionKey: (
    key: string,
  ) => { channel: string; accountId: string; chatId: string; threadId?: string } | null;
}

export function resolveCronTarget(job: CronJob, deps: CronTargetResolverDeps): CronTargetResolution {
  if (job.executionType === "shell") {
    return resolveShellTarget(job, deps);
  }
  return resolveAgentTarget(job, deps);
}

function resolveShellTarget(job: CronJob, deps: CronTargetResolverDeps): CronTargetResolution {
  // Shell jobs have no agent executor requirement.
  // Diagnose onError notification target if present.
  if (job.onError) {
    const match = job.onError.match(/^notify-session:(.+)$/);
    if (match) {
      const sessionKey = match[1];
      const session = deps.resolveSession(sessionKey);
      if (session?.name) {
        return {
          state: "ok",
          agentExists: null,
          replySessionLive: true,
          routingKind: "resolved-session",
        };
      }
      const derived = deps.deriveSourceFromSessionKey(sessionKey);
      if (derived) {
        return {
          state: "derived_key",
          agentExists: null,
          replySessionLive: false,
          routingKind: "derived-key",
          detail: `onError notification target "${sessionKey}" uses derived-key routing`,
        };
      }
      return {
        state: "reply_session_missing",
        agentExists: null,
        replySessionLive: false,
        routingKind: "none",
        detail: `onError notification target "${sessionKey}" does not resolve`,
      };
    }
  }

  // Shell job with no notification target — always ok
  return {
    state: "ok",
    agentExists: null,
    replySessionLive: null,
    routingKind: "none",
  };
}

function resolveAgentTarget(job: CronJob, deps: CronTargetResolverDeps): CronTargetResolution {
  const effectiveAgentId = job.agentId ?? deps.getDefaultAgentId();
  const agent = deps.getAgent(effectiveAgentId);
  const agentExists = agent !== null;

  if (!agentExists) {
    return {
      state: "agent_missing",
      agentExists: false,
      replySessionLive: null,
      routingKind: "none",
      detail: `agent "${effectiveAgentId}" is not registered`,
    };
  }

  // Check reply session
  if (!job.replySession) {
    return {
      state: "ok",
      agentExists: true,
      replySessionLive: null,
      routingKind: "none",
    };
  }

  const session = deps.resolveSession(job.replySession);
  if (session?.name) {
    return {
      state: "ok",
      agentExists: true,
      replySessionLive: true,
      routingKind: "resolved-session",
    };
  }

  // Session doesn't resolve — check if key-derived routing works
  const derived = deps.deriveSourceFromSessionKey(job.replySession);
  if (derived) {
    return {
      state: "derived_key",
      agentExists: true,
      replySessionLive: false,
      routingKind: "derived-key",
      detail: `replySession "${job.replySession}" falls back to derived-key routing`,
    };
  }

  return {
    state: "reply_session_missing",
    agentExists: true,
    replySessionLive: false,
    routingKind: "none",
    detail: `replySession "${job.replySession}" does not resolve and cannot derive routing`,
  };
}
