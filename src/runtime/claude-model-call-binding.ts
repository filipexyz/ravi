import type { ModelCallFence, ModelCallFenceOptions } from "./model-call-fence.js";
import { createModelCallFence } from "./model-call-fence.js";
import type { ModelCallProxy, ModelCallProxyInspection } from "./model-call-proxy.js";
import { startModelCallProxy } from "./model-call-proxy.js";

export type ClaudeSettingsControl = {
  applyFlagSettings(settings: { env: Record<string, string> }): Promise<void>;
};

export type ClaudeModelCallBindingOptions = ModelCallFenceOptions & {
  readonly fence?: ModelCallFence;
  readonly query: ClaudeSettingsControl;
  readonly environment: Readonly<Record<string, string>>;
  readonly upstreamBaseOverride?: string;
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
  readonly beforeDispatch?: (request: ModelCallProxyInspection) => void;
};

const ALTERNATE_TRANSPORTS = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

export async function bindClaudeModelCalls(options: ClaudeModelCallBindingOptions): Promise<ModelCallProxy> {
  const nativeEnv = await nativeSettingsEnvironment(options.query);
  const effectiveEnv = { ...options.environment, ...nativeEnv };
  assertHttpTransport(effectiveEnv);
  const upstream = options.upstreamBaseOverride ?? effectiveEnv.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
  const fence = options.fence ?? createModelCallFence(options);
  const proxy = startModelCallProxy({
    fence,
    beforeDispatch: options.beforeDispatch,
    routes: ["/v1/messages", "/v1/messages/count_tokens"].map((path) => ({
      method: "POST",
      path,
      upstream: { url: `${upstream.replace(/\/$/, "")}${path}`, headers: options.upstreamHeaders },
      queryKeys: ["beta"],
    })),
  });
  try {
    // This is the CLI's flag settings layer, above user/project/local settings.
    // Changing process env alone is insufficient: settings.env overrides it.
    await options.query.applyFlagSettings({
      env: {
        ...nativeEnv,
        ...Object.fromEntries(ALTERNATE_TRANSPORTS.map((key) => [key, "0"])),
        ANTHROPIC_BASE_URL: proxy.baseUrl,
      },
    });
    const pinned = await nativeSettingsEnvironment(options.query);
    assertHttpTransport({ ...options.environment, ...pinned });
    if (pinned.ANTHROPIC_BASE_URL !== proxy.baseUrl) {
      throw new Error("Claude could not pin model calls to the required local policy guard.");
    }
    return proxy;
  } catch (error) {
    await proxy.close();
    throw error;
  }
}

async function nativeSettingsEnvironment(query: ClaudeSettingsControl): Promise<Record<string, string>> {
  // SDK 0.3.239 implements this native control method but omits it from Query's
  // public declaration. Feature-detect it and fail closed on older runtimes.
  if (!("getSettings" in query) || typeof query.getSettings !== "function") {
    throw new Error("Claude cannot inspect the effective native model route.");
  }
  const result: unknown = await query.getSettings();
  if (!isRecord(result) || !isRecord(result.effective)) {
    throw new Error("Claude returned an invalid effective native configuration.");
  }
  if (result.effective.policyHelper !== undefined) {
    throw new Error("Claude policy-helper routing requires a separately supported model transport.");
  }
  const value = result.effective.env;
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new Error("Claude returned an invalid native environment configuration.");
  }
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function assertHttpTransport(env: Readonly<Record<string, string>>): void {
  if (ALTERNATE_TRANSPORTS.some((key) => env[key] && !/^(0|false)$/i.test(env[key]))) {
    throw new Error("Claude alternate cloud transport cannot use this model-call policy guard.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
