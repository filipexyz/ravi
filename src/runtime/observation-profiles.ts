import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, extname, isAbsolute, join as joinPath, relative, resolve as resolvePath } from "node:path";
import { z } from "zod";
import { discoverPlugins } from "../plugins/index.js";
import { getRaviStateDir } from "../utils/paths.js";

export const DEFAULT_OBSERVER_PROFILE_ID = "default";

export type ObserverProfileSourceKind = "system" | "plugin" | "workspace" | "user";
export type ObserverProfileDeliveryPolicy = "realtime" | "debounce" | "end_of_turn" | "manual";
export type ObserverProfileMode = "observe" | "summarize" | "report" | "intervene";

export interface ObserverProfileDefaults {
  eventTypes: string[];
  deliveryPolicy: ObserverProfileDeliveryPolicy;
  mode?: ObserverProfileMode;
}

export interface ObserverProfileTemplateRef {
  key: string;
  path: string;
  content: string;
  sha256: string;
}

export interface ResolvedObserverProfile {
  id: string;
  version: string;
  label: string;
  description: string;
  defaults: ObserverProfileDefaults;
  templates: {
    delivery: Record<string, string>;
    events: Record<string, string>;
  };
  templateRefs: ObserverProfileTemplateRef[];
  rendererHints: Record<string, string>;
  body: string;
  sourceKind: ObserverProfileSourceKind;
  source: string;
  profileDir: string | null;
  profilePath: string | null;
  rawProfileMarkdown: string;
}

export interface ObserverProfileValidationIssue {
  profileId: string;
  source?: string;
  path?: string;
  message: string;
}

export interface ObserverProfileValidationResult {
  ok: boolean;
  profiles: Array<{
    id: string;
    version: string;
    sourceKind: ObserverProfileSourceKind;
    source: string;
    valid: boolean;
    error?: string;
  }>;
  errors: ObserverProfileValidationIssue[];
}

export interface ObserverProfilePreviewResult {
  profile: ResolvedObserverProfile;
  eventType: string;
  eventMarkdown: string;
  prompt: string;
}

type FrontmatterValue = string | number | boolean | null | string[] | FrontmatterObject;
interface FrontmatterObject {
  [key: string]: FrontmatterValue;
}

const OBSERVER_PROFILE_SOURCE_PRECEDENCE: ObserverProfileSourceKind[] = ["system", "plugin", "workspace", "user"];
const PROFILE_ENTRYPOINT = "PROFILE.md";
const WORKSPACE_PROFILE_SEGMENTS = [".ravi", "observers", "profiles"] as const;
const USER_PROFILE_SEGMENTS = ["observers", "profiles"] as const;
const DEFAULT_EVENT_TYPES = ["message.user", "message.assistant", "turn.complete", "turn.failed", "turn.interrupt"];
const DELIVERY_POLICIES = ["realtime", "debounce", "end_of_turn", "manual"] as const;
const OBSERVER_MODES = ["observe", "summarize", "report", "intervene"] as const;
const SNAPSHOT_PROFILE_OPEN = "<!-- ravi-observer-profile:profile -->";
const SNAPSHOT_PROFILE_CLOSE = "<!-- /ravi-observer-profile:profile -->";
const SNAPSHOT_TEMPLATE_OPEN_PREFIX = "<!-- ravi-observer-profile:template";
const SNAPSHOT_TEMPLATE_CLOSE = "<!-- /ravi-observer-profile:template -->";

const EVENT_TEMPLATE_CONVENTIONS: Record<string, string> = {
  "message.user": "events/message-user.md",
  "message.assistant": "events/message-assistant.md",
  "turn.complete": "events/turn-complete.md",
  "turn.failed": "events/turn-failed.md",
  "turn.interrupt": "events/turn-interrupt.md",
  "tool.start": "events/tool-start.md",
  "tool.end": "events/tool-end.md",
  default: "events/default.md",
};

const DELIVERY_TEMPLATE_CONVENTIONS: Record<ObserverProfileDeliveryPolicy, string> = {
  realtime: "delivery/realtime.md",
  debounce: "delivery/debounce.md",
  end_of_turn: "delivery/end-of-turn.md",
  manual: "delivery/manual.md",
};

const ObserverProfileManifestSchema = z.object({
  id: z.string().trim().min(1),
  version: z.string().trim().min(1),
  label: z.string().trim().min(1),
  description: z.string().trim().min(1),
  defaults: z
    .object({
      eventTypes: z.array(z.string().trim().min(1)).optional(),
      deliveryPolicy: z.enum(DELIVERY_POLICIES).optional(),
      mode: z.enum(OBSERVER_MODES).optional(),
    })
    .default({}),
  templates: z
    .object({
      delivery: z.record(z.string(), z.string().trim().min(1)).default({}),
      events: z.record(z.string(), z.string().trim().min(1)).default({}),
    })
    .default({ delivery: {}, events: {} }),
  rendererHints: z.record(z.string(), z.string()).default({}),
});

