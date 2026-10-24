/**
 * The `cloud` block of a Library agent's `agent.json` (spec `cloud/agents`).
 * The Console validates it again with the same rules when it compiles the
 * agent; this side refuses a bad block before anything is published.
 *
 * Every key is optional. The block never carries credentials, routes or
 * contacts: a key that looks like a secret (token, secret, password, apikey,
 * authorization, cookie, credential) is refused anywhere in it, and so is a
 * URL with userinfo or a query string. `secrets` only names Console secrets
 * (their values stay in the Console).
 *
 * The product fields (packages for cargo, gem and go, placement, webFetch, web
 * filters, office, askHuman, workflows, secrets, memory, outcome,
 * monthlyCapUsd, provider) follow the Console's `definition.ts` rules exactly.
 */

export const CLOUD_AGENT_DEFINITION_INVALID = "CLOUD_AGENT_DEFINITION_INVALID";

export const CLOUD_MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;
export const CLOUD_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const CLOUD_NETWORKING = ["limited", "unrestricted"] as const;
export const CLOUD_WRITES = ["ask", "auto"] as const;
export const CLOUD_BUDGET_MIN_USD = 0.5;
export const CLOUD_BUDGET_MAX_USD = 200;
export const CLOUD_BUDGET_DEFAULT_USD = 5;
export const CLOUD_PACKAGE_MANAGERS = ["apt", "pip", "npm", "cargo", "gem", "go"] as const;
export const CLOUD_PLACEMENTS = ["cloud", "installation"] as const;
export const CLOUD_OFFICE_SKILLS = ["xlsx", "docx", "pptx", "pdf"] as const;
export const CLOUD_MEMORY_SCOPES = ["agent", "person"] as const;
export const CLOUD_PROVIDERS = ["anthropic", "ravi"] as const;
export const CLOUD_OUTCOME_MAX_ITERATIONS = 5;
export const CLOUD_OUTCOME_RUBRIC_MAX_CHARS = 8000;
export const CLOUD_MONTHLY_CAP_MAX_USD = 100_000;
/** A Console secret name: what `cloud.secrets` lists and `ravi cloud secrets set` takes. */
export const CLOUD_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

const MAX_HOSTS = 25;
const MAX_PACKAGES = 50;
const MAX_MCP_SERVERS = 10;
const MAX_REPOSITORIES = 10;
const MAX_WEB_DOMAINS = 50;
const MAX_SECRETS = 20;
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|cookie|credential)/i;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PACKAGE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/+=<>~^:-]{0,213}$/;
const MCP_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const CRON_FIELD = /^[0-9*/,\-A-Za-z?LW#]+$/;
const TIMEZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$|^UTC$/;
const WEB_DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[A-Za-z0-9._~%/-]{0,200})?$/;

type CloudPackageManager = (typeof CLOUD_PACKAGE_MANAGERS)[number];

export interface CloudAgentBlock {
  model?: string;
  effort?: (typeof CLOUD_EFFORTS)[number];
  budgetUsd?: number;
  environment?: {
    networking?: (typeof CLOUD_NETWORKING)[number];
    allowedHosts?: string[];
    packages?: Partial<Record<CloudPackageManager, string[]>>;
    /** `cloud`: the provider's container. `installation`: a Ravi daemon runs the tools. */
    placement?: (typeof CLOUD_PLACEMENTS)[number];
  };
  mcp?: { ravi?: boolean; servers?: Array<{ name: string; url: string }> };
  tools?: {
    webSearch?: boolean;
    /** Defaults to webSearch. */
    webFetch?: boolean;
    /** At most one list is non-empty. */
    web?: { allowedDomains?: string[]; blockedDomains?: string[] };
    writes?: (typeof CLOUD_WRITES)[number];
    /** Anthropic's prebuilt Office and PDF skills; `true` in agent.json means all four. */
    office?: Array<(typeof CLOUD_OFFICE_SKILLS)[number]>;
    askHuman?: boolean;
    workflows?: boolean;
  };
  repositories?: Array<{ repo: string; branch?: string }>;
  schedule?: { cron: string; timezone?: string };
  /** Names of Console secrets the run may use at egress. */
  secrets?: string[];
  memory?: (typeof CLOUD_MEMORY_SCOPES)[number] | null;
  outcome?: { rubric: string; maxIterations: number } | null;
  monthlyCapUsd?: number | null;
  provider?: (typeof CLOUD_PROVIDERS)[number];
}

export interface CloudBlockIssue {
  path: Array<string | number>;
  code: string;
  message: string;
}

export type CloudBlockValidation = { ok: true; cloud: CloudAgentBlock } | { ok: false; issues: CloudBlockIssue[] };

