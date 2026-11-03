// The `cloud` block of a Library agent's `agent.json` (D4). Pure: the Library
// publish path and the compiler validate with the same function, so a version
// that publishes always compiles its block.

import { CronError, isValidTimezone, parseCron } from "./cron";

export const CLOUD_BUDGET_MIN_USD = 0.5;
export const CLOUD_BUDGET_MAX_USD = 200;
export const CLOUD_BUDGET_DEFAULT_USD = 5;
export const CLOUD_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

const MAX_ALLOWED_HOSTS = 64;
const MAX_PACKAGES = 50;
const MAX_MCP_SERVERS = 10;
const MAX_REPOSITORIES = 10;

export type CloudEffort = (typeof CLOUD_EFFORTS)[number];
export type CloudNetworking = "limited" | "unrestricted";
export type CloudWrites = "ask" | "auto";

export type CloudBlock = {
  model: string | null;
  effort: CloudEffort | null;
  budgetUsd: number;
  environment: {
    networking: CloudNetworking;
    allowedHosts: string[];
    packages: { apt: string[]; pip: string[]; npm: string[] };
  };
  mcp: { ravi: boolean; servers: { name: string; url: string }[] };
  tools: { webSearch: boolean; writes: CloudWrites };
  repositories: CloudRepository[];
  schedule: { cron: string; timezone: string } | null;
};

export type CloudRepository = { repo: string; branch: string | null };

export class CloudDefinitionError extends Error {}

const KEYS: Record<string, readonly string[]> = {
  "": ["model", "effort", "budgetUsd", "environment", "mcp", "tools", "repositories", "schedule"],
  environment: ["networking", "allowedHosts", "packages"],
  "environment.packages": ["apt", "pip", "npm"],
  mcp: ["ravi", "servers"],
  "mcp.servers[]": ["name", "url"],
  tools: ["webSearch", "writes"],
  "repositories[]": ["repo", "branch"],
  schedule: ["cron", "timezone"],
};

const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|authorization|cookie|credential/i;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PACKAGE_PATTERN = /^[A-Za-z0-9@][A-Za-z0-9@._/+=<>~^:-]{0,213}$/;
const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_PATTERN = /^(?!\/|.*\/\/|.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

export function defaultCloudBlock(): CloudBlock {
  return {
    model: null,
    effort: null,
    budgetUsd: CLOUD_BUDGET_DEFAULT_USD,
    environment: { networking: "limited", allowedHosts: [], packages: { apt: [], pip: [], npm: [] } },
    mcp: { ravi: true, servers: [] },
    tools: { webSearch: false, writes: "ask" },
    repositories: [],
    schedule: null,
  };
}

/**
 * Validates the block and fills its defaults. Throws `CloudDefinitionError`
 * with a message meant for the person who wrote `agent.json`.
 */
export function parseCloudBlock(raw: unknown): CloudBlock {
  const block = defaultCloudBlock();
  if (raw === undefined || raw === null) return block;
  const root = object(raw, "cloud");
  scanForCredentials(root, "cloud");
  checkKeys(root, "", "cloud");

  if (root.model !== undefined && root.model !== null) {
    if (typeof root.model !== "string" || !MODEL_PATTERN.test(root.model)) fail("cloud.model is not a valid model name.");
    block.model = root.model;
  }
  if (root.effort !== undefined && root.effort !== null) {
    if (!CLOUD_EFFORTS.includes(root.effort as CloudEffort)) fail(`cloud.effort is one of ${CLOUD_EFFORTS.join(", ")}.`);
    block.effort = root.effort as CloudEffort;
  }
  if (root.budgetUsd !== undefined && root.budgetUsd !== null) block.budgetUsd = parseBudgetUsd(root.budgetUsd, "cloud.budgetUsd");

  if (root.environment !== undefined) {
    const environment = object(root.environment, "cloud.environment");
    checkKeys(environment, "environment", "cloud.environment");
    if (environment.networking !== undefined) {
      if (environment.networking !== "limited" && environment.networking !== "unrestricted") {
        fail("cloud.environment.networking is limited or unrestricted.");
      }
      block.environment.networking = environment.networking;
    }
    block.environment.allowedHosts = stringList(environment.allowedHosts, "cloud.environment.allowedHosts", MAX_ALLOWED_HOSTS, (host) =>
      HOST_PATTERN.test(host),
    );
    if (environment.packages !== undefined) {
      const packages = object(environment.packages, "cloud.environment.packages");
      checkKeys(packages, "environment.packages", "cloud.environment.packages");
      for (const manager of ["apt", "pip", "npm"] as const) {
        block.environment.packages[manager] = stringList(packages[manager], `cloud.environment.packages.${manager}`, MAX_PACKAGES, (name) =>
          PACKAGE_PATTERN.test(name),
        );
      }
    }
  }

  if (root.mcp !== undefined) {
    const mcp = object(root.mcp, "cloud.mcp");
    checkKeys(mcp, "mcp", "cloud.mcp");
    if (mcp.ravi !== undefined) block.mcp.ravi = boolean(mcp.ravi, "cloud.mcp.ravi");
    if (mcp.servers !== undefined) {
      if (!Array.isArray(mcp.servers) || mcp.servers.length > MAX_MCP_SERVERS) {
        fail(`cloud.mcp.servers is a list of at most ${MAX_MCP_SERVERS} servers.`);
      }
      const names = new Set<string>();
      for (const [index, entry] of mcp.servers.entries()) {
        const label = `cloud.mcp.servers[${index}]`;
        const server = object(entry, label);
        checkKeys(server, "mcp.servers[]", label);
        if (typeof server.name !== "string" || !MCP_NAME_PATTERN.test(server.name)) fail(`${label}.name is lowercase letters, digits, - and _.`);
        if (server.name === "ravi") fail(`${label}.name: ravi is the Console MCP; use cloud.mcp.ravi.`);
        if (names.has(server.name)) fail(`${label}.name ${server.name} is repeated.`);
        names.add(server.name);
        block.mcp.servers.push({ name: server.name, url: safeUrl(server.url, `${label}.url`) });
      }
    }
  }

  if (root.tools !== undefined) {
    const tools = object(root.tools, "cloud.tools");
    checkKeys(tools, "tools", "cloud.tools");
    if (tools.webSearch !== undefined) block.tools.webSearch = boolean(tools.webSearch, "cloud.tools.webSearch");
    if (tools.writes !== undefined) {
      if (tools.writes !== "ask" && tools.writes !== "auto") fail("cloud.tools.writes is ask or auto.");
      block.tools.writes = tools.writes;
    }
  }

  if (root.repositories !== undefined) block.repositories = parseRepositories(root.repositories, "cloud.repositories");

  if (root.schedule !== undefined && root.schedule !== null) {
    const schedule = object(root.schedule, "cloud.schedule");
    checkKeys(schedule, "schedule", "cloud.schedule");
    block.schedule = parseSchedule(schedule.cron, schedule.timezone, "cloud.schedule");
  }
  return block;
}

export function parseBudgetUsd(raw: unknown, label = "budgetUsd"): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < CLOUD_BUDGET_MIN_USD || raw > CLOUD_BUDGET_MAX_USD) {
    fail(`${label} is a number from ${CLOUD_BUDGET_MIN_USD} to ${CLOUD_BUDGET_MAX_USD} (US$).`);
  }
  return Math.round(raw * 100) / 100;
}

