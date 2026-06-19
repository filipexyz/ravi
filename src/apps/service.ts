import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import type {
  RaviAppCheckResult,
  RaviAppDiscoveryOptions,
  RaviAppDiscoveryRoot,
  RaviAppListOptions,
  RaviAppManifest,
  RaviAppManifestRecord,
  RaviAppManifestSource,
  RaviAppPermissionProviderDeclaration,
  RaviAppPermissions,
} from "./types.js";

export const RAVI_APP_MANIFEST_FILE = "ravi.app.json";
export const RAVI_APP_MANIFEST_SCHEMA = "ravi.app/v1";
export const RAVI_APP_PERMISSION_PROVIDER_MAX_TIMEOUT_MS = 5_000;
export const RAVI_APP_PERMISSION_PROVIDER_MAX_CACHE_TTL_SEC = 300;

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)*$/;
const APP_LOCAL_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const APP_OPERATION_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const APP_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const VALID_SOURCES = new Set<RaviAppManifestSource>(["repo", "plugin", "state"]);
const VALID_INTERFACES = new Set(["cli", "sdk", "stream", "tool", "ui"]);
export const RAVI_APP_BUILTIN_OPERATION_HANDLERS = new Set([
  "apps.help",
  "apps.manifest.show",
  "apps.manifest.check",
  "apps.stub.list",
]);

const VALID_OPERATION_INTERFACES = new Set(["builtin", "cli", "sdk", "tool", "stream"]);
const VALID_PERMISSION_PROVIDER_INTERFACES = new Set(["builtin", "cli"]);
const VALID_STORAGE_KINDS = new Set(["state", "cache", "artifact-index", "config", "ledger"]);
const VALID_EVENT_DURABILITY = new Set(["ephemeral", "logged", "replayable"]);
const VALID_UI_VIEW_TYPES = new Set([
  "table",
  "list",
  "detail",
  "form",
  "dashboard",
  "timeline",
  "calendar",
  "kanban",
  "settings",
  "split",
  "stack",
]);
const VALID_UI_ACTION_PLACEMENTS = new Set(["toolbar", "row", "primary", "inline", "danger", "menu"]);
const VALID_UI_DENSITIES = new Set(["compact", "comfortable", "spacious"]);
const VALID_UI_ARTIFACT_KINDS = new Set(["ui.catalog", "ui.component", "ui.spec"]);
const FORBIDDEN_UI_KEYS = new Set([
  "bundle",
  "className",
  "component",
  "componentUrl",
  "css",
  "html",
  "javascript",
  "script",
  "style",
  "styles",
  "stylesheet",
  "tailwind",
]);
const APPROVED_PATH_TOKENS = ["$RAVI_STATE_DIR/", "$RAVI_HOME/", "$APP_ROOT/", "$PLUGIN_ROOT/"];
const SECRET_KEY_PATTERN = /(^|[_-])(api[_-]?key|secret|password|credential|bearer|auth[_-]?token|access[_-]?token)$/i;
const SECRET_VALUE_PATTERNS = [
  /\bRAVI_CONTEXT_KEY\s*=/i,
  /\brctx_[A-Za-z0-9_-]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
];

const DIRECTORY_SKIPLIST = new Set([".git", "node_modules", "dist", "coverage", ".next"]);
const STATIC_APP_ROOT_EXCEPTIONS = new Set(["apps"]);

export function normalizeAppId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!APP_ID_PATTERN.test(id)) {
    throw new Error(`Invalid app id: ${value}. Use lowercase slug segments, e.g. apps or music/player.`);
  }
  return id;
}

export function normalizeAppSource(value?: string): RaviAppManifestSource | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!VALID_SOURCES.has(normalized as RaviAppManifestSource)) {
    throw new Error(`Invalid app source: ${value}. Use repo|plugin|state.`);
  }
  return normalized as RaviAppManifestSource;
}

export function discoverAppManifests(options: RaviAppListOptions = {}): RaviAppManifestRecord[] {
  const roots = discoverAppRoots(options).filter((root) => !options.source || root.source === options.source);
  const files = new Map<string, RaviAppDiscoveryRoot>();

  for (const root of roots) {
    for (const filePath of findManifestFiles(root.rootPath)) {
      if (!files.has(filePath)) files.set(filePath, root);
    }
  }

  const records = Array.from(files.entries())
    .map(([filePath, root]) => readManifestRecord(filePath, root))
    .sort((left, right) => left.id.localeCompare(right.id) || left.path.localeCompare(right.path));

  markDuplicateIds(records);
  return records;
}

export function getAppManifest(id: string, options: RaviAppDiscoveryOptions = {}): RaviAppManifestRecord {
  const normalizedId = normalizeAppId(id);
  const matches = discoverAppManifests(options).filter((record) => record.manifest?.id === normalizedId);
  if (matches.length === 0) {
    throw new Error(`App not found: ${normalizedId}`);
  }
  if (matches.length > 1) {
    const paths = matches.map((record) => record.path).join(", ");
    throw new Error(`Duplicate app id "${normalizedId}" found at: ${paths}`);
  }
  return matches[0]!;
}

export function checkAppManifests(id?: string, options: RaviAppDiscoveryOptions = {}): RaviAppCheckResult[] {
  const records = id?.trim() ? [getAppManifest(id, options)] : discoverAppManifests(options);
  return records.map((record) => ({
    id: record.id,
    path: record.path,
    source: record.source,
    ok: record.valid,
    errors: record.errors,
    warnings: record.warnings,
  }));
}