type ObserverProfileManifest = z.infer<typeof ObserverProfileManifestSchema>;

const DEFAULT_PROFILE_MD = `---
id: default
version: "1"
label: Default Observer
description: Default Markdown renderer for Ravi observation deliveries.
defaults:
  eventTypes:
    - message.user
    - message.assistant
    - turn.complete
    - turn.failed
    - turn.interrupt
  deliveryPolicy: end_of_turn
  mode: observe
templates:
  delivery:
    realtime: ./delivery/realtime.md
    debounce: ./delivery/debounce.md
    end_of_turn: ./delivery/end-of-turn.md
  events:
    default: ./events/default.md
    message.user: ./events/message-user.md
    message.assistant: ./events/message-assistant.md
    turn.complete: ./events/turn-complete.md
    turn.failed: ./events/turn-failed.md
    turn.interrupt: ./events/turn-interrupt.md
rendererHints:
  label: Default observer
---

# Default Observer

System fallback profile for Observation Plane prompts.
`;

const DEFAULT_TEMPLATES: Record<string, string> = {
  "delivery.realtime": `## Ravi Observation

Source session: {{source.sessionName}}
Source agent: {{source.agentId}}
Observer role: {{binding.observerRole}}
Observer mode: {{binding.observerMode}}
Delivery: realtime
Events: {{delivery.eventCount}}
Run: {{delivery.runId}}

Use only your own permissions and tools. Do not write to the source session unless your observer role and permissions explicitly require that.

{{binding.instructionsBlock}}

{{events.rendered}}
`,
  "delivery.debounce": `## Ravi Observation

Source session: {{source.sessionName}}
Source agent: {{source.agentId}}
Observer role: {{binding.observerRole}}
Observer mode: {{binding.observerMode}}
Delivery: debounce
Events: {{delivery.eventCount}}
Run: {{delivery.runId}}

Use only your own permissions and tools. Do not write to the source session unless your observer role and permissions explicitly require that.

{{binding.instructionsBlock}}

{{events.rendered}}
`,
  "delivery.end_of_turn": `## Ravi Observation

Source session: {{source.sessionName}}
Source session key: {{source.sessionKey}}
Source agent: {{source.agentId}}
Task: {{source.taskId}}
Task profile: {{source.profileId}}
Observer binding: {{binding.id}}
Observer role: {{binding.observerRole}}
Observer mode: {{binding.observerMode}}
Rule: {{binding.ruleId}}
Profile: {{profile.id}}@{{profile.version}}
Delivery: end_of_turn
Events: {{delivery.eventCount}}
Run: {{delivery.runId}}

Use only your own permissions and tools. Do not assume you can write to the source session. Do not send chat messages unless your observer instructions and permissions explicitly require that.

{{binding.instructionsBlock}}

{{events.rendered}}
`,
  "events.default": `### {{event.type}}

Event: {{event.id}}
Turn: {{event.turnId}}
Time: {{event.timestampIso}}
Preview: {{event.preview}}
Details: {{event.payloadSummary}}
`,
  "events.message.user": `### User Message

Event: {{event.id}}
Turn: {{event.turnId}}
Preview: {{event.preview}}
Details: {{event.payloadSummary}}
`,
  "events.message.assistant": `### Assistant Message

Event: {{event.id}}
Turn: {{event.turnId}}
Preview: {{event.preview}}
Details: {{event.payloadSummary}}
`,
  "events.turn.complete": `### Turn Completed

Event: {{event.id}}
Turn: {{event.turnId}}
Details: {{event.payloadSummary}}
`,
  "events.turn.failed": `### Turn Failed

Event: {{event.id}}
Turn: {{event.turnId}}
Details: {{event.payloadSummary}}
`,
  "events.turn.interrupt": `### Turn Interrupted

Event: {{event.id}}
Turn: {{event.turnId}}
Details: {{event.payloadSummary}}
`,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTemplateString(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function normalizeProfileId(value?: string | null): string | undefined {
  const id = value?.trim();
  return id ? id : undefined;
}

function stripYamlQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function parseInlineYamlValue(rawValue: string): FrontmatterValue {
  const value = rawValue.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((entry) => stripYamlQuotes(entry.trim()))
      .filter(Boolean);
  }
  return stripYamlQuotes(value);
}

function parseProfileMarkdown(
  content: string,
  path: string,
): {
  frontmatter: Record<string, FrontmatterValue>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!match) {
    throw new Error(`Observer profile missing YAML frontmatter: ${path}`);
  }
  return {
    frontmatter: parseYamlFrontmatterBlock(match[1]!, path),
    body: content.slice(match[0].length),
  };
}