/** A model the cloud accepts: an alias (`opus`, `sonnet`, `haiku`) or a `claude-*` id. */
export function isCloudModel(value: string): boolean {
  const model = value.trim().toLowerCase();
  return (CLOUD_MODEL_ALIASES as readonly string[]).includes(model) || /^claude-[a-z0-9.-]{1,80}$/.test(model);
}

export function isCloudBudget(value: number): boolean {
  return Number.isFinite(value) && value >= CLOUD_BUDGET_MIN_USD && value <= CLOUD_BUDGET_MAX_USD;
}

export function isCloudRepository(value: string): boolean {
  return REPO.test(value);
}

/** Five cron fields (minute hour day month weekday). */
export function isCloudCron(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field));
}

export function isCloudTimezone(value: string): boolean {
  if (!TIMEZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a `cloud` block. Returns the block normalized (trimmed strings,
 * lowercase aliases, only known keys) or every issue found.
 */
export function validateCloudBlock(value: unknown): CloudBlockValidation {
  const issues: CloudBlockIssue[] = [];
  const add = (path: Array<string | number>, message: string, code = "invalid") =>
    issues.push({ path: ["cloud", ...path], code, message });

  const root = record(value);
  if (!root) {
    add([], "The cloud block must be a JSON object.");
    return { ok: false, issues };
  }
  scanSecrets(root, [], add);

  const cloud: CloudAgentBlock = {};
  unknownKeys(
    root,
    [
      "model",
      "effort",
      "budgetUsd",
      "environment",
      "mcp",
      "tools",
      "repositories",
      "schedule",
      "secrets",
      "memory",
      "outcome",
      "monthlyCapUsd",
      "provider",
    ],
    [],
    add,
  );

  if (root.model !== undefined) {
    if (typeof root.model !== "string" || !isCloudModel(root.model)) {
      add(["model"], "model must be opus, sonnet, haiku or a claude-* model id.");
    } else {
      cloud.model = root.model.trim().toLowerCase();
    }
  }
  if (root.effort !== undefined) {
    if (typeof root.effort !== "string" || !(CLOUD_EFFORTS as readonly string[]).includes(root.effort)) {
      add(["effort"], `effort must be one of ${CLOUD_EFFORTS.join(", ")}.`);
    } else {
      cloud.effort = root.effort as CloudAgentBlock["effort"];
    }
  }
  if (root.budgetUsd !== undefined) {
    if (typeof root.budgetUsd !== "number" || !isCloudBudget(root.budgetUsd)) {
      add(["budgetUsd"], `budgetUsd must be a number from ${CLOUD_BUDGET_MIN_USD} to ${CLOUD_BUDGET_MAX_USD}.`);
    } else {
      cloud.budgetUsd = root.budgetUsd;
    }
  }

  if (root.environment !== undefined) {
    const environment = record(root.environment);
    if (!environment) {
      add(["environment"], "environment must be an object.");
    } else {
      const out: NonNullable<CloudAgentBlock["environment"]> = {};
      unknownKeys(environment, ["networking", "allowedHosts", "packages", "placement"], ["environment"], add);
      if (environment.networking !== undefined) {
        if (
          typeof environment.networking !== "string" ||
          !(CLOUD_NETWORKING as readonly string[]).includes(environment.networking)
        ) {
          add(["environment", "networking"], `networking must be one of ${CLOUD_NETWORKING.join(", ")}.`);
        } else {
          out.networking = environment.networking as (typeof CLOUD_NETWORKING)[number];
        }
      }
      if (environment.allowedHosts !== undefined) {
        const hosts = stringList(environment.allowedHosts, MAX_HOSTS, ["environment", "allowedHosts"], add);
        if (hosts) {
          hosts.forEach((host, index) => {
            if (!HOSTNAME.test(host)) {
              add(
                ["environment", "allowedHosts", index],
                "Each allowed host is a bare hostname (no scheme, port or wildcard).",
              );
            }
          });
          out.allowedHosts = hosts.map((host) => host.toLowerCase());
        }
      }
      if (environment.packages !== undefined) {
        const packages = record(environment.packages);
        if (!packages) {
          add(
            ["environment", "packages"],
            `packages must be an object with ${CLOUD_PACKAGE_MANAGERS.join(", ")} lists.`,
          );
        } else {
          unknownKeys(packages, CLOUD_PACKAGE_MANAGERS, ["environment", "packages"], add);
          const outPackages: NonNullable<NonNullable<CloudAgentBlock["environment"]>["packages"]> = {};
          for (const manager of CLOUD_PACKAGE_MANAGERS) {
            if (packages[manager] === undefined) continue;
            const names = stringList(packages[manager], MAX_PACKAGES, ["environment", "packages", manager], add);
            if (!names) continue;
            names.forEach((name, index) => {
              if (!PACKAGE_NAME.test(name)) {
                add(["environment", "packages", manager, index], "Not a package name.");
              }
            });
            outPackages[manager] = names;
          }
          out.packages = outPackages;
        }
      }
      if (environment.placement !== undefined) {
        if (!(CLOUD_PLACEMENTS as readonly unknown[]).includes(environment.placement)) {
          add(["environment", "placement"], "placement must be cloud or installation.");
        } else {
          out.placement = environment.placement as (typeof CLOUD_PLACEMENTS)[number];
        }
      }
      cloud.environment = out;
    }
  }

  if (root.mcp !== undefined) {
    const mcp = record(root.mcp);
    if (!mcp) {
      add(["mcp"], "mcp must be an object.");
    } else {
      unknownKeys(mcp, ["ravi", "servers"], ["mcp"], add);
      const out: NonNullable<CloudAgentBlock["mcp"]> = {};
      if (mcp.ravi !== undefined) {
        if (typeof mcp.ravi !== "boolean") add(["mcp", "ravi"], "mcp.ravi must be true or false.");
        else out.ravi = mcp.ravi;
      }
      if (mcp.servers !== undefined) {
        if (!Array.isArray(mcp.servers) || mcp.servers.length > MAX_MCP_SERVERS) {
          add(["mcp", "servers"], `mcp.servers must be a list of at most ${MAX_MCP_SERVERS} servers.`);
        } else {
          const servers: Array<{ name: string; url: string }> = [];
          const names = new Set<string>();
          mcp.servers.forEach((entry, index) => {
            const server = record(entry);
            if (!server) {
              add(["mcp", "servers", index], "Each server is an object with name and url.");
              return;
            }
            unknownKeys(server, ["name", "url"], ["mcp", "servers", index], add);
            const name = typeof server.name === "string" ? server.name.trim() : "";
            const url = typeof server.url === "string" ? server.url.trim() : "";
            if (!MCP_NAME.test(name) || name === "ravi") {
              add(["mcp", "servers", index, "name"], "name is 1-64 characters of a-z, 0-9, _ and - (not ravi).");
            } else if (names.has(name)) {
              add(["mcp", "servers", index, "name"], `Server name '${name}' is repeated.`);
            }
            names.add(name);
            const urlIssue = mcpUrlIssue(url);
            if (urlIssue) add(["mcp", "servers", index, "url"], urlIssue);
            servers.push({ name, url });
          });
          out.servers = servers;
        }
      }
      cloud.mcp = out;
    }
  }

  if (root.tools !== undefined) {
    const tools = record(root.tools);
    if (!tools) {
      add(["tools"], "tools must be an object.");
    } else {
      unknownKeys(tools, ["webSearch", "webFetch", "web", "writes", "office", "askHuman", "workflows"], ["tools"], add);
      const out: NonNullable<CloudAgentBlock["tools"]> = {};
      for (const flag of ["webSearch", "webFetch", "askHuman", "workflows"] as const) {
        const value = tools[flag];
        if (value === undefined) continue;
        if (typeof value !== "boolean") add(["tools", flag], `tools.${flag} must be true or false.`);
        else out[flag] = value;
      }
      if (tools.web !== undefined) {
        const web = record(tools.web);
        if (!web) {
          add(["tools", "web"], "tools.web must be an object with allowedDomains or blockedDomains.");
        } else {
          unknownKeys(web, ["allowedDomains", "blockedDomains"], ["tools", "web"], add);
          const outWeb: NonNullable<NonNullable<CloudAgentBlock["tools"]>["web"]> = {};
          for (const list of ["allowedDomains", "blockedDomains"] as const) {
            if (web[list] === undefined || web[list] === null) continue;
            const domains = stringList(web[list], MAX_WEB_DOMAINS, ["tools", "web", list], add);
            if (!domains) continue;
            domains.forEach((domain, index) => {
              if (!WEB_DOMAIN.test(domain)) {
                add(["tools", "web", list, index], "Each entry is a lowercase domain (optionally *. and a path).");
              }
            });
            outWeb[list] = domains;
          }
          if ((outWeb.allowedDomains?.length ?? 0) > 0 && (outWeb.blockedDomains?.length ?? 0) > 0) {
            add(["tools", "web"], "tools.web takes allowedDomains or blockedDomains, not both.");
          }
          out.web = outWeb;
        }
      }
      if (tools.office !== undefined && tools.office !== null) {
        if (tools.office === true) {
          out.office = [...CLOUD_OFFICE_SKILLS];
        } else if (tools.office === false) {
          out.office = [];
        } else {
          const skills = stringList(tools.office, CLOUD_OFFICE_SKILLS.length, ["tools", "office"], add);
          if (skills) {
            skills.forEach((skill, index) => {
              if (!(CLOUD_OFFICE_SKILLS as readonly string[]).includes(skill)) {
                add(["tools", "office", index], `office lists ${CLOUD_OFFICE_SKILLS.join(", ")} (or is true).`);
              }
            });
            out.office = skills as Array<(typeof CLOUD_OFFICE_SKILLS)[number]>;
          }
        }
      }
      if (tools.writes !== undefined) {
        if (typeof tools.writes !== "string" || !(CLOUD_WRITES as readonly string[]).includes(tools.writes)) {
          add(["tools", "writes"], "tools.writes must be ask or auto.");
        } else {
          out.writes = tools.writes as (typeof CLOUD_WRITES)[number];
        }
      }
      cloud.tools = out;
    }
  }

  if (root.repositories !== undefined) {
    if (!Array.isArray(root.repositories) || root.repositories.length > MAX_REPOSITORIES) {
      add(["repositories"], `repositories must be a list of at most ${MAX_REPOSITORIES} entries.`);
    } else {
      const repositories: Array<{ repo: string; branch?: string }> = [];
      root.repositories.forEach((entry, index) => {
        const repository = record(entry);
        if (!repository) {
          add(["repositories", index], "Each repository is an object with repo and an optional branch.");
          return;
        }
        unknownKeys(repository, ["repo", "branch"], ["repositories", index], add);
        const repo = typeof repository.repo === "string" ? repository.repo.trim() : "";
        if (!isCloudRepository(repo)) add(["repositories", index, "repo"], "repo must be owner/name.");
        let branch: string | undefined;
        if (repository.branch !== undefined) {
          if (typeof repository.branch !== "string" || !BRANCH.test(repository.branch.trim())) {
            add(["repositories", index, "branch"], "branch must be a branch name.");
          } else {
            branch = repository.branch.trim();
          }
        }
        repositories.push({ repo, ...(branch ? { branch } : {}) });
      });
      cloud.repositories = repositories;
    }
  }

  if (root.schedule !== undefined) {
    const schedule = record(root.schedule);
    if (!schedule) {
      add(["schedule"], "schedule must be an object with cron and an optional timezone.");
    } else {
      unknownKeys(schedule, ["cron", "timezone"], ["schedule"], add);
      const cron = typeof schedule.cron === "string" ? schedule.cron.trim() : "";
      if (!isCloudCron(cron)) add(["schedule", "cron"], "cron must have five fields (minute hour day month weekday).");
      let timezone: string | undefined;
      if (schedule.timezone !== undefined) {
        if (typeof schedule.timezone !== "string" || !isCloudTimezone(schedule.timezone.trim())) {
          add(["schedule", "timezone"], "timezone must be an IANA time zone such as America/Sao_Paulo.");
        } else {
          timezone = schedule.timezone.trim();
        }
      }
      cloud.schedule = { cron, ...(timezone ? { timezone } : {}) };
    }
  }

  if (root.secrets !== undefined && root.secrets !== null) {
    const names = stringList(root.secrets, MAX_SECRETS, ["secrets"], add);
    if (names) {
      names.forEach((name, index) => {
        if (!CLOUD_SECRET_NAME_PATTERN.test(name)) {
          add(["secrets", index], "Each secret is a name such as STRIPE_API_KEY (A-Z, 0-9 and _), never a value.");
        }
      });
      cloud.secrets = names;
    }
  }

  if (root.memory !== undefined) {
    if (root.memory !== null && !(CLOUD_MEMORY_SCOPES as readonly unknown[]).includes(root.memory)) {
      add(["memory"], "memory must be agent, person or null.");
    } else {
      cloud.memory = root.memory as CloudAgentBlock["memory"];
    }
  }

  if (root.outcome !== undefined) {
    if (root.outcome === null) {
      cloud.outcome = null;
    } else {
      const outcome = record(root.outcome);
      if (!outcome) {
        add(["outcome"], "outcome must be an object with rubric and an optional maxIterations.");
      } else {
        unknownKeys(outcome, ["rubric", "maxIterations"], ["outcome"], add);
        const rubric = typeof outcome.rubric === "string" ? outcome.rubric.trim() : "";
        if (!rubric || (outcome.rubric as string).length > CLOUD_OUTCOME_RUBRIC_MAX_CHARS) {
          add(
            ["outcome", "rubric"],
            `rubric is the text that says what a finished result looks like (at most ${CLOUD_OUTCOME_RUBRIC_MAX_CHARS} characters).`,
          );
        }
        let maxIterations = 3;
        if (outcome.maxIterations !== undefined) {
          const value = outcome.maxIterations;
          if (
            typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < 1 ||
            value > CLOUD_OUTCOME_MAX_ITERATIONS
          ) {
            add(
              ["outcome", "maxIterations"],
              `maxIterations is a whole number from 1 to ${CLOUD_OUTCOME_MAX_ITERATIONS}.`,
            );
          } else {
            maxIterations = value;
          }
        }
        cloud.outcome = { rubric, maxIterations };
      }
    }
  }

  if (root.monthlyCapUsd !== undefined) {
    const cap = root.monthlyCapUsd;
    if (cap === null) {
      cloud.monthlyCapUsd = null;
    } else if (typeof cap !== "number" || !Number.isFinite(cap) || cap <= 0 || cap > CLOUD_MONTHLY_CAP_MAX_USD) {
      add(["monthlyCapUsd"], `monthlyCapUsd is a number of US$ above 0 and at most ${CLOUD_MONTHLY_CAP_MAX_USD}.`);
    } else {
      cloud.monthlyCapUsd = Math.round(cap * 100) / 100;
    }
  }

  if (root.provider !== undefined && root.provider !== null) {
    if (!(CLOUD_PROVIDERS as readonly unknown[]).includes(root.provider)) {
      add(["provider"], "provider must be anthropic or ravi.");
    } else {
      cloud.provider = root.provider as (typeof CLOUD_PROVIDERS)[number];
    }
  }

  if (cloud.tools?.workflows === true && cloud.environment?.placement === "installation") {
    add(["tools", "workflows"], "Dynamic workflows run on the provider's containers; use placement cloud.");
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, cloud };
}

/** The `cloud` block of an `agent.json` text: `null` when the file has none, issues when it is invalid. */
export function readCloudBlockFromManifest(text: string | null): {
  cloud: CloudAgentBlock | null;
  issues: CloudBlockIssue[];
} {
  if (text === null) return { cloud: null, issues: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      cloud: null,
      issues: [{ path: ["agent.json"], code: "invalid_json", message: "agent.json is not JSON." }],
    };
  }
  const manifest = record(parsed);
  if (!manifest || manifest.cloud === undefined || manifest.cloud === null) return { cloud: null, issues: [] };
  const result = validateCloudBlock(manifest.cloud);
  return result.ok ? { cloud: result.cloud, issues: [] } : { cloud: null, issues: result.issues };
}

function mcpUrlIssue(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "url must be an https URL.";
  }
  if (url.protocol !== "https:") return "url must be an https URL.";
  if (url.username || url.password) return "url must not carry a user or password.";
  if (url.search || url.hash) return "url must not carry a query string or fragment.";
  return null;
}

