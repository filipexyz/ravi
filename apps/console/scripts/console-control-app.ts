#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONSOLE_URL = "https://console.ravi.bot";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type AppErrorOptions = {
  code: string;
  exitCode?: number;
  status?: number;
};

class AppError extends Error {
  code: string;
  exitCode: number;
  status?: number;

  constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.name = "ConsoleControlAppError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? 1;
    this.status = options.status;
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const operation = parsed.positionals[0] ?? "help";
  const args = parsed.positionals.slice(1);

  switch (operation) {
    case "help":
      return output(helpPayload());
    case "check":
      return output(await check());
    case "me":
    case "summary":
      return output(await apiGet("summary"));
    case "features":
      return output(await apiGet(args[0] ? `orgs/${encodeURIComponent(args[0])}/features` : "features"));
    case "orgs":
      return output(await apiGet(withQuery("orgs", parsed.options)));
    case "org":
      return output(await apiGet(`orgs/${requiredArg(args[0], "org ref")}`));
    case "users":
      return output(await apiGet(withQuery("users", parsed.options)));
    case "user":
      return output(await apiGet(`users/${requiredArg(args[0], "user ref")}`));
    case "add-member":
      return output(
        await adminPost("organizations/members/upsert", {
          createUserIfMissing: true,
          organizationRef: requiredRawArg(args[0], "org ref"),
          reason: optionOrDefault(parsed.options, "reason", "Console control member add"),
          role: args[2] ?? parsed.options.get("role") ?? "developer",
          userRef: requiredRawArg(args[1] ?? parsed.options.get("user"), "user ref"),
        }),
      );
    case "remove-member":
      return output(
        await adminPost("organizations/members/remove", {
          organizationRef: requiredRawArg(args[0], "org ref"),
          reason: optionOrDefault(parsed.options, "reason", "Console control member remove"),
          userRef: requiredRawArg(args[1] ?? parsed.options.get("user"), "user ref"),
        }),
      );
    case "delete-org":
      return output(
        await adminPost("organizations/delete", {
          organizationRef: requiredRawArg(args[0], "org ref"),
          reason: optionOrDefault(parsed.options, "reason", "Console control organization delete"),
        }),
      );
    case "create-page-site":
      return output(await adminPost("pages/sites/create", createPageSitePayload(args, parsed.options)));
    case "move-page-site":
      return output(await adminPost("pages/sites/move", movePageSitePayload(args, parsed.options)));
    case "bugs":
    case "bug":
      return output(await bugsOperation(args, parsed.options));
    default:
      throw new AppError(`Unknown operation: ${operation}`, {
        code: "unknown_operation",
        exitCode: 2,
      });
  }
}

function parseArgs(argv: string[]) {
  const positionals: string[] = [];
  const options = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--json") continue;
    if (arg === "--apply-priority" || arg === "--apply-status" || arg === "--apply-duplicate") {
      options.set(arg.slice(2), "true");
      continue;
    }
    if (
      arg === "--limit" ||
      arg === "--query" ||
      arg === "--q" ||
      arg === "--reason" ||
      arg === "--role" ||
      arg === "--user" ||
      arg === "--project" ||
      arg === "--default" ||
      arg === "--visibility" ||
      arg === "--id" ||
      arg === "--status" ||
      arg === "--priority" ||
      arg === "--note" ||
      arg === "--status-note" ||
      arg === "--duplicate" ||
      arg === "--duplicate-of" ||
      arg === "--surface" ||
      arg === "--offset" ||
      arg === "--assignee" ||
      arg === "--file"
    ) {
      const value = argv[index + 1];
      if (!value) {
        throw new AppError(`Missing value for ${arg}`, {
          code: "missing_option_value",
          exitCode: 2,
        });
      }
      const key =
        arg === "--q"
          ? "query"
          : arg === "--duplicate-of"
            ? "duplicate"
            : arg === "--status-note"
              ? "note"
              : arg.slice(2);
      options.set(key, value);
      index += 1;
      continue;
    }
    positionals.push(arg);
  }

  return { options, positionals };
}

function withQuery(path: string, options: Map<string, string>) {
  const params = new URLSearchParams();
  const limit = options.get("limit");
  const query = options.get("query");
  if (limit) params.set("limit", limit);
  if (query) params.set("q", query);
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
}