function parseYamlFrontmatterBlock(block: string, path: string): Record<string, FrontmatterValue> {
  const lines = block
    .split(/\r?\n/)
    .map((raw, index) => ({
      index: index + 1,
      indent: raw.match(/^ */)?.[0].length ?? 0,
      text: raw.trimEnd(),
    }))
    .filter((line) => line.text.trim() && !line.text.trimStart().startsWith("#"));

  function parseMap(start: number, indent: number): [Record<string, FrontmatterValue>, number] {
    const result: Record<string, FrontmatterValue> = {};
    let index = start;
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent < indent) break;
      if (line.indent > indent) {
        throw new Error(`Invalid frontmatter indentation in ${path}:${line.index}`);
      }

      const fieldMatch = /^([a-zA-Z_][a-zA-Z0-9_.-]*):(?:\s*(.*))?$/.exec(line.text.trim());
      if (!fieldMatch) {
        throw new Error(`Invalid frontmatter line in ${path}:${line.index}: ${line.text.trim()}`);
      }

      const key = fieldMatch[1]!;
      const rawValue = fieldMatch[2] ?? "";
      if (rawValue.trim()) {
        result[key] = parseInlineYamlValue(rawValue);
        index += 1;
        continue;
      }

      const next = lines[index + 1];
      if (!next || next.indent <= indent) {
        result[key] = {};
        index += 1;
        continue;
      }

      if (next.text.trimStart().startsWith("- ")) {
        const values: string[] = [];
        index += 1;
        while (index < lines.length) {
          const itemLine = lines[index]!;
          if (itemLine.indent < next.indent) break;
          if (itemLine.indent !== next.indent || !itemLine.text.trimStart().startsWith("- ")) {
            throw new Error(`Invalid frontmatter array in ${path}:${itemLine.index}`);
          }
          values.push(stripYamlQuotes(itemLine.text.trimStart().slice(2).trim()));
          index += 1;
        }
        result[key] = values;
        continue;
      }

      const [nested, nextIndex] = parseMap(index + 1, next.indent);
      result[key] = nested;
      index = nextIndex;
    }
    return [result, index];
  }

  const [frontmatter, nextIndex] = parseMap(0, 0);
  if (nextIndex !== lines.length) {
    throw new Error(`Invalid frontmatter in ${path}.`);
  }
  return frontmatter;
}

function parseProfileManifest(raw: unknown, path: string): ObserverProfileManifest {
  try {
    return ObserverProfileManifestSchema.parse(raw);
  } catch (error) {
    throw new Error(`Invalid observer profile at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertMarkdownProfileDir(profileDir: string): void {
  for (const name of [
    "profile.json",
    "profile.yaml",
    "profile.yml",
    "manifest.json",
    "manifest.yaml",
    "manifest.yml",
  ]) {
    if (existsSync(joinPath(profileDir, name))) {
      throw new Error(`Observer profile ${profileDir} uses non-Markdown manifest ${name}; use PROFILE.md.`);
    }
  }
}

function assertTemplatePathInsideProfile(profileDir: string, templatePath: string, profilePath: string): string {
  if (isAbsolute(templatePath)) {
    throw new Error(`Observer profile ${profilePath} template path must be relative and inside the profile directory.`);
  }
  if (extname(templatePath).toLowerCase() !== ".md") {
    throw new Error(`Observer profile ${profilePath} template is not Markdown: ${templatePath}`);
  }
  const absolutePath = resolvePath(profileDir, templatePath);
  const relativePath = relative(profileDir, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Observer profile ${profilePath} template escapes profile directory: ${templatePath}`);
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`Observer profile ${profilePath} references missing template: ${templatePath}`);
  }
  return absolutePath;
}

function normalizeTemplateKey(kind: "delivery" | "events", key: string): string {
  return kind === "delivery" ? `delivery.${key}` : `events.${key}`;
}

function readTemplateFile(
  profileDir: string,
  profilePath: string,
  kind: "delivery" | "events",
  key: string,
  ref: string,
) {
  const absolutePath = assertTemplatePathInsideProfile(profileDir, ref, profilePath);
  const content = normalizeTemplateString(readFileSync(absolutePath, "utf8"));
  if (!content.trim()) {
    throw new Error(`Observer profile ${profilePath} template is empty: ${ref}`);
  }
  return {
    key: normalizeTemplateKey(kind, key),
    path: relative(profileDir, absolutePath),
    content,
    sha256: sha256(content),
  };
}

