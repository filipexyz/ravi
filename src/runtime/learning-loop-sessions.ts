const REPORT_SESSIONS = new Set(["memory-log", "skill-log"]);

export function isLearningLoopSessionExcluded(
  sessionName: string,
  configuredNames = process.env.RAVI_NUDGE_SKIP_SESSIONS,
): boolean {
  if (sessionName.endsWith("-curator")) return true;
  const configured = (configuredNames ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return REPORT_SESSIONS.has(sessionName) || configured.includes(sessionName);
}