export function discoverAppRoots(options: RaviAppDiscoveryOptions = {}): RaviAppDiscoveryRoot[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const roots: RaviAppDiscoveryRoot[] = [];
  const repoRoot = findRepoRoot(cwd);

  roots.push({ source: "repo", rootPath: join(repoRoot, "src", "apps") });

  for (const pluginRoot of discoverPluginRoots(repoRoot)) {
    roots.push({ source: "plugin", rootPath: join(pluginRoot, "apps") });
  }

  roots.push({ source: "state", rootPath: join(getRaviStateDir(env), "apps") });

  return dedupeRoots(roots).filter((root) => existsSync(root.rootPath));
}

function findRepoRoot(cwd: string): string {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "src"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return cwd;
    current = parent;
  }
}

function discoverPluginRoots(repoRoot: string): string[] {
  const roots: string[] = [];
  roots.push(...childDirectories(join(repoRoot, "src", "plugins", "internal")));
  roots.push(...childDirectories(join(homedir(), "ravi", "plugins")));
  roots.push(...childDirectories(join(homedir(), ".cache", "ravi", "plugins")));
  return roots;
}

function childDirectories(rootPath: string): string[] {
  if (!existsSync(rootPath)) return [];
  return readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(rootPath, entry.name))
    .sort();
}

function dedupeRoots(roots: RaviAppDiscoveryRoot[]): RaviAppDiscoveryRoot[] {
  const seen = new Set<string>();
  const deduped: RaviAppDiscoveryRoot[] = [];
  for (const root of roots) {
    const key = `${root.source}\0${resolve(root.rootPath)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ source: root.source, rootPath: resolve(root.rootPath) });
  }
  return deduped;
}

function findManifestFiles(rootPath: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number) => {
    if (depth > 5) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!DIRECTORY_SKIPLIST.has(entry.name)) visit(join(dir, entry.name), depth + 1);
        continue;
      }
      if (entry.isFile() && entry.name === RAVI_APP_MANIFEST_FILE) {
        found.push(join(dir, entry.name));
      }
    }
  };

  visit(rootPath, 0);
  return found.sort();
}

function readManifestRecord(path: string, root: RaviAppDiscoveryRoot): RaviAppManifestRecord {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return invalidRecord(path, root, `Cannot read manifest: ${formatError(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return invalidRecord(path, root, `Invalid JSON: ${formatError(error)}`);
  }

  if (!isObject(parsed)) {
    return invalidRecord(path, root, "Manifest must be a JSON object.");
  }

  const manifest = parsed as RaviAppManifest;
  const { errors, warnings } = validateManifest(manifest, path, root);
  const permissions = normalizePermissions(isObject(manifest.permissions) ? manifest.permissions : undefined);
  const interfaceNames = interfaceNamesFor(manifest.interfaces);
  return {
    id:
      typeof manifest.id === "string" && manifest.id.trim()
        ? manifest.id.trim().toLowerCase()
        : manifestIdFromPath(path, root.rootPath),
    name: stringOrNull(manifest.name),
    version: stringOrNull(manifest.version),
    description: stringOrNull(manifest.description),
    schema: stringOrNull(manifest.schema),
    source: root.source,
    path: resolve(path),
    relativePath: relative(root.rootPath, path),
    rootPath: root.rootPath,
    interfaceNames,
    permissions,
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
  };
}

function validateManifest(
  manifest: RaviAppManifest,
  path: string,
  root: RaviAppDiscoveryRoot,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const operationIds = operationIdsFor(manifest.operations);

  if (manifest.schema !== RAVI_APP_MANIFEST_SCHEMA) {
    errors.push(`schema must be "${RAVI_APP_MANIFEST_SCHEMA}".`);
  }

  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    errors.push("id is required.");
  } else if (!APP_ID_PATTERN.test(manifest.id.trim())) {
    errors.push(`id must match ${APP_ID_PATTERN.source}.`);
  }

  requireString(manifest, "name", errors);
  requireString(manifest, "version", errors);
  requireString(manifest, "description", errors);

  if (!isObject(manifest.interfaces)) {
    errors.push("interfaces must be an object with at least one of cli|sdk|stream|tool|ui.");
  } else {
    const declared = Object.keys(manifest.interfaces);
    const known = declared.filter((name) => VALID_INTERFACES.has(name));
    if (known.length === 0) {
      errors.push("interfaces must declare at least one of cli|sdk|stream|tool|ui.");
    }
    for (const name of declared.filter((entry) => !VALID_INTERFACES.has(entry))) {
      warnings.push(`Unknown interface "${name}" will be ignored by v1 discovery.`);
    }
    validateInterfaceBlocks(manifest, operationIds, errors, warnings);
  }

  validateOperations(manifest.operations, manifest.interfaces, manifest.id, errors, warnings);

  if (manifest.permissions !== undefined && !isObject(manifest.permissions)) {
    errors.push("permissions must be an object when present.");
  } else {
    validatePermissions(manifest.permissions, manifest.operations, errors);
  }

  validateStorage(manifest.storage, errors, warnings);
  validateEvents(manifest.events, errors, warnings);
  if (manifest.skills !== undefined && !isStringArray(manifest.skills)) {
    warnings.push("skills should be an array of skill names when present.");
  }
  if (manifest.health === undefined) {
    warnings.push("health checks are not declared.");
  } else if (!isObject(manifest.health)) {
    warnings.push("health should be an object when present.");
  } else {
    validateHealth(manifest.health, manifest.id, errors, warnings);
  }
  if (manifest.versioning !== undefined && !isObject(manifest.versioning)) {
    warnings.push("versioning should be an object when present.");
  }

  const expectedId = manifestIdFromPath(path, root.rootPath);
  if (manifest.id && APP_ID_PATTERN.test(manifest.id) && expectedId !== manifest.id && root.source !== "plugin") {
    warnings.push(`Manifest id "${manifest.id}" does not match path-derived id "${expectedId}".`);
  }

  errors.push(...findSecretLikeValues(manifest));
  return { errors, warnings };
}

function validateInterfaceBlocks(
  manifest: RaviAppManifest,
  operationIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  const interfaces = manifest.interfaces;
  for (const [name, value] of Object.entries(interfaces)) {
    if (!VALID_INTERFACES.has(name)) continue;
    if (!isObject(value)) {
      errors.push(`interfaces.${name} must be an object.`);
      continue;
    }
    if (name === "cli") {
      if (typeof value.command !== "string" || !value.command.trim()) {
        warnings.push("interfaces.cli.command should declare the canonical CLI command.");
      }
      if (value.json !== true) {
        warnings.push("interfaces.cli.json should be true for machine-consumed CLI apps.");
      }
      if (
        typeof value.health === "string" &&
        isRecursiveDynamicAppCommand(manifest.id, value.health) &&
        !isRouterHealthCommand(manifest.id, value.health)
      ) {
        errors.push(`interfaces.cli.health must not recursively invoke ravi ${manifest.id.split("/").join(" ")}.`);
      }
    }
    if (name === "sdk" && (typeof value.namespace !== "string" || !value.namespace.trim())) {
      warnings.push("interfaces.sdk.namespace should declare the generated SDK namespace.");
    }
    if (name === "ui") {
      validateUiInterface(value, manifest.id, operationIds, errors, warnings);
      if (manifest.operations === undefined) {
        warnings.push("interfaces.ui should be paired with top-level operations for snapshots and actions.");
      }
    }
  }
}

function validateOperations(
  value: unknown,
  interfaces: unknown,
  appId: unknown,
  errors: string[],
  warnings: string[],
): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push("operations must be an object when present.");
    return;
  }

  const declaredInterfaces = isObject(interfaces) ? interfaces : {};
  const entries = Object.entries(value);
  if (entries.length === 0) {
    warnings.push("operations should declare at least one operation when present.");
  }

  for (const [id, operation] of entries) {
    const path = `operations.${id}`;
    if (!APP_OPERATION_ID_PATTERN.test(id)) {
      errors.push(`${path} id must match ${APP_OPERATION_ID_PATTERN.source}.`);
    }
    if (!isObject(operation)) {
      errors.push(`${path} must be an object.`);
      continue;
    }

    const interfaceName = operation.interface;
    if (typeof interfaceName !== "string" || !VALID_OPERATION_INTERFACES.has(interfaceName)) {
      errors.push(`${path}.interface must be one of ${Array.from(VALID_OPERATION_INTERFACES).join("|")}.`);
    } else if (interfaceName !== "builtin" && !isObject(declaredInterfaces[interfaceName])) {
      errors.push(`${path}.interface references undeclared interfaces.${interfaceName}.`);
    }

    if (operation.mutating === undefined) {
      warnings.push(`${path}.mutating should declare whether the operation changes state.`);
    } else if (typeof operation.mutating !== "boolean") {
      errors.push(`${path}.mutating must be a boolean when present.`);
    }

    if (typeof operation.permission !== "string" && operation.permission !== undefined) {
      errors.push(`${path}.permission must be a string when present.`);
    }
    if (operation.permissions !== undefined && !isStringArray(operation.permissions)) {
      errors.push(`${path}.permissions must be an array of strings when present.`);
    }
    if (operation.mutating === true && operation.permission === undefined && operation.permissions === undefined) {
      warnings.push(`${path} is mutating and should declare permission or permissions.`);
    }

    validateOperationTarget(operation, path, typeof appId === "string" ? appId.trim() : "", errors, warnings);
    validateOperationSchemaReference(operation.inputSchema, `${path}.inputSchema`, errors);
    validateOperationSchemaReference(operation.outputSchema, `${path}.outputSchema`, errors);
    validateOperationAuthorization(operation.authorization, `${path}.authorization`, errors);
  }
}