function resolveProfileFromMarkdown(input: {
  rawProfileMarkdown: string;
  sourceKind: ObserverProfileSourceKind;
  source: string;
  profileDir: string | null;
  profilePath: string | null;
  snapshotTemplates?: ObserverProfileTemplateRef[];
}): ResolvedObserverProfile {
  const profilePath = input.profilePath ?? `${input.source}:${PROFILE_ENTRYPOINT}`;
  const parsed = parseProfileMarkdown(input.rawProfileMarkdown, profilePath);
  const manifest = parseProfileManifest(parsed.frontmatter, profilePath);
  const templateRefs: ObserverProfileTemplateRef[] = [];

  if (input.snapshotTemplates) {
    templateRefs.push(...input.snapshotTemplates);
  } else if (input.profileDir) {
    assertMarkdownProfileDir(input.profileDir);
    for (const [key, ref] of Object.entries(manifest.templates.delivery)) {
      templateRefs.push(readTemplateFile(input.profileDir, profilePath, "delivery", key, ref));
    }
    for (const [key, ref] of Object.entries(manifest.templates.events)) {
      templateRefs.push(readTemplateFile(input.profileDir, profilePath, "events", key, ref));
    }
    for (const [key, ref] of Object.entries(DELIVERY_TEMPLATE_CONVENTIONS)) {
      const templateKey = normalizeTemplateKey("delivery", key);
      if (templateRefs.some((item) => item.key === templateKey)) continue;
      const absolutePath = resolvePath(input.profileDir, ref);
      if (existsSync(absolutePath)) {
        templateRefs.push(readTemplateFile(input.profileDir, profilePath, "delivery", key, ref));
      }
    }
    for (const [key, ref] of Object.entries(EVENT_TEMPLATE_CONVENTIONS)) {
      const templateKey = normalizeTemplateKey("events", key);
      if (templateRefs.some((item) => item.key === templateKey)) continue;
      const absolutePath = resolvePath(input.profileDir, ref);
      if (existsSync(absolutePath)) {
        templateRefs.push(readTemplateFile(input.profileDir, profilePath, "events", key, ref));
      }
    }
  }

  const templates = {
    delivery: {} as Record<string, string>,
    events: {} as Record<string, string>,
  };
  for (const template of templateRefs) {
    if (template.key.startsWith("delivery.")) {
      templates.delivery[template.key.slice("delivery.".length)] = template.content;
    } else if (template.key.startsWith("events.")) {
      templates.events[template.key.slice("events.".length)] = template.content;
    }
  }

  return {
    id: manifest.id,
    version: manifest.version,
    label: manifest.label,
    description: manifest.description,
    defaults: {
      eventTypes: [...(manifest.defaults.eventTypes ?? DEFAULT_EVENT_TYPES)],
      deliveryPolicy: manifest.defaults.deliveryPolicy ?? "end_of_turn",
      ...(manifest.defaults.mode ? { mode: manifest.defaults.mode } : {}),
    },
    templates,
    templateRefs,
    rendererHints: { ...manifest.rendererHints },
    body: parsed.body,
    sourceKind: input.sourceKind,
    source: input.source,
    profileDir: input.profileDir,
    profilePath: input.profilePath,
    rawProfileMarkdown: normalizeTemplateString(input.rawProfileMarkdown),
  };
}

function buildEmbeddedDefaultProfile(): ResolvedObserverProfile {
  const templateRefs = Object.entries(DEFAULT_TEMPLATES).map(([key, content]) => ({
    key,
    path: `${key.replace(".", "/")}.md`,
    content,
    sha256: sha256(content),
  }));
  return resolveProfileFromMarkdown({
    rawProfileMarkdown: DEFAULT_PROFILE_MD,
    sourceKind: "system",
    source: "system:default",
    profileDir: null,
    profilePath: null,
    snapshotTemplates: templateRefs,
  });
}

function loadProfilesFromDirectory(
  root: string,
  sourceKind: Exclude<ObserverProfileSourceKind, "system">,
  sourcePrefix: string,
): ResolvedObserverProfile[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry: Dirent) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const profiles: ResolvedObserverProfile[] = [];
  for (const entry of entries) {
    const profileDir = joinPath(root, entry.name);
    const profilePath = joinPath(profileDir, PROFILE_ENTRYPOINT);
    if (!existsSync(profilePath)) continue;
    const profile = resolveProfileFromMarkdown({
      rawProfileMarkdown: readFileSync(profilePath, "utf8"),
      sourceKind,
      source: `${sourcePrefix}:${profilePath}`,
      profileDir,
      profilePath,
    });
    profiles.push(profile);
  }
  return profiles;
}

