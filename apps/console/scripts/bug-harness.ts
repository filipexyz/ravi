#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONSOLE_URL = "https://console.ravi.bot";
const FIXTURE_DIR = join(import.meta.dir, "fixtures", "bug-reports");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CREATE_FIXTURES = ["minimal", "with-secrets", "duplicate"] as const;
const DEFAULT_CREATE_FIXTURE = "minimal";
const DEFAULT_TRIAGE_FIXTURE = "triage-sample";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type CreateFixtureName = (typeof CREATE_FIXTURES)[number];

type AppErrorOptions = {
  code: string;
  exitCode?: number;
  status?: number;
};

export class BugHarnessError extends Error {
  code: string;
  exitCode: number;
  status?: number;

  constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.name = "BugHarnessError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? 1;
    this.status = options.status;
  }
}

export type HarnessArgs = {
  command: string;
  json: boolean;
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
};

export type CreateAuth = {
  accessToken: string;
  source: "env" | "credentials";
};

const VALUE_FLAGS = [
  "--id",
  "--status",
  "--priority",
  "--note",
  "--status-note",
  "--duplicate",
  "--duplicate-of",
  "--surface",
  "--q",
  "--query",
  "--limit",
  "--offset",
  "--assignee",
  "--fixture",
  "--file",
] as const;

const BOOLEAN_FLAGS = ["--json", "--apply-priority", "--apply-status", "--apply-duplicate"] as const;

export function parseHarnessArgs(argv: string[]): HarnessArgs {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--json") {
      json = true;
      flags.add("json");
      continue;
    }
    if ((BOOLEAN_FLAGS as readonly string[]).includes(arg)) {
      flags.add(arg.slice(2));
      continue;
    }
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new BugHarnessError(`Missing value for ${arg}`, {
          code: "missing_option_value",
          exitCode: 2,
        });
      }
      const key = arg === "--q" ? "query" : arg === "--duplicate-of" ? "duplicate" : arg === "--status-note" ? "note" : arg.slice(2);
      options.set(key, value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new BugHarnessError(`Unknown option: ${arg}`, {
        code: "unknown_option",
        exitCode: 2,
      });
    }
    positionals.push(arg);
  }

  return {
    command: positionals[0] ?? "smoke",
    json,
    positionals: positionals.slice(1),
    options,
    flags,
  };
}

export function fixtureFileName(name: string) {
  return name.endsWith(".json") ? name : `${name}.json`;
}

export function resolveFixturePath(name: string) {
  return join(FIXTURE_DIR, fixtureFileName(name));
}

export function loadJsonFixture(name: string): JsonValue {
  const path = resolveFixturePath(name);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JsonValue;
  } catch {
    throw new BugHarnessError(`Failed to read fixture ${fixtureFileName(name)}`, {
      code: "fixture_missing",
      exitCode: 2,
    });
  }
}

export function resolveCreateFixtureName(raw: string | undefined): CreateFixtureName {
  const name = (raw ?? DEFAULT_CREATE_FIXTURE).replace(/\.json$/, "");
  if ((CREATE_FIXTURES as readonly string[]).includes(name)) {
    return name as CreateFixtureName;
  }
  throw new BugHarnessError(`Unknown create fixture: ${raw}. Use ${CREATE_FIXTURES.join(", ")}.`, {
    code: "unknown_fixture",
    exitCode: 2,
  });
}

export function resolveCreateAuth(
  env: Record<string, string | undefined> = process.env,
  home = process.env.HOME ?? "",
): CreateAuth | null {
  const envToken = env.RAVI_CONSOLE_ACCESS_TOKEN?.trim();
  if (envToken) return { accessToken: envToken, source: "env" };

  const credentialsPath = join(home, ".ravi", "cloud-auth", "credentials.json");
  try {
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf8")) as { accessToken?: unknown };
    if (typeof credentials.accessToken === "string" && credentials.accessToken.trim()) {
      return { accessToken: credentials.accessToken.trim(), source: "credentials" };
    }
  } catch {
    return null;
  }
  return null;
}