function requiredArg(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw new AppError(`Missing ${label}`, {
      code: "missing_argument",
      exitCode: 2,
    });
  }
  return encodeURIComponent(value.trim());
}

function requiredRawArg(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw new AppError(`Missing ${label}`, {
      code: "missing_argument",
      exitCode: 2,
    });
  }
  return value.trim();
}

function optionOrDefault(options: Map<string, string>, key: string, fallback: string) {
  return options.get(key)?.trim() || fallback;
}

function movePageSitePayload(args: string[], options: Map<string, string>): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    reason: optionOrDefault(options, "reason", "Console control Pages site move"),
    siteRef: requiredRawArg(args[0], "site ref"),
    targetOrganizationRef: requiredRawArg(args[1], "target org ref"),
  };
  const targetProjectRef = args[2] ?? options.get("project");
  if (targetProjectRef?.trim()) payload.targetProjectRef = targetProjectRef.trim();
  const defaultValue = options.get("default");
  if (defaultValue === "true") payload.makeDefault = true;
  if (defaultValue === "false") payload.makeDefault = false;
  return payload;
}

function createPageSitePayload(args: string[], options: Map<string, string>): Record<string, JsonValue> {
  const payload: Record<string, JsonValue> = {
    organizationRef: requiredRawArg(args[0], "org ref"),
    reason: optionOrDefault(options, "reason", "Console control Pages site create"),
    slug: requiredRawArg(args[1], "site slug"),
  };
  const projectRef = args[2] ?? options.get("project");
  if (projectRef?.trim()) payload.projectRef = projectRef.trim();
  const visibility = options.get("visibility");
  if (visibility?.trim()) payload.defaultVisibility = visibility.trim();
  const defaultValue = options.get("default");
  if (defaultValue === "true") payload.makeDefault = true;
  if (defaultValue === "false") payload.makeDefault = false;
  return payload;
}

async function check() {
  const summary = await apiGet("summary");
  const internalControl = asRecord(asRecord(summary).access).internalControl;
  const operations = asRecord(asRecord(summary).operations);
  const implemented = operations.implemented;

  return {
    ok: true,
    appId: "console/control",
    consoleUrl: consoleBaseUrl(),
    api: "internal/control",
    accessEnabled: asRecord(internalControl).enabled === true,
    operationCount: Array.isArray(implemented) ? implemented.length : null,
  };
}

const BUG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function bugsOperation(args: string[], options: Map<string, string>): Promise<JsonValue> {
  const sub = args[0];
  if (!sub || sub === "list") {
    return adminGet(bugsListPath(options));
  }
  if (sub === "get" || BUG_ID_RE.test(sub)) {
    const id = sub === "get" ? requiredBugId(args[1], options) : requiredBugId(sub, options);
    return adminGet(`bugs/${id}`);
  }
  if (sub === "status") {
    const idFromOptions = options.get("id");
    const id = requiredBugId(idFromOptions ? undefined : args[1], options);
    const status = options.get("status") ?? (idFromOptions ? args[1] : args[2]);
    if (!status?.trim()) {
      throw new AppError("Missing bug status", {
        code: "missing_argument",
        exitCode: 2,
      });
    }
    const body: Record<string, JsonValue> = { status: status.trim() };
    const note = options.get("note");
    if (note?.trim()) body.statusNote = note.trim();
    const priority = options.get("priority");
    if (priority?.trim()) body.priority = priority.trim();
    const duplicate = options.get("duplicate");
    if (duplicate?.trim()) body.duplicateOf = duplicate.trim();
    const assignee = options.get("assignee");
    if (assignee?.trim()) body.assigneeUserId = assignee.trim();
    return adminPost(`bugs/${id}/status`, body);
  }
  if (sub === "triage-enqueue") {
    const id = requiredBugId(options.get("id") ? undefined : args[1], options);
    return adminPost(`bugs/${id}/triage`, {});
  }
  if (sub === "triage-run") {
    return adminPost("bugs/triage-jobs/run", { limit: Number(options.get("limit") ?? "5") });
  }
  if (sub === "triage") {
    const id = requiredBugId(options.get("id") ? undefined : args[1], options);
    const file = options.get("file")?.trim() || join(import.meta.dir, "fixtures", "bug-reports", "triage-sample.json");
    let triage: JsonValue;
    try {
      triage = JSON.parse(readFileSync(file, "utf8")) as JsonValue;
    } catch {
      throw new AppError(`Failed to read triage fixture: ${file}`, {
        code: "fixture_missing",
        exitCode: 2,
      });
    }
    if (!triage || typeof triage !== "object" || Array.isArray(triage)) {
      throw new AppError("Triage fixture must be a ravi.bug_triage/v1 object", {
        code: "invalid_fixture",
        exitCode: 2,
      });
    }
    return adminPost(`bugs/${id}/triage`, { triage });
  }
  if (sub === "apply") {
    const id = requiredBugId(options.get("id") ? undefined : args[1], options);
    const applyPriority = options.get("apply-priority") === "true";
    const applyStatus = options.get("apply-status") === "true";
    const applyDuplicate = options.get("apply-duplicate") === "true";
    const priority = options.get("priority");
    const status = options.get("status");
    const duplicate = options.get("duplicate");
    const explicit = applyPriority || applyStatus || applyDuplicate || Boolean(priority) || Boolean(status) || Boolean(duplicate);
    const body: Record<string, JsonValue> = {
      applyPriority: explicit ? applyPriority || Boolean(priority) : true,
      applyStatus: applyStatus || Boolean(status),
      applyDuplicate: applyDuplicate || Boolean(duplicate),
    };
    if (priority?.trim()) body.priority = priority.trim();
    if (status?.trim()) body.status = status.trim();
    if (duplicate?.trim()) body.duplicateOf = duplicate.trim();
    return adminPost(`bugs/${id}/apply-triage`, body);
  }
  if (sub === "delete") {
    const id = requiredBugId(options.get("id") ? undefined : args[1], options);
    return adminDelete(`bugs/${id}`);
  }
  throw new AppError(`Unknown bugs operation: ${sub}`, {
    code: "unknown_operation",
    exitCode: 2,
  });
}

