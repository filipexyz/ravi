/**
 * Pi Provider Commands - configure and inspect the `pi` runtime provider.
 *
 * The `pi` provider (`@mariozechner/pi-coding-agent`) lets a Ravi agent run on
 * external model backends (Google, z.ai/GLM, OpenAI-compatible endpoints, etc).
 * This CLI is the deterministic surface for that: inspect what pi resolves,
 * check which providers are authenticated, and register a custom/missing model
 * without hand-editing pi's config files or searching vendor docs every time.
 *
 * Persistence model (ground truth, pi docs):
 *   - Auth keys:   ~/.pi/agent/auth.json          (one key per provider)
 *   - Settings:    ~/.pi/agent/settings.json      (defaultProvider/Model, packages)
 *   - Custom model = a TypeScript extension in ~/.pi/agent/extensions/<id>.ts
 *     that calls pi.registerProvider({ baseUrl, apiKey, api, models: [...] }).
 */

import "reflect-metadata";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Group, Command, CommandAccess, Option, Returns } from "../decorators.js";
import { fail } from "../context.js";
import { buildCliOffsetPagination } from "../pagination.js";
import { strictCliOffsetPaginationSchema } from "../return-schemas.js";
import { dbListAgents } from "../../router/router-db.js";

// --- paths + pi binary resolution (mirrors src/runtime/pi-provider.ts) ---
// Resolved per call (not cached) so RAVI_PI_AGENT_DIR overrides work at runtime
// and under test, mirroring how pi itself resolves ~/.pi/agent.
function piAgentDir(): string {
  return process.env.RAVI_PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}
const authFile = (): string => join(piAgentDir(), "auth.json");
const settingsFile = (): string => join(piAgentDir(), "settings.json");
const extensionsDir = (): string => join(piAgentDir(), "extensions");
const EXTENSION_MARKER = "ravi-pi:managed"; // only remove extensions this CLI wrote

function resolvePiCommand(): string {
  return process.env.RAVI_PI_COMMAND?.trim() || process.env.PI_COMMAND?.trim() || "pi";
}

function readJsonFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** auth.json keys ARE the authenticated provider ids. Never read the values. */
function authenticatedProviderKeys(): string[] {
  const auth = readJsonFile(authFile());
  return auth ? Object.keys(auth).sort() : [];
}

function readSettings(): Record<string, unknown> {
  return readJsonFile(settingsFile()) ?? {};
}

type PiRunResult = { ok: boolean; stdout: string; stderr: string; status: number | null };

function runPi(args: string[], timeoutMs = 45_000): PiRunResult {
  const command = resolvePiCommand();
  const res = spawnSync(command, args, {
    encoding: "utf-8",
    timeout: timeoutMs,
    // default to offline so inspection commands never trigger pi's startup
    // network calls (update/telemetry); the caller can override PI_OFFLINE.
    env: { ...process.env, PI_OFFLINE: process.env.PI_OFFLINE ?? "1" },
  });
  if (res.error) {
    const code = (res.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      fail(
        `pi binary not found (tried "${command}"). Install pi or set RAVI_PI_COMMAND to its path. ` +
          `Check with: which pi`,
      );
    }
    fail(`Failed to run "${command} ${args.join(" ")}": ${res.error.message}`);
  }
  return {
    ok: res.status === 0,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    status: res.status,
  };
}

// --- pi --list-models table parser ---
export type PiModelRow = {
  provider: string;
  model: string;
  context: string;
  maxOut: string;
  thinking: boolean;
  images: boolean;
};

/** Parse the whitespace-column table from `pi --list-models`. */
export function parseListModelsTable(stdout: string): PiModelRow[] {
  const rows: PiModelRow[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // header row starts with "provider"
    if (/^provider\s+model\b/i.test(trimmed)) continue;
    const cols = trimmed.split(/\s{2,}/).map((c) => c.trim());
    if (cols.length < 6) continue;
    const [provider, model, context, maxOut, thinking, images] = cols;
    rows.push({
      provider,
      model,
      context,
      maxOut,
      thinking: /^yes$/i.test(thinking),
      images: /^yes$/i.test(images),
    });
  }
  return rows;
}

