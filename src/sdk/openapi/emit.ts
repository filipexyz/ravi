/**
 * OpenAPI 3.1 emitter for the Ravi CLI registry.
 *
 * Translates `RegistrySnapshot` into a deterministic OpenAPI document. Each
 * decorated `(group, command)` becomes a `POST /api/v1/<segments>/<command>`
 * operation with a flat request body — args and options are merged into
 * top-level keys (e.g. `{ id, limit }`). The wrapped CLI invocation form
 * (`{ args, options }`) is intentionally NOT exposed because it leaks CLI
 * grammar into the API surface.
 *
 * Determinism: commands are sorted by `fullName`, object keys are sorted
 * recursively at serialize time, and `info.version` is a SHA-256 hash of the
 * spec body. Same registry → byte-identical JSON.
 */

import { createHash } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import type {
  ArgRegistryEntry,
  CommandRegistryEntry,
  OptionRegistryEntry,
  RegistrySnapshot,
} from "../../cli/registry-snapshot.js";
import { sortKeysDeep, stableStringify } from "./stable-stringify.js";
import type {
  JsonSchema,
  OpenApiOperation,
  OpenApiPathItem,
  OpenApiResponse,
  OpenApiRequestBody,
  OpenApiSpec,
  OpenApiTag,
  SecurityRequirement,
} from "./types.js";

export interface EmitOptions {
  /** Document title. Defaults to "Ravi API". */
  title?: string;
  /** Top-level description, copied to `info.description`. */
  description?: string;
  /** `servers` block. Defaults to a single localhost gateway hint. */
  servers?: { url: string; description?: string }[];
}

const DEFAULT_TITLE = "Ravi API";
const DEFAULT_DESCRIPTION =
  "OpenAPI 3.1 spec auto-generated from the Ravi CLI registry. Each operation maps 1:1 to a `ravi <group> <command>` invocation.";
const DEFAULT_SERVERS = [{ url: "http://localhost:3000", description: "Local Ravi gateway (default)" }];

/** Shared `components.schemas` collected while emitting one document. */
type SchemaComponents = Record<string, JsonSchema>;

const LOCAL_DEF_REF = "#/$defs/";
const COMPONENT_REF = "#/components/schemas/";

/** Replace every `#/$defs/<key>` ref in `value` using `names` (key → component name). */
function rewriteDefRefs(value: unknown, names: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteDefRefs(item, names));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith(LOCAL_DEF_REF)) {
      const name = names.get(child.slice(LOCAL_DEF_REF.length));
      out[key] = name === undefined ? child : `${COMPONENT_REF}${name}`;
    } else {
      out[key] = rewriteDefRefs(child, names);
    }
  }
  return out;
}

/**
 * Move the `$defs` Zod emits for recursive or reused schemas into
 * `components.schemas`. Inside an OpenAPI document `#/$defs/...` resolves
 * against the document root, where nothing lives, so the spec fails
 * validation (Mintlify refuses to build docs.ravi.bot on it). Component
 * names hash the whole `$defs` block, so identical definitions dedupe and
 * the output stays deterministic.
 */
function hoistDefs(json: JsonSchema, components: SchemaComponents): JsonSchema {
  const defs = json.$defs as Record<string, JsonSchema> | undefined;
  if (defs === undefined) return json;
  delete json.$defs;
  const digest = createHash("sha256").update(stableStringify(defs, 0)).digest("hex").slice(0, 12);
  const names = new Map<string, string>();
  for (const key of Object.keys(defs)) {
    // Zod names anonymous definitions `__schema0`, `__schema1`, ...
    const base = key.replace(/^__schema(\d+)$/, "Schema$1").replace(/[^A-Za-z0-9._-]/g, "_");
    names.set(key, `${base}_${digest}`);
  }
  for (const [key, def] of Object.entries(defs)) {
    components[names.get(key) as string] = rewriteDefRefs(def, names) as JsonSchema;
  }
  return rewriteDefRefs(json, names) as JsonSchema;
}