function requiredBugId(value: string | undefined, options: Map<string, string>) {
  const id = (options.get("id") ?? value)?.trim();
  if (!id) {
    throw new AppError("Missing bug id", {
      code: "missing_argument",
      exitCode: 2,
    });
  }
  if (!BUG_ID_RE.test(id)) {
    throw new AppError("Bug id must be a uuid", {
      code: "invalid_id",
      exitCode: 2,
    });
  }
  return id;
}

function bugsListPath(options: Map<string, string>) {
  const params = new URLSearchParams();
  const status = options.get("status");
  const priority = options.get("priority");
  const surface = options.get("surface");
  const query = options.get("query");
  const limit = options.get("limit");
  const offset = options.get("offset");
  const assignee = options.get("assignee");
  if (status) params.set("status", status);
  if (priority) params.set("priority", priority);
  if (surface) params.set("surface", surface);
  if (query) params.set("q", query);
  if (limit) params.set("limit", limit);
  if (offset) params.set("offset", offset);
  if (assignee) params.set("assigneeUserId", assignee);
  const queryString = params.toString();
  return queryString ? `bugs?${queryString}` : "bugs";
}

async function adminGet(path: string): Promise<JsonValue> {
  const token = readAdminToken();
  const baseUrl = consoleBaseUrl();
  const url = new URL(`/api/internal/admin/${path}`, baseUrl);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-request-id": `console-control-app-admin-${Date.now()}`,
    },
    method: "GET",
  });
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new AppError(publicErrorMessage(payload, response.status), {
      code: publicErrorCode(payload),
      status: response.status,
    });
  }

  return payload;
}

async function adminPost(path: string, body: Record<string, JsonValue>): Promise<JsonValue> {
  const token = readAdminToken();
  const baseUrl = consoleBaseUrl();
  const url = new URL(`/api/internal/admin/${path}`, baseUrl);
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-request-id": `console-control-app-admin-${Date.now()}`,
    },
    method: "POST",
  });
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new AppError(publicErrorMessage(payload, response.status), {
      code: publicErrorCode(payload),
      status: response.status,
    });
  }

  return payload;
}

async function adminDelete(path: string): Promise<JsonValue> {
  const token = readAdminToken();
  const baseUrl = consoleBaseUrl();
  const url = new URL(`/api/internal/admin/${path}`, baseUrl);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-request-id": `console-control-app-admin-${Date.now()}`,
    },
    method: "DELETE",
  });
  const text = await response.text();
  const payload = parseJson(text);

  if (!response.ok) {
    throw new AppError(publicErrorMessage(payload, response.status), {
      code: publicErrorCode(payload),
      status: response.status,
    });
  }

  return payload;
}