/** Build the source of a managed pi provider extension (pure, so it is unit-testable). */
export function buildProviderExtensionSource(opts: {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKeyEnv: string;
  api: string;
  label: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
}): string {
  return `// ${EXTENSION_MARKER} — generated by \`ravi pi models add\`. Edit via the CLI, not by hand.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider(${JSON.stringify(opts.providerId)}, {
    name: ${JSON.stringify(opts.label)},
    baseUrl: ${JSON.stringify(opts.baseUrl)},
    apiKey: ${JSON.stringify(opts.apiKeyEnv)},
    api: ${JSON.stringify(opts.api)},
    models: [
      {
        id: ${JSON.stringify(opts.modelId)},
        name: ${JSON.stringify(opts.modelId)},
        reasoning: ${opts.reasoning ? "true" : "false"},
        input: ${JSON.stringify(opts.input)},
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: ${opts.contextWindow},
        maxTokens: ${opts.maxTokens},
      },
    ],
  });
}
`;
}

function listModelRows(): PiModelRow[] {
  const res = runPi(["--list-models"]);
  // pi prints the models table to stderr (it treats it as log-like output),
  // so combine both streams before parsing.
  const combined = `${res.stdout}\n${res.stderr}`;
  const rows = parseListModelsTable(combined);
  if (!res.ok && rows.length === 0) {
    fail(`\`pi --list-models\` failed (exit ${res.status ?? "null"}): ${res.stderr.trim() || "no output"}`);
  }
  return rows;
}

function piVersion(): string {
  const res = runPi(["--version"], 10_000);
  return res.stdout.trim() || res.stderr.trim() || "unknown";
}

function agentsUsingPi(): Array<{ id: string; model: string | null }> {
  try {
    return dbListAgents()
      .filter((a) => (a.provider ?? null) === "pi")
      .map((a) => ({ id: a.id, model: a.model ?? null }));
  } catch {
    return [];
  }
}

// --- return schemas ---
const modelRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  context: z.string(),
  maxOut: z.string(),
  thinking: z.boolean(),
  images: z.boolean(),
});

const piStatusReturnSchema = z
  .object({
    piCommand: z.string(),
    piVersion: z.string(),
    defaultProvider: z.string().nullable(),
    defaultModel: z.string().nullable(),
    authenticatedProviders: z.array(z.string()),
    managedExtensions: z.array(z.string()),
    agentsUsingPi: z.array(z.object({ id: z.string(), model: z.string().nullable() })),
  })
  .strict();

const piModelsListReturnSchema = z
  .object({
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    items: z.array(modelRowSchema),
  })
  .strict();

const piProvidersListReturnSchema = z
  .object({
    total: z.number(),
    pagination: strictCliOffsetPaginationSchema,
    items: z.array(
      z.object({
        provider: z.string(),
        authenticated: z.boolean(),
        modelCount: z.number(),
      }),
    ),
  })
  .strict();

const piAuthCheckReturnSchema = z
  .object({
    provider: z.string(),
    authenticated: z.boolean(),
    source: z.enum(["auth.json", "env", "none"]),
    envVar: z.string().nullable(),
  })
  .strict();

const piModelAddReturnSchema = z
  .object({
    providerId: z.string(),
    modelId: z.string(),
    extensionPath: z.string(),
    created: z.boolean(),
    resolvesNow: z.boolean(),
  })
  .strict();

const piModelRemoveReturnSchema = z
  .object({
    providerId: z.string(),
    extensionPath: z.string(),
    removed: z.boolean(),
  })
  .strict();

const piDoctorReturnSchema = z
  .object({
    scope: z.enum(["agent", "provider"]),
    agentId: z.string().nullable(),
    model: z.string().nullable(),
    provider: z.string().nullable(),
    authenticated: z.boolean(),
    modelResolves: z.boolean(),
    issues: z.array(z.string()),
    healthy: z.boolean(),
  })
  .strict();

// known env var per native pi provider key (providers.md)
const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  zai: "ZAI_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  minimax: "MINIMAX_API_KEY",
};