function validateOperationAuthorization(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  if (value.resource !== undefined) {
    if (!isObject(value.resource)) {
      errors.push(`${path}.resource must be an object when present.`);
    } else {
      if (value.resource.type !== undefined && !isNonEmptyString(value.resource.type)) {
        errors.push(`${path}.resource.type must be a non-empty string when present.`);
      }
      if (value.resource.id !== undefined && !isNonEmptyString(value.resource.id)) {
        errors.push(`${path}.resource.id must be a non-empty string when present.`);
      }
      if (value.resource.idFromArg !== undefined && !isNonNegativeInteger(value.resource.idFromArg)) {
        errors.push(`${path}.resource.idFromArg must be a non-negative integer when present.`);
      }
      if (value.resource.idFromOption !== undefined && !isNonEmptyString(value.resource.idFromOption)) {
        errors.push(`${path}.resource.idFromOption must be a non-empty string when present.`);
      }
      if (
        value.resource.ownerFrom !== undefined &&
        value.resource.ownerFrom !== "actor" &&
        value.resource.ownerFrom !== "surface" &&
        value.resource.ownerFrom !== "executorAgent"
      ) {
        errors.push(`${path}.resource.ownerFrom must be actor|surface|executorAgent when present.`);
      }
    }
  }

  if (value.input !== undefined) {
    if (!isObject(value.input)) {
      errors.push(`${path}.input must be an object when present.`);
    } else {
      if (value.input.includeArgs !== undefined && typeof value.input.includeArgs !== "boolean") {
        errors.push(`${path}.input.includeArgs must be a boolean when present.`);
      }
      if (value.input.includeOptions !== undefined && !isStringArray(value.input.includeOptions)) {
        errors.push(`${path}.input.includeOptions must be an array of strings when present.`);
      }
    }
  }
}