function listWorkspaceProfileRoots(cwd = process.cwd()): string[] {
  const roots: string[] = [];
  let current = resolvePath(cwd);
  while (true) {
    const candidate = joinPath(current, ...WORKSPACE_PROFILE_SEGMENTS);
    if (existsSync(candidate)) roots.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots.reverse();
}

function loadPluginProfiles(): ResolvedObserverProfile[] {
  const profiles: ResolvedObserverProfile[] = [];
  for (const plugin of discoverPlugins()) {
    const pluginName = plugin.path.split("/").pop() ?? "plugin";
    profiles.push(
      ...loadProfilesFromDirectory(joinPath(plugin.path, "observers", "profiles"), "plugin", `plugin:${pluginName}`),
    );
  }
  return profiles;
}

function loadWorkspaceProfiles(): ResolvedObserverProfile[] {
  const profiles: ResolvedObserverProfile[] = [];
  for (const root of listWorkspaceProfileRoots()) {
    profiles.push(...loadProfilesFromDirectory(root, "workspace", "workspace"));
  }
  return profiles;
}

function loadUserProfiles(): ResolvedObserverProfile[] {
  return loadProfilesFromDirectory(joinPath(getRaviStateDir(), ...USER_PROFILE_SEGMENTS), "user", "user");
}

function loadObserverProfileCatalog(): Map<string, ResolvedObserverProfile> {
  const sources: Record<ObserverProfileSourceKind, ResolvedObserverProfile[]> = {
    system: [buildEmbeddedDefaultProfile()],
    plugin: loadPluginProfiles(),
    workspace: loadWorkspaceProfiles(),
    user: loadUserProfiles(),
  };
  const catalog = new Map<string, ResolvedObserverProfile>();
  for (const sourceKind of OBSERVER_PROFILE_SOURCE_PRECEDENCE) {
    for (const profile of sources[sourceKind]) {
      catalog.set(profile.id, profile);
    }
  }
  return catalog;
}

export function listObserverProfiles(): ResolvedObserverProfile[] {
  return [...loadObserverProfileCatalog().values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveObserverProfile(profileId?: string | null): ResolvedObserverProfile {
  const requestedId = normalizeProfileId(profileId) ?? DEFAULT_OBSERVER_PROFILE_ID;
  const catalog = loadObserverProfileCatalog();
  const profile = catalog.get(requestedId);
  if (!profile) {
    throw new Error(
      `Unknown observer profile: ${requestedId}. Available profiles: ${[...catalog.keys()].sort().join(", ")}.`,
    );
  }
  return profile;
}

function escapeSnapshotAttr(value: string | null | undefined): string {
  return (value ?? "").replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function unescapeSnapshotAttr(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

export function buildObserverProfileSnapshotMarkdown(profile: ResolvedObserverProfile): string {
  const templateHash = sha256(profile.templateRefs.map((item) => `${item.key}:${item.sha256}`).join("\n"));
  const header = `---
id: ${profile.id}
version: "${profile.version}"
label: ${profile.label}
source_kind: ${profile.sourceKind}
source: ${profile.source}
template_hash: ${templateHash}
---

# Observer Profile Snapshot: ${profile.label}

`;
  const profileSection = `${SNAPSHOT_PROFILE_OPEN}
${profile.rawProfileMarkdown.trimEnd()}
${SNAPSHOT_PROFILE_CLOSE}
`;
  const templateSections = profile.templateRefs
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((template) => {
      const snapshotContent = template.content.trimEnd();
      return `${SNAPSHOT_TEMPLATE_OPEN_PREFIX} key="${escapeSnapshotAttr(template.key)}" path="${escapeSnapshotAttr(
        template.path,
      )}" sha256="${sha256(snapshotContent)}" -->
${snapshotContent}
${SNAPSHOT_TEMPLATE_CLOSE}
`;
    })
    .join("\n");
  return `${header}${profileSection}\n${templateSections}`.trimEnd() + "\n";
}

export function resolveObserverProfileFromSnapshotMarkdown(snapshotMarkdown: string): ResolvedObserverProfile {
  const parsedSnapshot = parseProfileMarkdown(snapshotMarkdown, "observer-profile-snapshot.md");
  const profileMatch = new RegExp(
    `${SNAPSHOT_PROFILE_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n([\\s\\S]*?)\\n${SNAPSHOT_PROFILE_CLOSE.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}`,
  ).exec(snapshotMarkdown);
  if (!profileMatch) {
    throw new Error("Observer profile snapshot is missing PROFILE.md section.");
  }

  const templateRefs: ObserverProfileTemplateRef[] = [];
  const templateRegex =
    /<!-- ravi-observer-profile:template key="([^"]+)" path="([^"]*)" sha256="([0-9a-f]+)" -->\n([\s\S]*?)\n<!-- \/ravi-observer-profile:template -->/g;
  for (const match of snapshotMarkdown.matchAll(templateRegex)) {
    const key = unescapeSnapshotAttr(match[1]!);
    const path = unescapeSnapshotAttr(match[2]!);
    const expectedSha = match[3]!;
    const content = normalizeTemplateString(match[4]!);
    const actualSha = sha256(content);
    if (actualSha !== expectedSha) {
      throw new Error(`Observer profile snapshot template hash mismatch for ${key}.`);
    }
    templateRefs.push({ key, path, content, sha256: actualSha });
  }

  return resolveProfileFromMarkdown({
    rawProfileMarkdown: profileMatch[1]!,
    sourceKind: (parsedSnapshot.frontmatter.source_kind as ObserverProfileSourceKind | undefined) ?? "system",
    source: String(parsedSnapshot.frontmatter.source ?? "snapshot"),
    profileDir: null,
    profilePath: null,
    snapshotTemplates: templateRefs,
  });
}

function resolveTemplatePath(context: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".").filter(Boolean);
  let current: unknown = context;
  for (const part of parts) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function toTemplateString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(toTemplateString).join("\n");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "[structured value]";
}

function renderStrictObserverTemplate(
  template: string,
  context: Record<string, unknown>,
  metadata: { profileId: string; templateName: string },
): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (!key) {
      throw new Error(`Observer profile ${metadata.profileId} has an empty placeholder in ${metadata.templateName}.`);
    }
    const root = key.split(".")[0];
    if (!["source", "binding", "profile", "delivery", "event", "events", "input"].includes(root ?? "")) {
      throw new Error(
        `Unknown placeholder root "${root}" in observer profile ${metadata.profileId} template ${metadata.templateName}.`,
      );
    }
    const value = resolveTemplatePath(context, key);
    if (value === undefined) {
      throw new Error(
        `Unknown placeholder "{{${key}}}" in observer profile ${metadata.profileId} template ${metadata.templateName}.`,
      );
    }
    return toTemplateString(value);
  });
}

function truncate(value: string, max = 500): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function formatPayloadSummary(payload?: Record<string, unknown>): string {
  if (!payload || Object.keys(payload).length === 0) return "-";
  return Object.entries(payload)
    .slice(0, 12)
    .map(([key, value]) => {
      if (value === null || value === undefined) return `${key}=`;
      if (typeof value === "string") return `${key}=${truncate(value, 160)}`;
      if (typeof value === "number" || typeof value === "boolean") return `${key}=${String(value)}`;
      if (Array.isArray(value)) return `${key}=[${value.length} items]`;
      return `${key}=[structured value]`;
    })
    .join("; ");
}

function observerInstructions(binding: ObserverProfileRenderBinding): string {
  const value = binding.metadata?.instructions;
  return typeof value === "string" ? value.trim() : "";
}

interface ObserverProfileRenderSource {
  sessionKey: string;
  sessionName: string;
  agentId: string;
  taskId?: string;
  profileId?: string;
  projectId?: string;
  projectSlug?: string;
  tags?: Array<{ targetType: string; slug: string; assetId: string; inherited: boolean }>;
}

interface ObserverProfileRenderBinding {
  id: string;
  observerSessionName: string;
  observerAgentId: string;
  observerRole: string;
  observerMode: string;
  ruleId: string;
  deliveryPolicy: ObserverProfileDeliveryPolicy;
  metadata?: Record<string, unknown>;
}

interface ObserverProfileRenderEvent {
  id: string;
  type: string;
  timestamp: number;
  turnId?: string;
  preview?: string;
  payload?: Record<string, unknown>;
}

function buildEventContext(event: ObserverProfileRenderEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    timestampIso: new Date(event.timestamp).toISOString(),
    turnId: event.turnId ?? "-",
    preview: event.preview ? truncate(event.preview) : "-",
    payloadSummary: formatPayloadSummary(event.payload),
    payloadHash: event.payload ? sha256(JSON.stringify(event.payload)).slice(0, 16) : "-",
  };
}