const STATUS_HELP = `
USE
  ✓ Antes de configurar/debugar o pi: ver o que já está autenticado e o que o daemon usa.
NÃO USE
  ✗ Listar todos os modelos → \`ravi pi models list\`   ✗ Testar 1 agente → \`ravi pi doctor --agent <id>\`
OUTPUT
  --json: { piVersion, defaultProvider, defaultModel, authenticatedProviders[], managedExtensions[], agentsUsingPi[] }
  authenticatedProviders vem das CHAVES de ~/.pi/agent/auth.json — valores (segredos) nunca são lidos/impressos.
EXAMPLES
  ravi pi status
  ravi pi status --json
ON ERROR
  "pi binary not found" → instale o pi ou defina RAVI_PI_COMMAND=/caminho/do/pi
FONTES
  ~/.pi/agent/{auth.json,settings.json,extensions/} · pi docs providers.md/settings.md (2026-07)
`;

const MODELS_LIST_HELP = `
USE
  ✓ Descobrir o id exato de um modelo (ex: glm-*, gemini-*) antes de apontar um agente.
NÃO USE
  ✗ Registrar modelo custom/faltante → \`ravi pi models add\`
NOTA
  \`pi --list-models\` só mostra modelos de providers AUTENTICADOS. Se um provider (ex: zai) não
  aparece, rode \`ravi pi auth check --provider zai\` — falta a API key.
OUTPUT
  --json: { total, pagination{ nextCommand }, items[]{ provider, model, context, maxOut, thinking, images } }
EXAMPLES
  ravi pi models list
  ravi pi models list --provider google
  ravi pi models list --query glm --json
ON ERROR
  lista vazia p/ um provider → auth ausente (ver NOTA) ou modelo não existe nessa release do pi
FONTES
  \`pi --list-models\` · pi docs models.md/providers.md (2026-07)
`;

const PROVIDERS_LIST_HELP = `
USE
  ✓ Ver quais providers o pi conhece e quais estão autenticados neste ambiente.
OUTPUT
  --json: { total, pagination, items[]{ provider, authenticated, modelCount } }
EXAMPLES
  ravi pi providers list
  ravi pi providers list --json
FONTES
  ~/.pi/agent/auth.json (autenticados) + \`pi --list-models\` (modelos por provider)
`;

const AUTH_CHECK_HELP = `
USE
  ✓ Confirmar se um provider tem credencial ANTES de apontar um agente ou registrar modelo.
REGRAS HARD
  • NUNCA imprime segredo — só diz se existe e de onde (auth.json / env var).
OUTPUT
  --json: { provider, authenticated, source: "auth.json"|"env"|"none", envVar }
EXAMPLES
  ravi pi auth check --provider zai
  ravi pi auth check --provider google --json
ON ERROR
  authenticated=false → rode \`pi\` interativo e \`/login\` no provider, ou \`export <ENV_VAR>=...\`
FONTES
  ~/.pi/agent/auth.json (chaves) + env vars da tabela em pi docs providers.md
`;

const MODEL_ADD_HELP = `
USE
  ✓ Registrar um modelo custom OU um modelo que a release do pi ainda não conhece, via endpoint
    OpenAI-compatible (ex: um GLM novo, um deploy self-hosted, um gateway corporativo).
NÃO USE
  ✗ O modelo já aparece em \`ravi pi models list\` → NÃO precisa registrar, só apontar o agente +
    garantir auth (\`ravi pi auth check\`). Registrar duplicado gera conflito de provider.
COMO FUNCIONA
  Gera uma extension pi em ~/.pi/agent/extensions/<provider-id>.ts que chama pi.registerProvider().
  A API key NÃO vai no arquivo — vai o NOME da env var (--api-key-env), resolvida em runtime.
REGRAS HARD
  • --api-key-env recebe o NOME da variável (ex: ZAI_API_KEY), nunca o valor do segredo.
  • Só remove/sobrescreve extensions marcadas como managed por este CLI.
OUTPUT
  --json: { providerId, modelId, extensionPath, created, resolvesNow }
  resolvesNow=true → o modelo já aparece em \`pi --list-models\` (auth presente + extension válida).
EXAMPLES
  # GLM 5.2 via z.ai (endpoint OpenAI-compatible)
  ravi pi models add --provider-id zai-glm --name "z.ai GLM" \\
    --base-url https://api.z.ai/api/paas/v4 --api-key-env ZAI_API_KEY --api openai-completions \\
    --model-id glm-5.2 --context-window 200000 --max-tokens 8192 --reasoning
ON ERROR
  resolvesNow=false → export da env var faltando (\`ravi pi auth check\`) ou base-url errada
  extension já existe (não-managed) → escolha outro --provider-id ou remova manualmente
PIPELINE
  ravi pi models add → ravi pi auth check → ravi pi doctor → ravi agents set <id> provider pi model <model-id>
FONTES
  pi docs custom-provider.md (registerProvider) · ~/.pi/agent/extensions/ (2026-07)
`;

