export const TRIAGE_ENGINE_NOT_CONFIGURED = "triage_engine_not_configured";
export const DEFAULT_BUG_TRIAGE_MODEL = "qwen3.8-27b";
export const BUG_TRIAGE_API_BASE_ENV = "RAVI_BUG_TRIAGE_API_BASE";
export const BUG_TRIAGE_API_KEY_ENV = "RAVI_BUG_TRIAGE_API_KEY";
export const BUG_TRIAGE_MODEL_ENV = "RAVI_BUG_TRIAGE_MODEL";

export type BugTriageEngineConfig = {
  apiBase: string;
  apiKey: string;
  model: string;
};

type EnvMap = Record<string, string | undefined>;

export function readBugTriageEngineConfig(
  env: EnvMap = process.env,
): BugTriageEngineConfig | null {
  const apiBase = env[BUG_TRIAGE_API_BASE_ENV]?.trim();
  const apiKey = env[BUG_TRIAGE_API_KEY_ENV]?.trim();
  const model = env[BUG_TRIAGE_MODEL_ENV]?.trim() || DEFAULT_BUG_TRIAGE_MODEL;
  if (!apiBase || !apiKey) return null;
  return { apiBase: apiBase.replace(/\/$/, ""), apiKey, model };
}

export function isBugTriageEngineConfigured(env: EnvMap = process.env) {
  return readBugTriageEngineConfig(env) !== null;
}
