import { z } from "zod";

export const CODEX_SKILL_FENCE_PROVIDER = "ravi_skill_fence";

const configSchema = z.object({
  config: z.object({
    model_provider: z.string().nullish(),
    openai_base_url: z.string().nullish(),
    model_providers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
});
const accountSchema = z.object({ account: z.object({ type: z.string() }).passthrough().nullable() });

export type CodexProtectedModelRoute = {
  readonly upstreamBaseUrl: string;
  readonly providerOptions: Readonly<Record<string, unknown>>;
};

/** Authentication stays inside Codex; only the destination is replaced. */
export function resolveCodexProtectedModelRoute(
  response: unknown,
  accountResponse: unknown,
  _environment: NodeJS.ProcessEnv = {},
): CodexProtectedModelRoute {
  const parsed = configSchema.safeParse(response);
  if (!parsed.success) throw unsupported();
  const config = parsed.data.config;
  const providerId = config.model_provider ?? "openai";
  if (providerId === "openai") {
    const account = accountSchema.safeParse(accountResponse);
    if (!account.success || ![undefined, "apiKey", "chatgpt"].includes(account.data.account?.type)) throw unsupported();
    const base =
      config.openai_base_url ??
      (account.data.account?.type === "chatgpt"
        ? "https://chatgpt.com/backend-api/codex"
        : "https://api.openai.com/v1");
    return {
      upstreamBaseUrl: safeBaseUrl(base),
      providerOptions: { name: "OpenAI", requires_openai_auth: true, wire_api: "responses" },
    };
  }
  const source = config.model_providers?.[providerId];
  if (
    !source ||
    typeof source.base_url !== "string" ||
    (source.wire_api !== undefined && source.wire_api !== "responses")
  ) {
    throw unsupported();
  }
  if (source.query_params && (typeof source.query_params !== "object" || Object.keys(source.query_params).length > 0)) {
    throw unsupported();
  }
  return { upstreamBaseUrl: safeBaseUrl(source.base_url), providerOptions: { ...source } };
}

export function buildCodexProtectedModelConfig(
  route: CodexProtectedModelRoute,
  proxyBaseUrl: string,
  disabledSkills: readonly { readonly path: string; readonly enabled: false }[],
): Record<string, unknown> {
  const provider = {
    ...route.providerOptions,
    name: route.providerOptions.name ?? "RAVI guarded Responses",
    base_url: safeBaseUrl(proxyBaseUrl),
    wire_api: "responses",
    supports_websockets: false,
  };
  return {
    ...Object.fromEntries(
      Object.entries(provider)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => [`model_providers.${CODEX_SKILL_FENCE_PROVIDER}.${key}`, value]),
    ),
    model_provider: CODEX_SKILL_FENCE_PROVIDER,
    "skills.config": disabledSkills,
    "features.enable_request_compression": false,
    "features.multi_agent": false,
    "features.multi_agent_v2": false,
    "agents.enabled": false,
    "features.remote_plugin": false,
  };
}

function safeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unsupported();
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw unsupported();
  return url.toString().replace(/\/+$/, "");
}

function unsupported(): Error {
  return new Error("Codex protected model routing is unsupported for this configuration.");
}
