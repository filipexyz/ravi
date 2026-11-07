import { constants, mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { bridgeStateDir } from "./store.js";
import { getRaviStateDir } from "../utils/paths.js";
import { z } from "zod";
import { TOML } from "bun";

const providerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,40}$/),
    baseUrl: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
      }),
    apiKeyFile: z.string().startsWith("/"),
  })
  .strict();

function privateFile(path: string) {
  if (!path.startsWith("/")) throw new Error("Bridge provider file must be absolute");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077) !== 0)
      throw new Error("Invalid private bridge provider file");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Explicit local model credential only; never enroll the SSH account with model authority. */
export function prepareBridgeCodexProfile(cwd: string) {
  const id = basename(cwd);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid bridge workspace");
  const configDir = join(bridgeStateDir(), "providers", id);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = {
    CODEX_HOME: configDir,
    RAVI_BRIDGE_TURN: "1",
    RAVI_STATE_DIR: getRaviStateDir(),
  };
  const providerFile = process.env.RAVI_BRIDGE_CODEX_PROVIDER_FILE;
  if (providerFile) {
    // Provider selection is installation configuration, not an action permission policy.
    const provider = providerSchema.parse(JSON.parse(privateFile(providerFile)));
    const apiKey = privateFile(provider.apiKeyFile).trim();
    if (!/^[\x21-\x7e]{10,4096}$/.test(apiKey)) throw new Error("Invalid bridge provider credential");
    const configPath = join(configDir, "config.toml");
    if (!existsSync(configPath)) {
      writeFileSync(
        configPath,
        [
          `model_provider = ${JSON.stringify(provider.id)}`,
          'web_search = "disabled"',
          `[model_providers.${provider.id}]`,
          `name = ${JSON.stringify(provider.id)}`,
          `base_url = ${JSON.stringify(provider.baseUrl)}`,
          'wire_api = "responses"',
          "requires_openai_auth = false",
          'env_key = "BRIDGE_MODEL_API_KEY"',
          "",
        ].join("\n"),
        { mode: 0o600, flag: "wx" },
      );
    } else {
      const config = TOML.parse(privateFile(configPath)) as Record<string, any>;
      const configured = config.model_providers?.[provider.id];
      if (
        config.model_provider !== provider.id ||
        configured?.base_url !== provider.baseUrl ||
        configured?.wire_api !== "responses" ||
        configured?.env_key !== "BRIDGE_MODEL_API_KEY" ||
        configured?.requires_openai_auth !== false
      )
        throw new Error("Bridge provider changed; create a new conversation");
    }
    // Deliberately outside RAVI_*: Codex's shell include_only excludes this credential.
    env.BRIDGE_MODEL_API_KEY = apiKey;
    return { configDir, env };
  }
  const authPath = join(configDir, "auth.json");
  if (!existsSync(authPath)) {
    const source = process.env.RAVI_BRIDGE_CODEX_AUTH_FILE;
    if (!source?.startsWith("/")) throw new Error("Configure the test installation's Codex authentication file");
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077) !== 0)
        throw new Error("Invalid Codex authentication file");
      const contents = readFileSync(fd, "utf8");
      JSON.parse(contents);
      writeFileSync(authPath, contents, { mode: 0o600, flag: "wx" });
    } finally {
      closeSync(fd);
    }
  }
  return { configDir, env };
}