/** Convert a Zod schema to JSON Schema and strip the `$schema` draft marker. */
function zodToJson(schema: ZodTypeAny, components: SchemaComponents, description?: string): JsonSchema {
  const json = hoistDefs(z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonSchema, components);
  delete json.$schema;
  if (description !== undefined && typeof json.description !== "string") {
    json.description = description;
  }
  return json;
}

/** Build the flat request body schema: args + options merged into top-level keys. */
function buildFlatSchema(
  args: ArgRegistryEntry[],
  options: OptionRegistryEntry[],
  components: SchemaComponents,
): { schema: JsonSchema; hasContent: boolean; hasRequired: boolean } {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const arg of args) {
    properties[arg.name] = zodToJson(arg.schema, components, arg.description);
    if (arg.required && arg.defaultValue === undefined) {
      required.push(arg.name);
    }
  }
  for (const opt of options) {
    if (properties[opt.name] !== undefined) {
      // Name collision between an arg and an option. The arg wins because it
      // carries the required/default semantics; the option is dropped from the
      // schema.
      continue;
    }
    properties[opt.name] = zodToJson(opt.schema, components, opt.description);
  }

  const hasContent = Object.keys(properties).length > 0;
  const schema: JsonSchema = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) schema.required = required;
  return { schema, hasContent, hasRequired: required.length > 0 };
}

/** Build the full request body schema for a command (flat form only). */
function buildRequestBody(cmd: CommandRegistryEntry, components: SchemaComponents): OpenApiRequestBody | undefined {
  const flat = buildFlatSchema(cmd.args, cmd.options, components);
  if (!flat.hasContent) return undefined;
  return {
    required: flat.hasRequired,
    content: { "application/json": { schema: flat.schema } },
  };
}

/** Map the command's authority boundary to its supported listener credentials. */
function buildSecurity(cmd: CommandRegistryEntry): SecurityRequirement[] {
  if (cmd.access?.consoleOnly) return [{ consoleDelegation: [] }];
  if (cmd.access?.consoleScope) return [{ bearerAuth: [] }, { consoleDelegation: [] }];
  if (cmd.scope === "open") return [];
  return [{ bearerAuth: [] }];
}