function buildBaseRenderContext(input: {
  profile: ResolvedObserverProfile;
  source: ObserverProfileRenderSource;
  binding: ObserverProfileRenderBinding;
  runId?: string;
  events: ObserverProfileRenderEvent[];
  deliveryPolicy: ObserverProfileDeliveryPolicy;
  renderedEvents?: string;
  event?: ObserverProfileRenderEvent;
}): Record<string, unknown> {
  const instructions = observerInstructions(input.binding);
  return {
    source: {
      sessionKey: input.source.sessionKey,
      sessionName: input.source.sessionName,
      agentId: input.source.agentId,
      taskId: input.source.taskId ?? "-",
      profileId: input.source.profileId ?? "-",
      projectId: input.source.projectId ?? "-",
      projectSlug: input.source.projectSlug ?? "-",
      tags: input.source.tags?.map((tag) => `${tag.targetType}:${tag.slug}`).join(", ") ?? "-",
    },
    binding: {
      id: input.binding.id,
      observerSessionName: input.binding.observerSessionName,
      observerAgentId: input.binding.observerAgentId,
      observerRole: input.binding.observerRole,
      observerMode: input.binding.observerMode,
      ruleId: input.binding.ruleId,
      deliveryPolicy: input.binding.deliveryPolicy,
      instructions,
      instructionsBlock: instructions ? `Observer instructions:\n${instructions}` : "",
    },
    profile: {
      id: input.profile.id,
      version: input.profile.version,
      label: input.profile.label,
      description: input.profile.description,
      source: input.profile.source,
      sourceKind: input.profile.sourceKind,
      rendererHints: input.profile.rendererHints,
    },
    delivery: {
      policy: input.deliveryPolicy,
      runId: input.runId ?? "-",
      eventCount: input.events.length,
      timestamp: Date.now(),
      timestampIso: new Date().toISOString(),
      idempotencyKey: sha256(
        [
          input.binding.id,
          input.deliveryPolicy,
          input.runId ?? "",
          input.events.map((event) => event.id).join(","),
        ].join("\x1f"),
      ).slice(0, 24),
    },
    events: {
      rendered: input.renderedEvents ?? "",
      count: input.events.length,
      ids: input.events.map((event) => event.id).join(", "),
      types: [...new Set(input.events.map((event) => event.type))].join(", "),
    },
    event: input.event ? buildEventContext(input.event) : {},
    input: {},
  };
}