function validateOperationTarget(
  operation: Record<string, unknown>,
  path: string,
  appId: string,
  errors: string[],
  warnings: string[],
): void {
  const interfaceName = operation.interface;

  if (interfaceName === "builtin") {
    if (typeof operation.handler !== "string" || !operation.handler.trim()) {
      errors.push(`${path}.handler is required for builtin operations.`);
      return;
    }
    if (!RAVI_APP_BUILTIN_OPERATION_HANDLERS.has(operation.handler.trim())) {
      errors.push(`${path}.handler must be one of ${Array.from(RAVI_APP_BUILTIN_OPERATION_HANDLERS).join("|")}.`);
    }
    return;
  }

  if (interfaceName === "cli") {
    if (typeof operation.command !== "string" || !operation.command.trim()) {
      errors.push(`${path}.command is required for cli operations.`);
      return;
    }
    if (isRecursiveDynamicAppCommand(appId, operation.command)) {
      errors.push(`${path}.command must not recursively invoke ravi ${appId.split("/").join(" ")}.`);
    }
    if (!/(^|\s)--json(\s|$)/.test(operation.command) && operation.json !== true) {
      warnings.push(`${path}.command should support --json for Web OS snapshots and actions.`);
    }
    return;
  }

  if (interfaceName === "sdk") {
    if (typeof operation.namespace !== "string" || !operation.namespace.trim()) {
      errors.push(`${path}.namespace is required for sdk operations.`);
    }
    if (typeof operation.method !== "string" || !operation.method.trim()) {
      errors.push(`${path}.method is required for sdk operations.`);
    }
    return;
  }

  if (interfaceName === "tool") {
    if (typeof operation.name !== "string" || !operation.name.trim()) {
      errors.push(`${path}.name is required for tool operations.`);
    }
    return;
  }

  if (interfaceName === "stream") {
    validateEventTopic(operation.channel, `${path}.channel`, errors);
  }
}

function validateHealth(value: Record<string, unknown>, appId: unknown, errors: string[], warnings: string[]): void {
  if (value.checks === undefined) return;
  if (!Array.isArray(value.checks)) {
    warnings.push("health.checks should be an array when present.");
    return;
  }

  value.checks.forEach((check, index) => {
    if (!isObject(check)) {
      warnings.push(`health.checks[${index}] should be an object.`);
      return;
    }
    if (check.type === "cli" && typeof check.command === "string") {
      const id = typeof appId === "string" ? appId.trim() : "";
      if (isRecursiveDynamicAppCommand(id, check.command) && !isRouterHealthCommand(id, check.command)) {
        errors.push(`health.checks[${index}].command must not recursively invoke ravi ${id.split("/").join(" ")}.`);
      }
    }
  });
}

function validateOperationSchemaReference(value: unknown, path: string, errors: string[]): void {
  if (value === undefined) return;
  if (typeof value === "string") {
    if (!value.trim()) errors.push(`${path} must be a non-empty string when present.`);
    return;
  }
  if (!isObject(value)) {
    errors.push(`${path} must be a string schema reference or object schema when present.`);
  }
}

function validateUiInterface(
  value: Record<string, unknown>,
  appId: string,
  operationIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  errors.push(...findForbiddenUiKeys(value));

  const viewIds = collectUiViewIds(value.views);
  if (value.routes === undefined && value.views === undefined) {
    warnings.push("interfaces.ui should declare routes and/or views.");
  }

  if (value.routes !== undefined) {
    if (!Array.isArray(value.routes)) {
      errors.push("interfaces.ui.routes must be an array when present.");
    } else {
      value.routes.forEach((route, index) => {
        validateUiRoute(
          route,
          `interfaces.ui.routes[${index}]`,
          appId,
          viewIds,
          value.views !== undefined,
          errors,
          warnings,
        );
      });
    }
  }

  if (value.views !== undefined) {
    if (!Array.isArray(value.views)) {
      errors.push("interfaces.ui.views must be an array when present.");
    } else {
      const seen = new Set<string>();
      value.views.forEach((view, index) => {
        if (isObject(view) && typeof view.id === "string") {
          const id = view.id.trim();
          if (seen.has(id)) errors.push(`interfaces.ui.views[${index}].id duplicates another UI view.`);
          seen.add(id);
        }
        validateUiView(view, `interfaces.ui.views[${index}]`, operationIds, errors, warnings);
      });
    }
  }
}