export function createSkipReason() {
  return "No RAVI_CONSOLE_ACCESS_TOKEN or ~/.ravi/cloud-auth/credentials.json accessToken. Create was skipped; admin-only steps still run against an existing --id.";
}

export function requiredId(args: HarnessArgs, extraPositional = 0) {
  const value = args.options.get("id") ?? args.positionals[extraPositional];
  if (!value?.trim()) {
    throw new BugHarnessError("Missing --id <uuid>", {
      code: "missing_id",
      exitCode: 2,
    });
  }
  const id = value.trim();
  if (!UUID_RE.test(id)) {
    throw new BugHarnessError("id must be a uuid", {
      code: "invalid_id",
      exitCode: 2,
    });
  }
  return id;
}

export function publicReportFields(value: unknown) {
  const record = asRecord(value);
  const result = asRecord(record.result);
  const source = Object.keys(result).length > 0 ? result : record;
  return {
    id: typeof source.id === "string" ? source.id : null,
    title: typeof source.title === "string" ? source.title : null,
    status: typeof source.status === "string" ? source.status : null,
    severity: typeof source.severity === "string" ? source.severity : null,
    priority: typeof source.priority === "string" || source.priority === null ? source.priority : null,
    surface: typeof source.surface === "string" || source.surface === null ? source.surface : null,
    consoleUrl: typeof source.consoleUrl === "string" ? source.consoleUrl : null,
    reporterUserId: typeof source.reporterUserId === "string" ? source.reporterUserId : null,
    priorityScore: typeof source.priorityScore === "number" || source.priorityScore === null ? source.priorityScore : null,
    duplicateOfId: typeof source.duplicateOfId === "string" || source.duplicateOfId === null ? source.duplicateOfId : null,
    lastTriageAt: typeof source.lastTriageAt === "number" || source.lastTriageAt === null ? source.lastTriageAt : null,
  };
}

export function assertSecretsRedacted(detail: unknown) {
  const record = asRecord(detail);
  const result = asRecord(record.result);
  const payload = asRecord(Object.keys(result).length > 0 ? result.payload : record.payload);
  const serialized = JSON.stringify(payload);
  const leaks = ["super-secret-value", "abcd1234secret", "sk-abcdefghijklmnopqrstuv", "nested-secret-value", "leakedvalue123"];
  for (const leak of leaks) {
    if (serialized.includes(leak)) {
      throw new BugHarnessError("Create sanitization did not redact fixture secrets.", {
        code: "secrets_not_redacted",
      });
    }
  }
  if (payload.password !== "[REDACTED]" || payload.token !== "[REDACTED]") {
    throw new BugHarnessError("Expected password and token fields to be [REDACTED].", {
      code: "secrets_not_redacted",
    });
  }
}

export function helpPayload() {
  return {
    ok: true,
    appId: "console/bug-harness",
    commands: [
      "smoke [--id uuid] [--fixture minimal|with-secrets|duplicate]",
      "create [--fixture minimal|with-secrets|duplicate]",
      "get --id <uuid>",
      "status --id <uuid> [--status triaging] [--note text] [--priority p0-p3] [--duplicate uuid]",
      "triage --id <uuid> [--fixture triage-sample]",
      "apply --id <uuid> [--apply-priority] [--apply-status] [--apply-duplicate] [--priority p0-p3]",
      "delete --id <uuid>",
      "list [--status] [--priority] [--surface] [--q text] [--limit n] [--offset n]",
      "help",
    ],
    notes: [
      "Reads RAVI_ADMIN_TOKEN and RAVI_CONSOLE_URL from env or .ravi.env.",
      "Create uses RAVI_CONSOLE_ACCESS_TOKEN or ~/.ravi/cloud-auth/credentials.json.",
      "Without user auth, smoke/create skip create and require --id for admin steps.",
      "Never prints bearer tokens.",
    ],
  };
}

function readLocalRaviEnvValue(name: string) {
  let text: string;
  try {
    text = readFileSync(join(import.meta.dir, "..", ".ravi.env"), "utf8");
  } catch {
    return null;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex).trim();
    if (key !== name) continue;
    return unquoteEnvValue(line.slice(separatorIndex + 1).trim());
  }

  return null;
}