async function apiGet(path: string): Promise<JsonValue> {
  const token = readAccessToken();
  const baseUrl = consoleBaseUrl();
  const url = new URL(`/api/cli/internal/control/${path}`, baseUrl);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-request-id": `console-control-app-${Date.now()}`,
    },
  });
  const text = await response.text();
  const body = parseJson(text);

  if (!response.ok) {
    throw new AppError(publicErrorMessage(body, response.status), {
      code: publicErrorCode(body),
      status: response.status,
    });
  }

  return body;
}

function readAccessToken() {
  const envToken = process.env.RAVI_CONSOLE_ACCESS_TOKEN?.trim();
  if (envToken) return envToken;

  const credentialsPath = join(process.env.HOME ?? "", ".ravi", "cloud-auth", "credentials.json");
  let credentials: unknown;
  try {
    credentials = JSON.parse(readFileSync(credentialsPath, "utf8"));
  } catch {
    throw new AppError("Ravi CLI credentials were not found. Run `ravi login` first.", {
      code: "credentials_missing",
    });
  }

  const token = asRecord(credentials).accessToken;
  if (typeof token !== "string" || !token.trim()) {
    throw new AppError("Ravi CLI access token is missing. Run `ravi login` again.", {
      code: "access_token_missing",
    });
  }
  return token.trim();
}

function readAdminToken() {
  const token = process.env.RAVI_ADMIN_TOKEN?.trim() || readLocalRaviEnvValue("RAVI_ADMIN_TOKEN")?.trim();
  if (!token) {
    throw new AppError("RAVI_ADMIN_TOKEN is not available in this environment.", {
      code: "admin_token_missing",
    });
  }
  return token;
}

function consoleBaseUrl() {
  return process.env.RAVI_CONSOLE_URL?.trim() || readLocalRaviEnvValue("RAVI_CONSOLE_URL")?.trim() || DEFAULT_CONSOLE_URL;
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

function helpPayload() {
  return {
    ok: true,
    appId: "console/control",
    operations: [
      "check",
      "me",
      "summary",
      "features [org-ref]",
      "orgs [--limit n] [--query text]",
      "org <org-ref>",
      "users [--limit n] [--query text]",
      "user <user-ref>",
      "add-member <org-ref> <user-ref> [role] [--reason text]",
      "remove-member <org-ref> <user-ref> [--reason text]",
      "delete-org <org-ref> [--reason text]",
      "create-page-site <org-ref> <site-slug> [project-ref] [--visibility private|protected_link|public] [--default false] [--reason text]",
      "move-page-site <site-ref> <target-org-ref> [target-project-ref] [--default true] [--reason text]",
      "bugs | bug list [--status] [--priority] [--surface] [--q text] [--limit n] [--offset n] [--assignee uuid]",
      "bugs | bug get <id>",
      "bugs | bug status <id> <status> [--note text] [--priority p0-p3] [--duplicate uuid] [--assignee uuid]",
      "bugs | bug triage <id> [--file scripts/fixtures/bug-reports/triage-sample.json]",
      "bugs | bug triage-enqueue <id>",
      "bugs | bug triage-run [--limit n]",
      "bugs | bug apply <id> [--apply-priority] [--apply-status] [--apply-duplicate] [--priority p0-p3] [--status ...] [--duplicate uuid]",
      "bugs | bug delete <id>",
    ],
  };
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
  const message = record.message;
  if (typeof message === "string" && message.trim()) return message;
  const code = record.code ?? record.error;
  if (typeof code === "string" && code.trim()) return code;
  return `Console control request failed with HTTP ${status}`;
}

function publicErrorCode(body: JsonValue) {
  const record = asRecord(body);
  const code = record.code ?? record.error;
  return typeof code === "string" && code.trim() ? code : "request_failed";
}

function asRecord(value: unknown): Record<string, JsonValue> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, JsonValue>;
  }
  return {};
}

function output(payload: JsonValue) {
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  if (error instanceof AppError) {
    output({
      ok: false,
      error: error.code,
      message: error.message,
      status: error.status ?? null,
    });
    process.exit(error.exitCode);
  }

  output({
    ok: false,
    error: "unexpected_error",
    message: error instanceof Error ? error.message : "Unknown error",
  });
  process.exit(1);
});