function validateUiRoute(
  route: unknown,
  path: string,
  appId: string,
  viewIds: Set<string>,
  hasViews: boolean,
  errors: string[],
  warnings: string[],
): void {
  if (!isObject(route)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  validateLocalId(route.id, `${path}.id`, errors);
  validateUiRoutePath(route.path, `${path}.path`, appId, errors, warnings);

  if (typeof route.label !== "string" || !route.label.trim()) {
    errors.push(`${path}.label is required.`);
  }

  if (route.icon === undefined) {
    errors.push(`${path}.icon is required.`);
  } else {
    validateIconSlug(route.icon, `${path}.icon`, errors);
  }

  if (typeof route.view !== "string" || !route.view.trim()) {
    errors.push(`${path}.view is required.`);
  } else {
    const view = route.view.trim();
    if (!APP_LOCAL_ID_PATTERN.test(view)) errors.push(`${path}.view must match ${APP_LOCAL_ID_PATTERN.source}.`);
    if (hasViews && !viewIds.has(view)) errors.push(`${path}.view references undeclared UI view "${view}".`);
  }

  if (route.permission !== undefined && (typeof route.permission !== "string" || !route.permission.trim())) {
    errors.push(`${path}.permission must be a non-empty string when present.`);
  }
}

function validateUiView(
  view: unknown,
  path: string,
  operationIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  if (!isObject(view)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  validateLocalId(view.id, `${path}.id`, errors);
  if (typeof view.type !== "string" || !VALID_UI_VIEW_TYPES.has(view.type)) {
    errors.push(`${path}.type must be one of ${Array.from(VALID_UI_VIEW_TYPES).join("|")}.`);
  }

  if (view.title !== undefined && (typeof view.title !== "string" || !view.title.trim())) {
    errors.push(`${path}.title must be a non-empty string when present.`);
  }

  if (view.density !== undefined && (typeof view.density !== "string" || !VALID_UI_DENSITIES.has(view.density))) {
    errors.push(`${path}.density must be one of ${Array.from(VALID_UI_DENSITIES).join("|")}.`);
  }

  if (view.query !== undefined) {
    if (!isObject(view.query)) {
      errors.push(`${path}.query must be an object when present.`);
    } else {
      validateOperationReference(view.query.operation, `${path}.query.operation`, operationIds, errors);
    }
  }

  if (view.refreshOn !== undefined) {
    if (!Array.isArray(view.refreshOn)) {
      errors.push(`${path}.refreshOn must be an array of event topics when present.`);
    } else {
      view.refreshOn.forEach((topic, index) => {
        validateEventTopic(topic, `${path}.refreshOn[${index}]`, errors);
      });
    }
  }

  if (view.actions !== undefined) {
    if (!Array.isArray(view.actions)) {
      errors.push(`${path}.actions must be an array when present.`);
    } else {
      view.actions.forEach((action, index) => {
        validateUiAction(action, `${path}.actions[${index}]`, operationIds, errors, warnings);
      });
    }
  }

  if (view.layout !== undefined && !isObject(view.layout)) {
    errors.push(`${path}.layout must be an object when present.`);
  }
  if (view.components !== undefined && !Array.isArray(view.components)) {
    errors.push(`${path}.components must be an array when present.`);
  }
  if (view.uiArtifact !== undefined) {
    validateUiArtifactReference(view.uiArtifact, `${path}.uiArtifact`, errors);
  }
}

function validateUiArtifactReference(value: unknown, path: string, errors: string[]): void {
  if (!isObject(value)) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  if (typeof value.kind !== "string" || !VALID_UI_ARTIFACT_KINDS.has(value.kind)) {
    errors.push(`${path}.kind must be one of ${Array.from(VALID_UI_ARTIFACT_KINDS).join("|")}.`);
  }

  if (typeof value.artifactId !== "string" || !/^art_[A-Za-z0-9_-]+$/.test(value.artifactId)) {
    errors.push(`${path}.artifactId must be an artifact id such as art_123.`);
  }

  if (
    value.version !== undefined &&
    !(
      (typeof value.version === "number" && Number.isInteger(value.version) && value.version > 0) ||
      (typeof value.version === "string" && value.version.trim().length > 0)
    )
  ) {
    errors.push(`${path}.version must be a positive integer or non-empty string when present.`);
  }
}

function validateUiAction(
  action: unknown,
  path: string,
  operationIds: Set<string>,
  errors: string[],
  warnings: string[],
): void {
  if (!isObject(action)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  validateLocalId(action.id, `${path}.id`, errors);
  if (typeof action.label !== "string" || !action.label.trim()) {
    errors.push(`${path}.label is required.`);
  }
  if (action.icon === undefined) {
    warnings.push(`${path}.icon should declare a design-system icon.`);
  } else {
    validateIconSlug(action.icon, `${path}.icon`, errors);
  }
  validateOperationReference(action.operation, `${path}.operation`, operationIds, errors);

  if (action.permission !== undefined && (typeof action.permission !== "string" || !action.permission.trim())) {
    errors.push(`${path}.permission must be a non-empty string when present.`);
  }
  if (action.permissions !== undefined && !isStringArray(action.permissions)) {
    errors.push(`${path}.permissions must be an array of strings when present.`);
  }
  if (
    action.placement !== undefined &&
    (typeof action.placement !== "string" || !VALID_UI_ACTION_PLACEMENTS.has(action.placement))
  ) {
    errors.push(`${path}.placement must be one of ${Array.from(VALID_UI_ACTION_PLACEMENTS).join("|")}.`);
  }
}

function validateOperationReference(value: unknown, path: string, operationIds: Set<string>, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} is required.`);
    return;
  }
  const operationId = value.trim();
  if (!APP_OPERATION_ID_PATTERN.test(operationId)) {
    errors.push(`${path} must match ${APP_OPERATION_ID_PATTERN.source}.`);
    return;
  }
  if (!operationIds.has(operationId)) {
    errors.push(`${path} references undeclared operation "${operationId}".`);
  }
}

function validateUiRoutePath(value: unknown, path: string, appId: string, errors: string[], warnings: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} is required.`);
    return;
  }
  const routePath = value.trim();
  if (!routePath.startsWith("/apps/")) {
    errors.push(`${path} must start with /apps/.`);
  }
  if (routePath.includes("..") || routePath.includes("//")) {
    errors.push(`${path} must not contain parent segments or duplicate slashes.`);
  }
  if (APP_ID_PATTERN.test(appId)) {
    const expectedPrefix = `/apps/${appId}`;
    if (!routePath.startsWith(expectedPrefix)) {
      warnings.push(`${path} should be nested under ${expectedPrefix}.`);
    }
  }
}