/** Secret-looking keys anywhere, and URL-shaped strings with userinfo or a query, anywhere. */
function scanSecrets(
  value: unknown,
  path: Array<string | number>,
  add: (path: Array<string | number>, message: string, code?: string) => void,
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) scanSecrets(entry, [...path, index], add);
    return;
  }
  const object = record(value);
  if (object) {
    for (const [key, entry] of Object.entries(object)) {
      // The root `secrets` list names Console secrets (checked by name); it holds no values.
      if (path.length === 0 && key === "secrets") continue;
      if (SECRET_KEY.test(key)) {
        add([...path, key], "The cloud block never carries credentials.", "credential_refused");
        continue;
      }
      scanSecrets(entry, [...path, key], add);
    }
    return;
  }
  if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim())) {
    try {
      const url = new URL(value.trim());
      if (url.username || url.password || url.search) {
        add(path, "URLs in the cloud block carry no user, password or query string.", "credential_refused");
      }
    } catch {
      // Not a URL: the field's own check reports it.
    }
  }
}

function unknownKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  path: Array<string | number>,
  add: (path: Array<string | number>, message: string, code?: string) => void,
): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key) && !SECRET_KEY.test(key)) {
      add([...path, key], `Unknown key '${key.slice(0, 40)}'.`, "unknown_key");
    }
  }
}

function stringList(
  value: unknown,
  max: number,
  path: Array<string | number>,
  add: (path: Array<string | number>, message: string, code?: string) => void,
): string[] | null {
  if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== "string")) {
    add(path, `Must be a list of at most ${max} strings.`);
    return null;
  }
  return [...new Set(value.map((entry) => (entry as string).trim()).filter(Boolean))];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