function unquoteEnvValue(value: string) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function consoleBaseUrl() {
  return process.env.RAVI_CONSOLE_URL?.trim() || readLocalRaviEnvValue("RAVI_CONSOLE_URL")?.trim() || DEFAULT_CONSOLE_URL;
}

function readAdminToken() {
  const token = process.env.RAVI_ADMIN_TOKEN?.trim() || readLocalRaviEnvValue("RAVI_ADMIN_TOKEN")?.trim();
  if (!token) {
    throw new BugHarnessError("RAVI_ADMIN_TOKEN is not available in this environment.", {
      code: "admin_token_missing",
    });
  }
  return token;
}

async function adminRequest(method: "GET" | "POST" | "DELETE", path: string, body?: Record<string, JsonValue>) {
  const token = readAdminToken();
  const url = new URL(`/api/internal/admin/${path}`, consoleBaseUrl());
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-request-id": `bug-harness-admin-${Date.now()}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    throw new BugHarnessError(publicErrorMessage(payload, response.status), {
      code: publicErrorCode(payload),
      status: response.status,
    });
  }
  return payload;
}

async function adminGet(path: string) {
  return adminRequest("GET", path);
}

async function adminPost(path: string, body: Record<string, JsonValue>) {
  return adminRequest("POST", path, body);
}

async function adminDelete(path: string) {
  return adminRequest("DELETE", path);
}

async function cliRequest(method: "GET" | "POST", path: string, body?: Record<string, JsonValue>) {
  const auth = resolveCreateAuth();
  if (!auth) {
    throw new BugHarnessError(createSkipReason(), {
      code: "access_token_missing",
      exitCode: 2,
    });
  }
  const url = new URL(path, consoleBaseUrl());
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.accessToken}`,
    "x-request-id": `bug-harness-cli-${Date.now()}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = parseJson(text);
  if (!response.ok) {
    throw new BugHarnessError(publicErrorMessage(payload, response.status), {
      code: publicErrorCode(payload),
      status: response.status,
    });
  }
  return payload;
}

function listQuery(options: Map<string, string>) {
  const params = new URLSearchParams();
  for (const [key, queryKey] of [
    ["status", "status"],
    ["priority", "priority"],
    ["surface", "surface"],
    ["query", "q"],
    ["limit", "limit"],
    ["offset", "offset"],
    ["assignee", "assigneeUserId"],
  ] as const) {
    const value = options.get(key);
    if (value?.trim()) params.set(queryKey, value.trim());
  }
  const query = params.toString();
  return query ? `bugs?${query}` : "bugs";
}

function statusBody(args: HarnessArgs): Record<string, JsonValue> {
  const status = args.options.get("status") ?? args.positionals[1] ?? "triaging";
  const body: Record<string, JsonValue> = { status };
  const note = args.options.get("note");
  if (note) body.statusNote = note;
  const priority = args.options.get("priority");
  if (priority) body.priority = priority;
  const duplicate = args.options.get("duplicate");
  if (duplicate) body.duplicateOf = duplicate;
  const assignee = args.options.get("assignee");
  if (assignee) body.assigneeUserId = assignee;
  return body;
}

function applyBody(args: HarnessArgs): Record<string, JsonValue> {
  const applyPriority = args.flags.has("apply-priority");
  const applyStatus = args.flags.has("apply-status");
  const applyDuplicate = args.flags.has("apply-duplicate");
  const priority = args.options.get("priority");
  const status = args.options.get("status");
  const duplicate = args.options.get("duplicate");
  const explicit = applyPriority || applyStatus || applyDuplicate || Boolean(priority) || Boolean(status) || Boolean(duplicate);
  const body: Record<string, JsonValue> = {
    applyPriority: explicit ? applyPriority || Boolean(priority) : true,
    applyStatus: applyStatus || Boolean(status),
    applyDuplicate: applyDuplicate || Boolean(duplicate),
  };
  if (priority) body.priority = priority;
  if (status) body.status = status;
  if (duplicate) body.duplicateOf = duplicate;
  return body;
}