export function parseRepositories(raw: unknown, label = "repositories"): CloudRepository[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_REPOSITORIES) fail(`${label} is a list of at most ${MAX_REPOSITORIES} repositories.`);
  const seen = new Set<string>();
  const repositories: CloudRepository[] = [];
  for (const [index, entry] of raw.entries()) {
    const itemLabel = `${label}[${index}]`;
    const repository = typeof entry === "string" ? { repo: entry } : object(entry, itemLabel);
    if (typeof entry !== "string") {
      scanForCredentials(repository, itemLabel);
      checkKeys(repository, "repositories[]", itemLabel);
    }
    if (typeof repository.repo !== "string" || !REPO_PATTERN.test(repository.repo)) fail(`${itemLabel}.repo is owner/name.`);
    const branch = repository.branch;
    if (branch !== undefined && branch !== null && (typeof branch !== "string" || !BRANCH_PATTERN.test(branch))) {
      fail(`${itemLabel}.branch is not a valid branch name.`);
    }
    const key = repository.repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repositories.push({ repo: repository.repo, branch: typeof branch === "string" ? branch : null });
  }
  return repositories;
}

export function parseSchedule(cron: unknown, timezone: unknown, label = "schedule") {
  if (typeof cron !== "string" || cron.length > 120) fail(`${label}.cron is a 5-field cron expression.`);
  try {
    parseCron(cron);
  } catch (error) {
    fail(`${label}.cron: ${error instanceof CronError ? error.message : "invalid expression."}`);
  }
  if (typeof timezone !== "string" || !isValidTimezone(timezone)) fail(`${label}.timezone is an IANA timezone such as America/Sao_Paulo.`);
  return { cron: cron.trim().split(/\s+/).join(" "), timezone };
}

function scanForCredentials(value: unknown, label: string) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForCredentials(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) fail(`${label}.${key}: agent.json carries no credentials; cloud agents get Ravi tools from the run token.`);
    scanForCredentials(child, `${label}.${key}`);
  }
}

function checkKeys(record: Record<string, unknown>, path: string, label: string) {
  const allowed = KEYS[path] ?? [];
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`${label} takes only ${allowed.join(", ")}; remove ${unknown.slice(0, 5).join(", ")}.`);
}

function safeUrl(raw: unknown, label: string) {
  if (typeof raw !== "string" || raw.length > 2048) fail(`${label} is an https URL.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} is an https URL.`);
  }
  if (url.protocol !== "https:") fail(`${label} is an https URL.`);
  if (url.username || url.password) fail(`${label} carries no credentials (no user:password@).`);
  if (url.search || raw.includes("?")) fail(`${label} carries no query string; credentials do not go in URLs.`);
  if (url.hash || raw.includes("#")) fail(`${label} carries no fragment.`);
  return url.toString();
}

function stringList(raw: unknown, label: string, max: number, valid: (value: string) => boolean) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max) fail(`${label} is a list of at most ${max} entries.`);
  const values: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !valid(value)) fail(`${label}: ${JSON.stringify(String(value).slice(0, 80))} is not valid.`);
    if (!values.includes(value)) values.push(value);
  }
  return values;
}

function object(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} must be a JSON object.`);
  return raw as Record<string, unknown>;
}

function boolean(raw: unknown, label: string) {
  if (typeof raw !== "boolean") fail(`${label} is true or false.`);
  return raw;
}

function fail(message: string): never {
  throw new CloudDefinitionError(message);
}