function validateIconSlug(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string when present.`);
    return;
  }
  if (!APP_LOCAL_ID_PATTERN.test(value.trim())) {
    errors.push(`${path} must be a kebab-case design-system icon id.`);
  }
}

function collectUiViewIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) return ids;
  for (const view of value) {
    if (isObject(view) && typeof view.id === "string" && APP_LOCAL_ID_PATTERN.test(view.id.trim())) {
      ids.add(view.id.trim());
    }
  }
  return ids;
}

function validatePermissions(value: unknown, operations: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) return;
  for (const key of ["required", "optional", "mutating"]) {
    const raw = value[key];
    if (raw !== undefined && !isStringArray(raw)) {
      errors.push(`permissions.${key} must be an array of strings.`);
    }
  }
  validatePermissionProvider(value.provider, operations, errors);
}

function validatePermissionProvider(value: unknown, operations: unknown, errors: string[]): void {
  if (value === undefined) return;
  const path = "permissions.provider";
  if (!isObject(value)) {
    errors.push(`${path} must be an object when present.`);
    return;
  }

  if (typeof value.id !== "string" || !value.id.trim()) {
    errors.push(`${path}.id is required.`);
  } else if (!APP_PROVIDER_ID_PATTERN.test(value.id.trim())) {
    errors.push(`${path}.id must match ${APP_PROVIDER_ID_PATTERN.source}.`);
  }

  if (typeof value.version !== "string" || !value.version.trim()) {
    errors.push(`${path}.version is required.`);
  }

  const interfaceName = value.interface;
  if (typeof interfaceName !== "string" || !VALID_PERMISSION_PROVIDER_INTERFACES.has(interfaceName)) {
    errors.push(`${path}.interface must be one of ${Array.from(VALID_PERMISSION_PROVIDER_INTERFACES).join("|")}.`);
  }

  let providerOperation: Record<string, unknown> | null = null;
  if (typeof value.operation !== "string" || !value.operation.trim()) {
    errors.push(`${path}.operation is required.`);
  } else {
    const operationId = value.operation.trim();
    const operationMap = isObject(operations) ? operations : {};
    const declared = operationMap[operationId];
    if (!isObject(declared)) {
      errors.push(`${path}.operation references undeclared operation "${operationId}".`);
    } else {
      providerOperation = declared;
      if (typeof interfaceName === "string" && declared.interface !== interfaceName) {
        errors.push(`${path}.operation must reference an operation with interface ${interfaceName}.`);
      }
      if (declared.interface === "stream") {
        errors.push(`${path}.operation must not reference a stream operation.`);
      }
      if (declared.mutating === true) {
        errors.push(`${path}.operation must not reference a mutating operation.`);
      }
      if (declared.permission !== undefined || declared.permissions !== undefined) {
        errors.push(`${path}.operation must not reference an operation that declares permission or permissions.`);
      }
    }
  }

  validateOperationSchemaReference(value.decisionSchema, `${path}.decisionSchema`, errors);
  validateOperationSchemaReference(value.requestSchema, `${path}.requestSchema`, errors);
  if (value.decisionSchema === undefined) errors.push(`${path}.decisionSchema is required.`);
  if (value.requestSchema === undefined) errors.push(`${path}.requestSchema is required.`);

  if (value.timeoutMs === undefined) {
    errors.push(`${path}.timeoutMs is required.`);
  } else if (!isPositiveInteger(value.timeoutMs)) {
    errors.push(`${path}.timeoutMs must be a positive integer.`);
  } else if (value.timeoutMs > RAVI_APP_PERMISSION_PROVIDER_MAX_TIMEOUT_MS) {
    errors.push(`${path}.timeoutMs must be <= ${RAVI_APP_PERMISSION_PROVIDER_MAX_TIMEOUT_MS}.`);
  }

  if (value.cacheTtlSec !== undefined) {
    if (!isPositiveInteger(value.cacheTtlSec)) {
      errors.push(`${path}.cacheTtlSec must be a positive integer when present.`);
    } else if (value.cacheTtlSec > RAVI_APP_PERMISSION_PROVIDER_MAX_CACHE_TTL_SEC) {
      errors.push(`${path}.cacheTtlSec must be <= ${RAVI_APP_PERMISSION_PROVIDER_MAX_CACHE_TTL_SEC}.`);
    }
  }

  if (value.failClosed !== true) {
    errors.push(`${path}.failClosed must be true.`);
  }

  if (value.scope !== undefined && !isStringArray(value.scope)) {
    errors.push(`${path}.scope must be an array of strings when present.`);
  }

  if (providerOperation?.interface === "cli" && providerOperation.command !== undefined) {
    const command = String(providerOperation.command);
    if (/\bRAVI_CONTEXT_KEY\b/.test(command)) {
      errors.push(`${path}.operation command must not interpolate or expose RAVI_CONTEXT_KEY.`);
    }
  }
}

function validateStorage(value: unknown, errors: string[], warnings: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push("storage must be an object when present.");
    return;
  }

  for (const key of Object.keys(value)) {
    if (key !== "sqlite" && key !== "files") {
      warnings.push(`Unknown storage key "${key}" will be ignored by v1 discovery.`);
    }
  }

  if (value.sqlite !== undefined) {
    if (!Array.isArray(value.sqlite)) {
      errors.push("storage.sqlite must be an array when present.");
    } else {
      value.sqlite.forEach((entry, index) => {
        validateSqliteStorage(entry, `storage.sqlite[${index}]`, errors, warnings);
      });
    }
  }

  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) {
      errors.push("storage.files must be an array when present.");
    } else {
      value.files.forEach((entry, index) => {
        validateFileStorage(entry, `storage.files[${index}]`, errors, warnings);
      });
    }
  }

  if (value.sqlite === undefined && value.files === undefined) {
    warnings.push("storage should declare sqlite and/or files arrays when present.");
  }
}

function validateSqliteStorage(entry: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isObject(entry)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  validateLocalId(entry.id, `${path}.id`, errors);
  validateStorageKind(entry.kind, `${path}.kind`, errors);
  validateManifestPath(entry.path, `${path}.path`, errors);

  if (entry.tables === undefined) {
    warnings.push(`${path}.tables should declare tables owned by the app.`);
  } else if (!isStringArray(entry.tables)) {
    errors.push(`${path}.tables must be an array of strings.`);
  }

  if (entry.migrations === undefined) {
    warnings.push(`${path}.migrations should declare migration location or strategy.`);
  } else if (typeof entry.migrations !== "string" || !entry.migrations.trim()) {
    errors.push(`${path}.migrations must be a non-empty string when present.`);
  } else {
    validateManifestPath(entry.migrations, `${path}.migrations`, errors, { allowFileName: true });
  }

  validateRetention(entry.retention, `${path}.retention`, errors, warnings);
}

function validateFileStorage(entry: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isObject(entry)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  validateManifestPath(entry.path, `${path}.path`, errors);

  if (entry.kind === undefined) {
    warnings.push(`${path}.kind should describe cache, config, generated output, artifact backing files, or similar.`);
  } else if (typeof entry.kind !== "string" || !entry.kind.trim()) {
    errors.push(`${path}.kind must be a non-empty string when present.`);
  }

  validateRetention(entry.retention, `${path}.retention`, errors, warnings);
}

function validateEvents(value: unknown, errors: string[], warnings: string[]): void {
  if (value === undefined) return;
  if (!isObject(value)) {
    errors.push("events must be an object when present.");
    return;
  }

  for (const key of Object.keys(value)) {
    if (key !== "emits" && key !== "consumes") {
      warnings.push(`Unknown events key "${key}" will be ignored by v1 discovery.`);
    }
  }

  if (value.emits !== undefined) {
    if (!Array.isArray(value.emits)) {
      errors.push("events.emits must be an array when present.");
    } else {
      value.emits.forEach((entry, index) => {
        validateEventEmit(entry, `events.emits[${index}]`, errors, warnings);
      });
    }
  }

  if (value.consumes !== undefined) {
    if (!Array.isArray(value.consumes)) {
      errors.push("events.consumes must be an array when present.");
    } else {
      value.consumes.forEach((entry, index) => {
        validateEventConsume(entry, `events.consumes[${index}]`, errors, warnings);
      });
    }
  }

  if (value.emits === undefined && value.consumes === undefined) {
    warnings.push("events should declare emits and/or consumes arrays when present.");
  }
}

function validateEventEmit(entry: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isObject(entry)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  validateEventTopic(entry.topic, `${path}.topic`, errors);
  validateEventDurability(entry.durability, `${path}.durability`, errors, warnings);

  if (typeof entry.when !== "string" || !entry.when.trim()) {
    warnings.push(`${path}.when should describe when the event is emitted.`);
  }
  if (!hasSchemaReference(entry)) {
    warnings.push(`${path} should declare schema or schemaRef.`);
  }
}

function validateEventConsume(entry: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isObject(entry)) {
    errors.push(`${path} must be an object.`);
    return;
  }

  validateEventTopic(entry.topic, `${path}.topic`, errors);
  validateEventDurability(entry.durability, `${path}.durability`, errors, warnings, { required: false });

  if (entry.handler !== undefined && (typeof entry.handler !== "string" || !entry.handler.trim())) {
    errors.push(`${path}.handler must be a non-empty string when present.`);
  }
  if (entry.interface !== undefined && (typeof entry.interface !== "string" || !entry.interface.trim())) {
    errors.push(`${path}.interface must be a non-empty string when present.`);
  }
  if (entry.handler === undefined && entry.interface === undefined) {
    warnings.push(`${path} should declare handler or interface.`);
  }
  if (!hasSchemaReference(entry)) {
    warnings.push(`${path} should declare schema or schemaRef.`);
  }
  if (entry.replay !== undefined && typeof entry.replay !== "boolean") {
    errors.push(`${path}.replay must be a boolean when present.`);
  }
}

function validateLocalId(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} is required.`);
    return;
  }
  if (!APP_LOCAL_ID_PATTERN.test(value.trim())) {
    errors.push(`${path} must match ${APP_LOCAL_ID_PATTERN.source}.`);
  }
}