function eventTemplateFor(profile: ResolvedObserverProfile, eventType: string): { key: string; template: string } {
  const eventTemplate = profile.templates.events[eventType];
  if (eventTemplate) return { key: `events.${eventType}`, template: eventTemplate };
  const fallback = profile.templates.events.default;
  if (fallback) return { key: "events.default", template: fallback };
  throw new Error(`Observer profile ${profile.id} is missing event template for ${eventType} and events.default.`);
}

function deliveryTemplateFor(
  profile: ResolvedObserverProfile,
  deliveryPolicy: ObserverProfileDeliveryPolicy,
): { key: string; template: string } {
  const template = profile.templates.delivery[deliveryPolicy];
  if (template) return { key: `delivery.${deliveryPolicy}`, template };
  throw new Error(`Observer profile ${profile.id} is missing delivery template for ${deliveryPolicy}.`);
}

export function renderObservationEventMarkdown(input: {
  profile: ResolvedObserverProfile;
  source: ObserverProfileRenderSource;
  binding: ObserverProfileRenderBinding;
  event: ObserverProfileRenderEvent;
  deliveryPolicy: ObserverProfileDeliveryPolicy;
  runId?: string;
}): string {
  const { key, template } = eventTemplateFor(input.profile, input.event.type);
  return renderStrictObserverTemplate(
    template,
    buildBaseRenderContext({
      ...input,
      events: [input.event],
    }),
    {
      profileId: input.profile.id,
      templateName: key,
    },
  ).trim();
}

export function renderObservationPromptForProfile(input: {
  profile: ResolvedObserverProfile;
  source: ObserverProfileRenderSource;
  binding: ObserverProfileRenderBinding;
  events: ObserverProfileRenderEvent[];
  deliveryPolicy?: ObserverProfileDeliveryPolicy;
  runId?: string;
}): string {
  const deliveryPolicy = input.deliveryPolicy ?? input.binding.deliveryPolicy;
  const renderedEvents = input.events
    .map((event) =>
      renderObservationEventMarkdown({
        ...input,
        event,
        deliveryPolicy,
      }),
    )
    .join("\n\n");
  const { key, template } = deliveryTemplateFor(input.profile, deliveryPolicy);
  return renderStrictObserverTemplate(
    template,
    buildBaseRenderContext({
      ...input,
      deliveryPolicy,
      renderedEvents,
    }),
    {
      profileId: input.profile.id,
      templateName: key,
    },
  ).trim();
}

function representativePreviewEvent(eventType: string): ObserverProfileRenderEvent {
  return {
    id: `preview-${eventType.replace(/[^a-z0-9]+/gi, "-")}`,
    type: eventType,
    timestamp: 1_700_000_000_000,
    turnId: "turn-preview",
    preview: "Example source text for this observation event.",
    payload: {
      responseChars: 42,
      status: eventType.includes("failed") ? "failed" : "ok",
    },
  };
}

export function previewObserverProfile(profileId: string, eventType = "message.user"): ObserverProfilePreviewResult {
  const profile = resolveObserverProfile(profileId);
  const event = representativePreviewEvent(eventType);
  const source: ObserverProfileRenderSource = {
    sessionKey: "preview-source",
    sessionName: "preview-source",
    agentId: "worker",
    taskId: "task-preview",
    profileId: "default",
    tags: [],
  };
  const binding: ObserverProfileRenderBinding = {
    id: "binding-preview",
    observerSessionName: "obs:preview:observer",
    observerAgentId: "observer",
    observerRole: "preview",
    observerMode: profile.defaults.mode ?? "observe",
    ruleId: "rule-preview",
    deliveryPolicy: profile.defaults.deliveryPolicy,
    metadata: {
      instructions: "Use this preview to verify the observer prompt shape.",
    },
  };
  return {
    profile,
    eventType,
    eventMarkdown: renderObservationEventMarkdown({
      profile,
      source,
      binding,
      event,
      deliveryPolicy: profile.defaults.deliveryPolicy,
      runId: "run-preview",
    }),
    prompt: renderObservationPromptForProfile({
      profile,
      source,
      binding,
      events: [event],
      runId: "run-preview",
    }),
  };
}

