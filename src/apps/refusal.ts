/**
 * Refusals the app router makes BEFORE any app process starts (spec apps/router, "Refusals Before Start").
 *
 * Until this module, each of them was a plain `Error` and the router's catch folded all of them into
 * `APP_OPERATION_FAILED` with the fixed text "Ravi app operation failed.". The caller (the CLI, the gateway, the agent)
 * could not tell an unknown operation from a broken manifest from a reserved operation, and the cause was dropped.
 *
 * What these errors carry is Ravi's own text, built from identifiers the manifest validation already accepted. It is
 * never an app's own output, so it can travel to the public envelope as the cause.
 */

export const RAVI_APP_REFUSAL_CODES = [
  "APP_MANIFEST_INVALID",
  "APP_OPERATION_UNKNOWN",
  "APP_OPERATION_RESERVED",
] as const;

export type RaviAppRefusalCode = (typeof RAVI_APP_REFUSAL_CODES)[number];

export class RaviAppRefusalError extends Error {
  readonly code: RaviAppRefusalCode;

  constructor(code: RaviAppRefusalCode, message: string) {
    super(message);
    this.name = "RaviAppRefusalError";
    this.code = code;
  }
}

export function isRaviAppRefusalCode(code: string | undefined): code is RaviAppRefusalCode {
  return code !== undefined && (RAVI_APP_REFUSAL_CODES as readonly string[]).includes(code);
}

/** The headline and the next step Ravi gives for each refusal. The cause (the error text) travels in the diagnostic. */
export const RAVI_APP_REFUSALS: Record<RaviAppRefusalCode, { headline: string; suggestedAction: string }> = {
  APP_MANIFEST_INVALID: {
    headline: "Ravi app manifest is invalid.",
    suggestedAction: "Fix the app manifest the cause names, run `ravi apps check`, then retry",
  },
  APP_OPERATION_UNKNOWN: {
    headline: "Ravi app operation was not found.",
    suggestedAction: "List the app's operations with `ravi apps show <app-id>` and call one of them",
  },
  APP_OPERATION_RESERVED: {
    headline: "Ravi app operation is reserved and cannot be run directly.",
    suggestedAction: "Call an operation the app lists for callers; reserved operations are run by Ravi itself",
  },
};
