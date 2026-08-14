export const KIMI_CODE_ENABLED_ENV = "RAVI_KIMI_CODE_ENABLED";

export function isKimiCodeSessionStartEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[KIMI_CODE_ENABLED_ENV] === "1";
}