async function createFromFixture(name: CreateFixtureName) {
  const body = asRecord(loadJsonFixture(name));
  return cliRequest("POST", "/api/cli/bugs", body);
}

async function runSmoke(args: HarnessArgs) {
  const fixtureName = resolveCreateFixtureName(args.options.get("fixture"));
  const auth = resolveCreateAuth();
  const requestedId = args.options.get("id") ?? args.positionals[0];
  let id = requestedId?.trim() || null;
  let created: JsonValue | null = null;
  let createdFlag = false;
  let skippedCreate = false;
  let skipReason: string | null = null;

  if (auth && !id) {
    created = await createFromFixture(fixtureName);
    id = typeof asRecord(created).id === "string" ? String(asRecord(created).id) : null;
    createdFlag = true;
    if (!id) {
      throw new BugHarnessError("Create succeeded but returned no id.", {
        code: "create_missing_id",
      });
    }
  } else if (!auth) {
    skippedCreate = true;
    skipReason = createSkipReason();
    if (!id) {
      throw new BugHarnessError(skipReason, {
        code: "access_token_missing",
        exitCode: 2,
      });
    }
    if (!UUID_RE.test(id)) {
      throw new BugHarnessError("id must be a uuid", {
        code: "invalid_id",
        exitCode: 2,
      });
    }
  } else if (id && !UUID_RE.test(id)) {
    throw new BugHarnessError("id must be a uuid", {
      code: "invalid_id",
      exitCode: 2,
    });
  }

  if (!id) {
    throw new BugHarnessError("Missing --id <uuid>", {
      code: "missing_id",
      exitCode: 2,
    });
  }

  const detail = await adminGet(`bugs/${id}`);
  if (fixtureName === "with-secrets" && createdFlag) {
    assertSecretsRedacted(detail);
  }

  const status = await adminPost(`bugs/${id}/status`, { status: "triaging", statusNote: "e2e harness smoke" });
  const triageDoc = asRecord(loadJsonFixture(DEFAULT_TRIAGE_FIXTURE));
  const triage = await adminPost(`bugs/${id}/triage`, { triage: triageDoc });
  const applied = await adminPost(`bugs/${id}/apply-triage`, { applyPriority: true });

  return {
    ok: true,
    command: "smoke",
    consoleUrl: consoleBaseUrl(),
    id,
    created: createdFlag,
    createSkipped: skippedCreate,
    createSkipReason: skipReason,
    createAuthSource: auth?.source ?? null,
    fixture: fixtureName,
    reporterConsoleUrl:
      (typeof asRecord(created).consoleUrl === "string"
        ? asRecord(created).consoleUrl
        : publicReportFields(detail).consoleUrl) ?? null,
    report: publicReportFields(applied),
    steps: {
      create: createdFlag ? publicReportFields(created) : null,
      get: publicReportFields(detail),
      status: publicReportFields(status),
      triage: publicReportFields(triage),
      apply: publicReportFields(applied),
    },
  };
}

async function runCommand(args: HarnessArgs): Promise<JsonValue> {
  switch (args.command) {
    case "help":
      return helpPayload();
    case "smoke":
      return runSmoke(args);
    case "create": {
      const fixtureName = resolveCreateFixtureName(args.options.get("fixture"));
      const created = await createFromFixture(fixtureName);
      return {
        ok: true,
        command: "create",
        fixture: fixtureName,
        report: publicReportFields(created),
      };
    }
    case "get":
      return {
        ok: true,
        command: "get",
        report: publicReportFields(await adminGet(`bugs/${requiredId(args)}`)),
      };
    case "status":
      return {
        ok: true,
        command: "status",
        report: publicReportFields(await adminPost(`bugs/${requiredId(args)}/status`, statusBody(args))),
      };
    case "triage": {
      const fixture = args.options.get("fixture") ?? args.options.get("file") ?? DEFAULT_TRIAGE_FIXTURE;
      const triage = asRecord(loadJsonFixture(fixture));
      return {
        ok: true,
        command: "triage",
        report: publicReportFields(await adminPost(`bugs/${requiredId(args)}/triage`, { triage })),
      };
    }
    case "apply":
      return {
        ok: true,
        command: "apply",
        report: publicReportFields(await adminPost(`bugs/${requiredId(args)}/apply-triage`, applyBody(args))),
      };
    case "delete":
      return {
        ok: true,
        command: "delete",
        report: publicReportFields(await adminDelete(`bugs/${requiredId(args)}`)),
      };
    case "list": {
      const listed = await adminGet(listQuery(args.options));
      const result = asRecord(listed).result;
      const items = Array.isArray(asRecord(result).items)
        ? (asRecord(result).items as JsonValue[]).map((item) => publicReportFields(item))
        : [];
      return {
        ok: true,
        command: "list",
        total: asRecord(result).total ?? null,
        limit: asRecord(result).limit ?? null,
        offset: asRecord(result).offset ?? null,
        items,
      };
    }
    default:
      throw new BugHarnessError(`Unknown command: ${args.command}`, {
        code: "unknown_command",
        exitCode: 2,
      });
  }
}