const MODEL_REMOVE_HELP = `
USE
  ✓ Remover um provider/modelo custom registrado por este CLI.
REGRAS HARD
  • Só remove extensions marcadas "${EXTENSION_MARKER}" — extensions de terceiros são protegidas.
OUTPUT
  --json: { providerId, extensionPath, removed }
EXAMPLES
  ravi pi models remove --provider-id zai-glm
ON ERROR
  "not managed by ravi pi" → o arquivo não foi criado por este CLI; remova manualmente se for seu
FONTES
  ~/.pi/agent/extensions/<provider-id>.ts
`;

const DOCTOR_HELP = `
USE
  ✓ Validar ponta-a-ponta que o pi de um agente resolve: auth presente + modelo existe no registry.
  ✓ Sem --agent: saúde geral do provider pi (binário, auth, defaults).
OUTPUT
  --json: { scope, agentId, model, provider, authenticated, modelResolves, issues[], healthy }
EXAMPLES
  ravi pi doctor
  ravi pi doctor --agent antigravity-pi
ON ERROR
  healthy=false → leia issues[]: cada item diz o que falta e como corrigir
FONTES
  \`pi --list-models\` + ~/.pi/agent/auth.json + config do agente (runtimeProvider/model)
`;

@Group({
  name: "pi",
  description: "Inspect and health-check the pi runtime provider (models, auth, agents)",
  scope: "admin",
})
export class PiCommands {
  @Command({
    name: "status",
    description: "Show pi provider status: version, defaults, authenticated providers, agents using pi",
    helpAfter: STATUS_HELP,
  })
  @CommandAccess({ kind: "read", resource: "pi", action: "status", risk: "low" })
  @Returns(piStatusReturnSchema)
  status(@Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean) {
    const settings = readSettings();
    const managed = existsSync(extensionsDir())
      ? readdirSync(extensionsDir()).filter(
          (f) => f.endsWith(".ts") && readFileSync(join(extensionsDir(), f), "utf-8").includes(EXTENSION_MARKER),
        )
      : [];
    const payload = {
      piCommand: resolvePiCommand(),
      piVersion: piVersion(),
      defaultProvider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : null,
      defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : null,
      authenticatedProviders: authenticatedProviderKeys(),
      managedExtensions: managed,
      agentsUsingPi: agentsUsingPi(),
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`pi ${payload.piVersion} (${payload.piCommand})`);
      console.log(`default: ${payload.defaultProvider ?? "-"} / ${payload.defaultModel ?? "-"}`);
      console.log(`authenticated: ${payload.authenticatedProviders.join(", ") || "(none)"}`);
      console.log(`managed extensions: ${payload.managedExtensions.join(", ") || "(none)"}`);
      console.log(
        `agents on pi: ${payload.agentsUsingPi.map((a) => `${a.id}=${a.model ?? "?"}`).join(", ") || "(none)"}`,
      );
    }
    return payload;
  }

  @Command({
    name: "doctor",
    description: "Validate the pi setup end-to-end (auth present + model resolves), optionally for one agent",
    helpAfter: DOCTOR_HELP,
  })
  @CommandAccess({ kind: "read", resource: "pi", action: "doctor", risk: "low" })
  @Returns(piDoctorReturnSchema)
  doctor(
    @Option({ flags: "--agent <id>", description: "Validate this agent's pi model resolves" }) agentId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const issues: string[] = [];
    const rows = listModelRows();
    const authed = new Set(authenticatedProviderKeys());

    let scope: "agent" | "provider" = "provider";
    let model: string | null = null;
    let provider: string | null = null;

    if (agentId) {
      scope = "agent";
      const agent = dbListAgents().find((a) => a.id === agentId);
      if (!agent) fail(`Agent not found: ${agentId}. List agents: ravi agents list`);
      if ((agent!.provider ?? null) !== "pi") {
        issues.push(`agent "${agentId}" provider is "${agent!.provider ?? "(default)"}", not "pi"`);
      }
      model = agent!.model ?? null;
      if (!model) issues.push(`agent "${agentId}" has no model set`);
    }

    const matched = model ? rows.find((r) => r.model === model || `${r.provider}/${r.model}` === model) : undefined;
    if (model) {
      provider = matched?.provider ?? null;
      if (!matched)
        issues.push(`model "${model}" does not resolve in \`pi --list-models\` (missing auth or not registered)`);
    }
    if (provider && !authed.has(provider)) {
      issues.push(`provider "${provider}" is not authenticated (ravi pi auth check --provider ${provider})`);
    }
    if (!agentId && authed.size === 0) issues.push("no pi provider is authenticated");

    const payload = {
      scope,
      agentId: agentId ?? null,
      model,
      provider,
      // for an agent whose provider we could not determine (model did not
      // resolve), do not claim it is authenticated just because SOME provider is.
      authenticated: provider ? authed.has(provider) : scope === "agent" ? false : authed.size > 0,
      modelResolves: model ? Boolean(matched) : true,
      issues,
      healthy: issues.length === 0,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(payload.healthy ? "✅ healthy" : "❌ issues found");
      for (const i of payload.issues) console.log(`  • ${i}`);
    }
    return payload;
  }
}