function validateStorageKind(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} is required.`);
    return;
  }
  if (!VALID_STORAGE_KINDS.has(value.trim())) {
    errors.push(`${path} must be one of ${Array.from(VALID_STORAGE_KINDS).join("|")}.`);
  }
}

function validateRetention(value: unknown, path: string, errors: string[], warnings: string[]): void {
  if (value === undefined) {
    warnings.push(`${path} should declare retention policy.`);
    return;
  }
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be a non-empty string when present.`);
    return;
  }
  if (!/^[a-z][a-z0-9._-]*$/.test(value.trim())) {
    errors.push(`${path} must be a slug-like string.`);
  }
}

function validateManifestPath(
  value: unknown,
  path: string,
  errors: string[],
  options: { allowFileName?: boolean } = {},
): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} is required.`);
    return;
  }

  const normalized = value.trim();
  if (normalized.includes("\0")) {
    errors.push(`${path} must not contain NUL bytes.`);
  }
  if (normalized.split(/[\\/]+/).includes("..")) {
    errors.push(`${path} must not contain parent directory segments.`);
  }
  if (normalized.startsWith("/") && !isApprovedTokenPath(normalized)) {
    errors.push(`${path} must be relative or use an approved token such as $RAVI_STATE_DIR.`);
  }
  if (!options.allowFileName && normalized === ".") {
    errors.push(`${path} must point to a file or directory, not ".".`);
  }
}

function validateEventTopic(value: unknown, path: string, errors: string[]): void {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} is required.`);
    return;
  }
  const topic = value.trim();
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$/.test(topic)) {
    errors.push(`${path} must be a dot-separated event topic such as ravi.apps.checked.`);
  }
}

function validateEventDurability(
  value: unknown,
  path: string,
  errors: string[],
  warnings: string[],
  options: { required?: boolean } = {},
): void {
  if (value === undefined) {
    if (options.required !== false) warnings.push(`${path} should declare ephemeral|logged|replayable.`);
    return;
  }
  if (typeof value !== "string" || !VALID_EVENT_DURABILITY.has(value)) {
    errors.push(`${path} must be one of ${Array.from(VALID_EVENT_DURABILITY).join("|")}.`);
  }
}