/** Build the response block for a command. */
function buildResponses(cmd: CommandRegistryEntry, components: SchemaComponents): Record<string, OpenApiResponse> {
  if (cmd.binary) {
    const responses: Record<string, OpenApiResponse> = {
      "200": {
        description: "Success — binary response declared via `@Returns.binary()`.",
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
    };

    if (cmd.scope !== "open") {
      responses["401"] = { description: "Unauthorized — bearer token missing or invalid." };
      responses["403"] = { description: "Forbidden — caller lacks the required scope." };
    }
    responses["400"] = { description: "Bad request — body failed schema validation." };
    responses["500"] = { description: "Internal error." };
    return responses;
  }

  const successSchema: JsonSchema = cmd.returns
    ? zodToJson(cmd.returns, components)
    : { type: "object", additionalProperties: true };
  const successDescription = cmd.returns
    ? "Success — body conforms to the `@Returns` schema."
    : "Success — no `@Returns` schema declared; payload shape is loose.";

  const responses: Record<string, OpenApiResponse> = {
    "200": {
      description: successDescription,
      content: { "application/json": { schema: successSchema } },
    },
  };

  if (cmd.scope !== "open") {
    responses["401"] = { description: "Unauthorized — bearer token missing or invalid." };
    responses["403"] = { description: "Forbidden — caller lacks the required scope." };
  }
  responses["400"] = { description: "Bad request — body failed schema validation." };
  responses["500"] = { description: "Internal error." };
  return responses;
}

/** Build a single OpenAPI operation from a registry command entry. */
function buildOperation(cmd: CommandRegistryEntry, components: SchemaComponents): OpenApiOperation {
  const tag = cmd.groupSegments[0] ?? "root";
  const operation: OpenApiOperation = {
    operationId: cmd.fullName,
    summary: cmd.description,
    tags: [tag],
    responses: buildResponses(cmd, components),
  };
  if (cmd.access?.consoleScope) {
    operation.description = cmd.access.consoleOnly
      ? "Requires a signed Console delegation on the dedicated Console listener. Ordinary runtime context keys cannot invoke this operation."
      : "Accepts a runtime context key on the ordinary gateway, or a signed Console delegation on the dedicated Console listener within the declared resource scope.";
  }
  const security = buildSecurity(cmd);
  if (security !== undefined) operation.security = security;
  const requestBody = buildRequestBody(cmd, components);
  if (requestBody) operation.requestBody = requestBody;
  return operation;
}

/** Path string for a registry command: `/api/v1/<segments>/<command>`. */
export function commandPath(cmd: CommandRegistryEntry): string {
  return `/api/v1/${[...cmd.groupSegments, cmd.command].join("/")}`;
}

/** Dedupe tags by top-level segment, preferring the root group's description. */
function buildTags(registry: RegistrySnapshot): OpenApiTag[] {
  const byName = new Map<string, OpenApiTag>();
  for (const group of registry.groups) {
    const head = group.segments[0];
    if (!head) continue;
    if (group.segments.length === 1) {
      byName.set(head, { name: head, description: group.description });
      continue;
    }
    if (!byName.has(head)) {
      byName.set(head, { name: head });
    }
  }
  return Array.from(byName.values()).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Compute a stable hash of the spec body (excluding `info.version` itself). */
function computeSpecHash(spec: OpenApiSpec): string {
  const clone = JSON.parse(JSON.stringify(spec)) as OpenApiSpec;
  clone.info.version = "";
  const canonical = stableStringify(clone, 0);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Emit an OpenAPI 3.1 document from a registry snapshot.
 *
 * The result is a plain JS object; serialize it with {@link emitJson} to get
 * deterministic JSON. Keys in the returned object are not pre-sorted — only
 * the JSON serializer sorts.
 */
export function emit(registry: RegistrySnapshot, options: EmitOptions = {}): OpenApiSpec {
  const sortedCommands = [...registry.commands]
    .filter((cmd) => !cmd.cliOnly)
    .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));

  const paths: Record<string, OpenApiPathItem> = {};
  const schemas: SchemaComponents = {};
  for (const cmd of sortedCommands) {
    paths[commandPath(cmd)] = { post: buildOperation(cmd, schemas) };
  }

  const spec: OpenApiSpec = {
    openapi: "3.1.0",
    info: {
      title: options.title ?? DEFAULT_TITLE,
      version: "0",
      description: options.description ?? DEFAULT_DESCRIPTION,
    },
    servers: options.servers ?? DEFAULT_SERVERS,
    tags: buildTags(registry),
    paths,
    components: {
      ...(Object.keys(schemas).length > 0 ? { schemas } : {}),
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "rctx",
          description:
            "Runtime context-key (`rctx_*`) issued by the Ravi gateway. " +
            "Used by ordinary gateway operations; not accepted by Console-only operations. Bootstrap the first key with " +
            "`ravi daemon init-admin-key`; rotate, derive, and revoke via the " +
            "`ravi context` family. Specs: `runtime/context-keys`, `sdk/auth`.",
        },
        consoleDelegation: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "Signed Console delegation, valid for at most 30 seconds and bound to the exact HTTP request, " +
            "resource scope and pinned connection. Accepted only on the dedicated Console listener over private SSH, " +
            "never on the ordinary gateway. Spec: `sdk/console-authority`.",
        },
      },
    },
  };

  spec.info.version = computeSpecHash(spec);
  return spec;
}

/** Serialize an emitted spec to deterministic JSON (sorted keys, 2-space indent). */
export function emitJson(registry: RegistrySnapshot, options: EmitOptions = {}): string {
  const spec = emit(registry, options);
  return stableStringify(spec, 2);
}

/** Re-export for convenience. */
export { sortKeysDeep, stableStringify };