@Group({ name: "pi.models", description: "List and register models available to the pi provider", scope: "admin" })
export class PiModelsCommands {
  @Command({
    name: "list",
    description: "List models pi can resolve (authenticated providers only)",
    helpAfter: MODELS_LIST_HELP,
  })
  @CommandAccess({ kind: "read", resource: "pi", action: "models_list", risk: "low" })
  @Returns(piModelsListReturnSchema)
  list(
    @Option({ flags: "--provider <name>", description: "Filter by provider id (e.g. google, zai)" }) provider?: string,
    @Option({ flags: "--query <text>", description: "Substring match on model id" }) query?: string,
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Rows to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    let rows = listModelRows();
    if (provider) rows = rows.filter((r) => r.provider === provider);
    if (query) {
      const q = query.toLowerCase();
      rows = rows.filter((r) => r.model.toLowerCase().includes(q));
    }

    const parsedLimit = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 500);
    const parsedOffset = Math.max(Number(offset ?? 0) || 0, 0);
    const page = rows.slice(parsedOffset, parsedOffset + parsedLimit);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "pi", "models", "list"],
      limit: parsedLimit,
      offset: parsedOffset,
      returned: page.length,
      total: rows.length,
      options: [...(provider ? [`--provider ${provider}`] : []), ...(query ? [`--query ${query}`] : [])],
    });
    const payload = { total: rows.length, pagination, items: page };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else {
      for (const r of page) console.log(`${r.provider}\t${r.model}\tctx=${r.context}\tthinking=${r.thinking}`);
      if (pagination.hasMore)
        console.log(`\n… ${payload.total - parsedOffset - page.length} more. Next: ${pagination.nextCommand}`);
    }
    return payload;
  }

  @Command({
    name: "add",
    description: "Register a custom/missing pi model via a generated extension (OpenAI-compatible endpoint)",
    helpAfter: MODEL_ADD_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "pi", action: "model_add", risk: "medium" })
  @Returns(piModelAddReturnSchema)
  add(
    @Option({ flags: "--provider-id <id>", description: "New pi provider id, kebab-case (e.g. zai-glm)" })
    providerId?: string,
    @Option({ flags: "--model-id <id>", description: "Model id at the endpoint (e.g. glm-5.2)" }) modelId?: string,
    @Option({ flags: "--base-url <url>", description: "Provider base URL (OpenAI-compatible)" }) baseUrl?: string,
    @Option({ flags: "--api-key-env <VAR>", description: "NAME of the env var holding the API key (never the secret)" })
    apiKeyEnv?: string,
    @Option({
      flags: "--api <type>",
      description: "openai-completions|openai-responses|anthropic-messages (default: openai-completions)",
      defaultValue: "openai-completions",
    })
    api?: string,
    @Option({ flags: "--name <label>", description: "Human display name (default: provider-id)" }) name?: string,
    @Option({
      flags: "--context-window <n>",
      description: "Context window tokens (default: 128000)",
      defaultValue: "128000",
    })
    contextWindow?: string,
    @Option({ flags: "--max-tokens <n>", description: "Max output tokens", defaultValue: "8192" })
    maxTokens?: string,
    @Option({ flags: "--reasoning", description: "Model supports reasoning/thinking" }) reasoning?: boolean,
    @Option({
      flags: "--input <modalities>",
      description: "Comma-separated: text,image (default: text)",
      defaultValue: "text",
    })
    input?: string,
    @Option({ flags: "--force", description: "Overwrite an existing managed extension with the same provider-id" })
    force?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!providerId) fail("Missing --provider-id (e.g. --provider-id zai-glm)");
    if (!modelId) fail("Missing --model-id (e.g. --model-id glm-5.2)");
    if (!baseUrl) fail("Missing --base-url (the OpenAI-compatible endpoint)");
    if (!apiKeyEnv) fail("Missing --api-key-env (NAME of the env var, e.g. ZAI_API_KEY — not the secret)");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(providerId!))
      fail(`Invalid --provider-id "${providerId}": use kebab-case [a-z0-9-]`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv!))
      fail(`Invalid --api-key-env "${apiKeyEnv}": expected an ENV VAR NAME like ZAI_API_KEY, not a secret value`);

    if (!existsSync(extensionsDir())) mkdirSync(extensionsDir(), { recursive: true });
    const extPath = join(extensionsDir(), `${providerId}.ts`);
    if (existsSync(extPath)) {
      const current = readFileSync(extPath, "utf-8");
      if (!current.includes(EXTENSION_MARKER)) {
        fail(`${extPath} exists and is not managed by ravi pi. Pick a different --provider-id or remove it manually.`);
      }
      if (!force) fail(`${extPath} already exists. Re-run with --force to overwrite.`);
    }

    const inputArr = (input ?? "text")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const source = buildProviderExtensionSource({
      providerId: providerId!,
      modelId: modelId!,
      baseUrl: baseUrl!,
      apiKeyEnv: apiKeyEnv!,
      api: api ?? "openai-completions",
      label: name ?? providerId!,
      reasoning: Boolean(reasoning),
      input: inputArr,
      contextWindow: Number(contextWindow ?? 128000) || 128000,
      maxTokens: Number(maxTokens ?? 8192) || 8192,
    });
    writeFileSync(extPath, source, "utf-8");

    // did it actually become resolvable? (auth present + extension valid)
    let resolvesNow = false;
    try {
      resolvesNow = listModelRows().some((r) => r.model === modelId || r.provider === providerId);
    } catch {
      resolvesNow = false;
    }

    const payload = {
      providerId: providerId!,
      modelId: modelId!,
      extensionPath: extPath,
      created: true,
      resolvesNow,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(`✅ wrote ${extPath}`);
      console.log(
        resolvesNow
          ? `✅ ${modelId} resolves now. Point an agent: ravi agents set <id> provider pi model ${modelId}`
          : `⚠️  ${modelId} does not resolve yet — check auth: ravi pi auth check --provider ${providerId} (need env ${apiKeyEnv})`,
      );
    }
    return payload;
  }

  @Command({
    name: "remove",
    description: "Remove a custom pi provider/model extension created by this CLI",
    helpAfter: MODEL_REMOVE_HELP,
  })
  @CommandAccess({ kind: "mutate", resource: "pi", action: "model_remove", risk: "medium" })
  @Returns(piModelRemoveReturnSchema)
  remove(
    @Option({ flags: "--provider-id <id>", description: "Provider id of the extension to remove" }) providerId?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!providerId) fail("Missing --provider-id");
    const extPath = join(extensionsDir(), `${providerId}.ts`);
    if (!existsSync(extPath)) fail(`No extension at ${extPath}. List managed: ravi pi status`);
    if (!readFileSync(extPath, "utf-8").includes(EXTENSION_MARKER)) {
      fail(`${extPath} is not managed by ravi pi — remove it manually if it is yours.`);
    }
    rmSync(extPath);
    const payload = { providerId: providerId!, extensionPath: extPath, removed: true };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else console.log(`✅ removed ${extPath}`);
    return payload;
  }
}