function hasSchemaReference(entry: Record<string, unknown>): boolean {
  return (
    (typeof entry.schema === "string" && entry.schema.trim().length > 0) ||
    (typeof entry.schemaRef === "string" && entry.schemaRef.trim().length > 0)
  );
}

function isApprovedTokenPath(value: string): boolean {
  return APPROVED_PATH_TOKENS.some((token) => value.startsWith(token));
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizePermissions(value: Record<string, unknown> | undefined): RaviAppPermissions {
  return {
    required: isStringArray(value?.required) ? value.required : [],
    optional: isStringArray(value?.optional) ? value.optional : [],
    mutating: isStringArray(value?.mutating) ? value.mutating : [],
    provider: normalizePermissionProvider(isObject(value?.provider) ? value.provider : undefined),
  };
}

function normalizePermissionProvider(
  value: Record<string, unknown> | undefined,
): RaviAppPermissionProviderDeclaration | null {
  if (!value) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.version !== "string" ||
    typeof value.interface !== "string" ||
    !VALID_PERMISSION_PROVIDER_INTERFACES.has(value.interface) ||
    typeof value.operation !== "string" ||
    value.failClosed !== true
  ) {
    return null;
  }

  return {
    ...value,
    id: value.id,
    version: value.version,
    interface: value.interface as RaviAppPermissionProviderDeclaration["interface"],
    operation: value.operation,
    decisionSchema: value.decisionSchema,
    requestSchema: value.requestSchema,
    failClosed: true,
    ...(isPositiveInteger(value.timeoutMs) ? { timeoutMs: value.timeoutMs } : {}),
    ...(isPositiveInteger(value.cacheTtlSec) ? { cacheTtlSec: value.cacheTtlSec } : {}),
    ...(isStringArray(value.scope) ? { scope: value.scope } : {}),
  };
}

function interfaceNamesFor(value: unknown): string[] {
  if (!isObject(value)) return [];
  return Object.keys(value)
    .filter((name) => VALID_INTERFACES.has(name))
    .sort();
}

function operationIdsFor(value: unknown): Set<string> {
  if (!isObject(value)) return new Set();
  return new Set(Object.keys(value).filter((id) => APP_OPERATION_ID_PATTERN.test(id)));
}

function markDuplicateIds(records: RaviAppManifestRecord[]): void {
  const seen = new Map<string, RaviAppManifestRecord>();
  for (const record of records) {
    if (!record.manifest?.id || !APP_ID_PATTERN.test(record.manifest.id)) continue;
    const existing = seen.get(record.manifest.id);
    if (!existing) {
      seen.set(record.manifest.id, record);
      continue;
    }
    record.errors.push(`Duplicate app id "${record.manifest.id}" also declared at ${existing.path}.`);
    record.valid = false;
  }
}

function invalidRecord(path: string, root: RaviAppDiscoveryRoot, error: string): RaviAppManifestRecord {
  return {
    id: manifestIdFromPath(path, root.rootPath),
    name: null,
    version: null,
    description: null,
    schema: null,
    source: root.source,
    path: resolve(path),
    relativePath: relative(root.rootPath, path),
    rootPath: root.rootPath,
    interfaceNames: [],
    permissions: { required: [], optional: [], mutating: [], provider: null },
    valid: false,
    errors: [error],
    warnings: [],
    manifest: null,
  };
}

function manifestIdFromPath(path: string, rootPath?: string): string {
  const manifestDir = dirname(resolve(path));
  const root = rootPath ? resolve(rootPath) : null;
  const candidate =
    root && !relative(root, manifestDir).startsWith("..") ? relative(root, manifestDir) : basename(manifestDir);
  const segments = candidate
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase().replace(/[^a-z0-9-]+/g, "-"))
    .filter(Boolean);

  return segments.join("/") || "unknown";
}

function requireString(manifest: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof manifest[key] !== "string" || !manifest[key].trim()) {
    errors.push(`${key} is required.`);
  }
}

function findSecretLikeValues(value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...findSecretLikeValues(item, `${path}[${index}]`));
    });
    return errors;
  }
  if (!isObject(value)) {
    if (typeof value === "string" && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      errors.push(`${path} appears to contain a raw secret or context key.`);
    }
    return errors;
  }

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      errors.push(`${entryPath} uses a credential-like key; manifests must not contain secrets.`);
      continue;
    }
    errors.push(...findSecretLikeValues(entry, entryPath));
  }
  return errors;
}

function findForbiddenUiKeys(value: unknown, path = "interfaces.ui"): string[] {
  const errors: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      errors.push(...findForbiddenUiKeys(item, `${path}[${index}]`));
    });
    return errors;
  }
  if (!isObject(value)) return errors;

  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (FORBIDDEN_UI_KEYS.has(key)) {
      errors.push(`${entryPath} is not allowed; app UI must use Ravi semantic design-system primitives.`);
      continue;
    }
    errors.push(...findForbiddenUiKeys(entry, entryPath));
  }
  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecursiveDynamicAppCommand(appId: string, command: string): boolean {
  if (!appId || STATIC_APP_ROOT_EXCEPTIONS.has(appId)) return false;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "ravi") return false;

  const slashForm = tokens[1] === appId;
  if (slashForm) return true;

  const appSegments = appId.split("/");
  return appSegments.every((segment, index) => tokens[index + 1] === segment);
}

function isRouterHealthCommand(appId: string, command: string): boolean {
  if (!appId) return false;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens[0] !== "ravi") return false;

  const appSegments = appId.split("/");
  const matchesSlashForm = tokens[1] === appId;
  const offset = matchesSlashForm ? 2 : appSegments.length + 1;
  if (!matchesSlashForm && !appSegments.every((segment, index) => tokens[index + 1] === segment)) return false;

  const operation = tokens[offset];
  return operation === "check" || operation === "--help" || operation === "-h";
}