function validateProfile(profile: ResolvedObserverProfile): void {
  const seenTemplates = new Set<string>();
  for (const template of profile.templateRefs) {
    if (seenTemplates.has(template.key)) {
      throw new Error(`Duplicate template key ${template.key}.`);
    }
    seenTemplates.add(template.key);
    if (!template.content.trim()) {
      throw new Error(`Template ${template.key} is empty.`);
    }
    renderStrictObserverTemplate(
      template.content,
      buildBaseRenderContext({
        profile,
        source: {
          sessionKey: "validate-source",
          sessionName: "validate-source",
          agentId: "worker",
          taskId: "task-validate",
          profileId: "default",
          tags: [],
        },
        binding: {
          id: "binding-validate",
          observerSessionName: "obs:validate:observer",
          observerAgentId: "observer",
          observerRole: "validate",
          observerMode: profile.defaults.mode ?? "observe",
          ruleId: "rule-validate",
          deliveryPolicy: profile.defaults.deliveryPolicy,
          metadata: {
            instructions: "Validate profile templates.",
          },
        },
        deliveryPolicy: profile.defaults.deliveryPolicy,
        events: [representativePreviewEvent("message.user")],
        renderedEvents: "Rendered event",
        event: representativePreviewEvent("message.user"),
      }),
      {
        profileId: profile.id,
        templateName: template.key,
      },
    );
  }
  if (!profile.templates.events.default) {
    throw new Error("Profile requires events.default.");
  }
  for (const policy of ["realtime", "debounce", "end_of_turn"] as const) {
    if (!profile.templates.delivery[policy]) {
      throw new Error(`Profile requires delivery.${policy}.`);
    }
  }
}

export function validateObserverProfiles(profileId?: string | null): ObserverProfileValidationResult {
  const errors: ObserverProfileValidationIssue[] = [];
  const profiles: ObserverProfileValidationResult["profiles"] = [];

  if (profileId?.trim()) {
    try {
      const profile = resolveObserverProfile(profileId);
      validateProfile(profile);
      profiles.push({
        id: profile.id,
        version: profile.version,
        sourceKind: profile.sourceKind,
        source: profile.source,
        valid: true,
      });
    } catch (error) {
      errors.push({
        profileId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: errors.length === 0, profiles, errors };
  }

  let catalog: Map<string, ResolvedObserverProfile>;
  try {
    catalog = loadObserverProfileCatalog();
  } catch (error) {
    errors.push({
      profileId: "catalog",
      message: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, profiles, errors };
  }
  for (const profile of [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    try {
      validateProfile(profile);
      profiles.push({
        id: profile.id,
        version: profile.version,
        sourceKind: profile.sourceKind,
        source: profile.source,
        valid: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      profiles.push({
        id: profile.id,
        version: profile.version,
        sourceKind: profile.sourceKind,
        source: profile.source,
        valid: false,
        error: message,
      });
      errors.push({
        profileId: profile.id,
        source: profile.source,
        path: profile.profilePath ?? undefined,
        message,
      });
    }
  }
  return { ok: errors.length === 0, profiles, errors };
}

function writeFileIfMissing(path: string, content: string, overwrite: boolean): void {
  if (!overwrite && existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalizeTemplateString(content), "utf8");
}

export function initObserverProfile(input: {
  profileId: string;
  sourceKind?: "workspace" | "user";
  overwrite?: boolean;
}): { sourceKind: "workspace" | "user"; profileDir: string; profilePath: string } {
  const id = normalizeProfileId(input.profileId);
  if (!id) throw new Error("Observer profile id is required.");
  const sourceKind = input.sourceKind ?? "workspace";
  const root =
    sourceKind === "workspace"
      ? joinPath(process.cwd(), ...WORKSPACE_PROFILE_SEGMENTS)
      : joinPath(getRaviStateDir(), ...USER_PROFILE_SEGMENTS);
  const profileDir = joinPath(root, id);
  const profilePath = joinPath(profileDir, PROFILE_ENTRYPOINT);
  const overwrite = input.overwrite ?? false;
  const profileMarkdown = DEFAULT_PROFILE_MD.replace("id: default", `id: ${id}`).replace(
    "label: Default Observer",
    `label: ${id}`,
  );
  writeFileIfMissing(profilePath, profileMarkdown, overwrite);
  for (const [key, content] of Object.entries(DEFAULT_TEMPLATES)) {
    const path = key.startsWith("delivery.")
      ? DELIVERY_TEMPLATE_CONVENTIONS[key.slice("delivery.".length) as ObserverProfileDeliveryPolicy]
      : EVENT_TEMPLATE_CONVENTIONS[key.slice("events.".length)];
    if (!path) continue;
    writeFileIfMissing(joinPath(profileDir, path), content, overwrite);
  }
  return { sourceKind, profileDir, profilePath };
}
