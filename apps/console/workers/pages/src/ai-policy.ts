/** Explicit installation capability. Cloud deployments without the flag are unchanged. */
export function pagesAiEnabled(env: { RAVI_PAGES_AI_ENABLED?: string }): boolean {
  return env.RAVI_PAGES_AI_ENABLED === undefined || env.RAVI_PAGES_AI_ENABLED === "1";
}
