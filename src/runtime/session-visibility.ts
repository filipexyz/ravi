import type { SessionEntry } from "../router/types.js";
import { getRuntimeLiveStateForSession } from "./live-state.js";
import { emptySkillVisibilitySnapshot, readSkillVisibilityFromParams } from "./skill-visibility.js";
import type { RuntimeProviderId, RuntimeSkillVisibilitySnapshot } from "./types.js";

export interface RuntimeSessionVisibilityPayload {
  sessionKey: string;
  agentId: string;
  provider: RuntimeProviderId | null;
  tokens: {
    used: number | null;
    limit: number | null;
    remaining: number | null;
  };
  compact: {
    threshold: number | null;
    willCompactAt: number | null;
    lastCompactedAt: number | null;
    count: number;
  };
  skills: RuntimeSkillVisibilitySnapshot["skills"];
  loadedSkills: string[];
  lastUpdatedAt: number;
}

export function buildRuntimeSessionVisibilityPayload(session: SessionEntry): RuntimeSessionVisibilityPayload {
  const live = getRuntimeLiveStateForSession(session);
  const stored = readSkillVisibilityFromParams(session.runtimeSessionParams);
  const skillVisibility = selectSkillVisibility(live, stored, session.updatedAt);
  const usedTokens =
    typeof session.contextTokens === "number" && session.contextTokens > 0
      ? session.contextTokens
      : typeof session.totalTokens === "number"
        ? session.totalTokens
        : null;

  return {
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    provider: live?.provider ?? session.runtimeProvider ?? null,
    tokens: {
      used: usedTokens,
      limit: null,
      remaining: null,
    },
    compact: {
      threshold: null,
      willCompactAt: null,
      lastCompactedAt: null,
      count: session.compactionCount ?? 0,
    },
    skills: skillVisibility.skills,
    loadedSkills: skillVisibility.loadedSkills,
    lastUpdatedAt: Math.max(live?.updatedAt ?? 0, skillVisibility.updatedAt, session.updatedAt),
  };
}

function selectSkillVisibility(
  live: ReturnType<typeof getRuntimeLiveStateForSession>,
  stored: RuntimeSkillVisibilitySnapshot,
  sessionUpdatedAt: number,
): RuntimeSkillVisibilitySnapshot {
  const hasLiveSkillState = Boolean(live?.skills || live?.loadedSkills);
  const hasStoredSkillState = stored.skills.length > 0 || stored.loadedSkills.length > 0;

  if (live && hasLiveSkillState && (!hasStoredSkillState || live.updatedAt >= stored.updatedAt)) {
    return {
      skills: live.skills ?? [],
      loadedSkills: live.loadedSkills ?? [],
      updatedAt: live.updatedAt,
    };
  }
  if (hasStoredSkillState) {
    return stored;
  }
  if (live && hasLiveSkillState) {
    return {
      skills: live.skills ?? [],
      loadedSkills: live.loadedSkills ?? [],
      updatedAt: live.updatedAt ?? sessionUpdatedAt,
    };
  }
  return emptySkillVisibilitySnapshot(sessionUpdatedAt);
}