@Group({ name: "pi.providers", description: "List providers the pi provider knows about", scope: "admin" })
export class PiProvidersCommands {
  @Command({
    name: "list",
    description: "List pi providers and whether they are authenticated in this environment",
    helpAfter: PROVIDERS_LIST_HELP,
  })
  @CommandAccess({ kind: "read", resource: "pi", action: "providers_list", risk: "low" })
  @Returns(piProvidersListReturnSchema)
  list(
    @Option({ flags: "--limit <n>", description: "Page size (default: 50, max: 500)" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Rows to skip (default: 0)" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const authed = new Set(authenticatedProviderKeys());
    const counts = new Map<string, number>();
    for (const r of listModelRows()) counts.set(r.provider, (counts.get(r.provider) ?? 0) + 1);
    // union of providers with models and providers with auth
    const providerIds = new Set<string>([...counts.keys(), ...authed]);
    const all = [...providerIds].sort().map((provider) => ({
      provider,
      authenticated: authed.has(provider),
      modelCount: counts.get(provider) ?? 0,
    }));

    const parsedLimit = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 500);
    const parsedOffset = Math.max(Number(offset ?? 0) || 0, 0);
    const page = all.slice(parsedOffset, parsedOffset + parsedLimit);
    const pagination = buildCliOffsetPagination({
      baseCommand: ["ravi", "pi", "providers", "list"],
      limit: parsedLimit,
      offset: parsedOffset,
      returned: page.length,
      total: all.length,
      options: [],
    });
    const payload = { total: all.length, pagination, items: page };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else for (const p of page) console.log(`${p.authenticated ? "✅" : "  "} ${p.provider}\t(${p.modelCount} models)`);
    return payload;
  }
}

@Group({ name: "pi.auth", description: "Check pi provider authentication without exposing secrets", scope: "admin" })
export class PiAuthCommands {
  @Command({
    name: "check",
    description: "Check whether a pi provider is authenticated (never prints the secret)",
    helpAfter: AUTH_CHECK_HELP,
  })
  @CommandAccess({ kind: "read", resource: "pi", action: "auth_check", risk: "low" })
  @Returns(piAuthCheckReturnSchema)
  check(
    @Option({ flags: "--provider <name>", description: "Provider id (e.g. zai, google, openai)" }) provider?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    if (!provider) fail("Missing --provider (e.g. --provider zai)");
    const inAuthFile = authenticatedProviderKeys().includes(provider!);
    const envVar = PROVIDER_ENV_VARS[provider!] ?? null;
    const inEnv = Boolean(envVar && process.env[envVar]?.trim());
    const source = inAuthFile ? "auth.json" : inEnv ? "env" : "none";
    const payload = {
      provider: provider!,
      authenticated: inAuthFile || inEnv,
      source: source as "auth.json" | "env" | "none",
      envVar,
    };
    if (asJson) console.log(JSON.stringify(payload, null, 2));
    else {
      console.log(
        payload.authenticated ? `✅ ${provider} authenticated (${source})` : `❌ ${provider} not authenticated`,
      );
      if (!payload.authenticated && envVar) console.log(`   set env ${envVar}=... or run \`pi\` then /login`);
    }
    return payload;
  }
}