function parseJson(text: string): JsonValue {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function publicErrorMessage(body: JsonValue, status: number) {
  const record = asRecord(body);
  const nested = asRecord(record.error);
  const message = record.message ?? nested.message;
  if (typeof message === "string" && message.trim()) return redactSecrets(message);
  const code = record.code ?? record.error ?? nested.code;
  if (typeof code === "string" && code.trim()) return code;
  return `Bug harness request failed with HTTP ${status}`;
}

function publicErrorCode(body: JsonValue) {
  const record = asRecord(body);
  const nested = asRecord(record.error);
  const code = record.code ?? (typeof record.error === "string" ? record.error : nested.code);
  return typeof code === "string" && code.trim() ? code : "request_failed";
}

function redactSecrets(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bRAVI_ADMIN_TOKEN\s*=\s*\S+/g, "RAVI_ADMIN_TOKEN=[REDACTED]");
}

function asRecord(value: unknown): Record<string, JsonValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  return {};
}

function printHuman(payload: JsonValue) {
  const record = asRecord(payload);
  if (record.ok === false) {
    console.error(redactSecrets(typeof record.message === "string" ? record.message : "Bug harness failed"));
    return;
  }
  if (record.command === "help") {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const report = asRecord(record.report);
  const id = report.id ?? record.id;
  const lines = [
    `ok command=${String(record.command ?? "unknown")}`,
    id ? `id=${String(id)}` : null,
    record.created === true ? "created=yes" : record.createSkipped === true ? "created=skipped" : null,
    typeof record.reporterConsoleUrl === "string" ? `consoleUrl=${record.reporterConsoleUrl}` : null,
    typeof report.consoleUrl === "string" ? `reportUrl=${report.consoleUrl}` : null,
    typeof report.status === "string" ? `status=${report.status}` : null,
    typeof report.priority === "string" ? `priority=${report.priority}` : null,
    typeof record.total === "number" ? `total=${record.total}` : null,
    typeof record.createSkipReason === "string" ? record.createSkipReason : null,
  ].filter((line): line is string => Boolean(line));
  console.log(lines.join("\n"));
  if (Array.isArray(record.items)) {
    for (const item of record.items) {
      const row = publicReportFields(item);
      console.log(`- ${row.id ?? "?"}  ${row.status ?? "?"}  ${row.priority ?? "-"}  ${row.title ?? ""}`.trim());
    }
  }
}

function output(payload: JsonValue, json: boolean) {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  printHuman(payload);
}

async function main() {
  const args = parseHarnessArgs(process.argv.slice(2));
  output(await runCommand(args), args.json);
}

if (import.meta.main) {
  main().catch((error) => {
    const json = process.argv.includes("--json");
    if (error instanceof BugHarnessError) {
      output(
        {
          ok: false,
          error: error.code,
          message: redactSecrets(error.message),
          status: error.status ?? null,
        },
        json,
      );
      process.exit(error.exitCode);
    }

    output(
      {
        ok: false,
        error: "unexpected_error",
        message: redactSecrets(error instanceof Error ? error.message : "Unknown error"),
      },
      json,
    );
    process.exit(1);
  });
}
