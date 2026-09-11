import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { SkillCatalogEntry } from "./skill-policy.js";
import type { SkillPolicySnapshot } from "./skill-policy.js";
import type { RuntimePlugin } from "./types.js";

export type SkillMaterialization = {
  snapshotId: string;
  plugins: RuntimePlugin[];
  skillPaths: Readonly<Record<string, string>>;
  nativeNames: Readonly<Record<string, string>>;
  root: string;
};

type MaterializedFile = { path: string; content: Buffer; executable: boolean };
type MaterializationPlan = {
  files: MaterializedFile[];
  pluginPaths: string[];
  aliases: Map<string, string>;
  nativeNames: Map<string, string>;
};

export class SkillMaterializationError extends Error {
  readonly code = "RAVI_SKILL_MATERIALIZATION_ERROR";
}

export function materializeSkillSnapshot(snapshot: SkillPolicySnapshot, root: string): SkillMaterialization {
  if (snapshot.contractVersion !== 1 || (snapshot.status === "empty") !== (snapshot.skills.length === 0)) {
    throw new SkillMaterializationError("Invalid skill snapshot contract or status");
  }
  const identity = JSON.stringify({
    contractVersion: snapshot.contractVersion,
    id: snapshot.id,
    scope: {
      agentId: snapshot.scope.agentId,
      executionId: snapshot.scope.executionId,
      contextKeyDigest: digest(snapshot.scope.contextKey),
    },
    revisions: snapshot.revisions,
    skills: snapshot.skills.map((skill) => ({
      id: skill.id,
      aliases: skill.aliases,
      name: skill.name,
      description: skill.description,
      path: skill.resource.path,
      pluginPath: skill.resource.pluginPath,
    })),
  });
  const plan = planMaterialization(snapshot);
  const cacheRoot = resolve(root);
  assertNoSymlinks(cacheRoot);
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  assertNoSymlinks(cacheRoot);
  const destination = join(cacheRoot, digest(identity));
  const manifest = JSON.stringify({
    identity: JSON.parse(identity),
    files: plan.files.map((file) => ({ path: file.path, hash: digest(file.content), executable: file.executable })),
    skills: Object.fromEntries(plan.aliases),
    nativeNames: Object.fromEntries(plan.nativeNames),
  });
  plan.files.push({ path: ".ravi-skill-snapshot.json", content: Buffer.from(manifest), executable: false });

  if (existsSync(destination)) {
    verifyMaterialization(destination, plan.files);
  } else {
    const staging = mkdtempSync(join(cacheRoot, ".preparing-"));
    for (const file of plan.files) {
      const filePath = join(staging, file.path);
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
      writeFileSync(filePath, file.content, { flag: "wx", mode: file.executable ? 0o555 : 0o444 });
      chmodSync(filePath, file.executable ? 0o555 : 0o444);
    }
    try {
      renameSync(staging, destination);
    } catch (error) {
      // Another process may publish the same immutable snapshot first. Never
      // overwrite it or delete directories to recover from a publication race.
      if (!existsSync(destination)) throw error;
      verifyMaterialization(destination, plan.files);
    }
    verifyMaterialization(destination, plan.files);
  }

  const plugins: RuntimePlugin[] = plan.pluginPaths.map((path) => ({ type: "local", path: join(destination, path) }));
  for (const plugin of plugins) Object.freeze(plugin);
  Object.freeze(plugins);
  return Object.freeze({
    snapshotId: snapshot.id,
    plugins,
    skillPaths: Object.freeze(Object.fromEntries([...plan.aliases].map(([id, path]) => [id, join(destination, path)]))),
    nativeNames: Object.freeze(Object.fromEntries(plan.nativeNames)),
    root: destination,
  });
}

function planMaterialization(snapshot: SkillPolicySnapshot): MaterializationPlan {
  const files: MaterializedFile[] = [];
  const plugins = new Set<string>();
  const aliases = new Map<string, string>();
  const nativeNames = new Map<string, string>();
  const owners = new Map<string, string>();
  const skillDirectories = new Set<string>();

  for (const skill of snapshot.skills) {
    const pluginName = materializedPluginName(skill);
    const pluginPath = `plugins/${pluginName}`;
    const skillDirectory = `${pluginPath}/skills/${safeSegment(skill.name)}`;
    if (skillDirectories.has(skillDirectory.toLowerCase())) {
      throw new SkillMaterializationError("Ambiguous native skill identity");
    }
    skillDirectories.add(skillDirectory.toLowerCase());
    nativeNames.set(skill.id, `${pluginName}:${basename(skillDirectory)}`);
    for (const id of [skill.id, ...skill.aliases]) {
      if (!id.trim() || id.includes("\0")) throw new SkillMaterializationError("Invalid skill identity");
      const owner = owners.get(id);
      if (owner && owner !== skill.id) throw new SkillMaterializationError("Ambiguous skill alias identity");
      owners.set(id, skill.id);
      aliases.set(id, `${skillDirectory}/SKILL.md`);
    }
    if (!plugins.has(pluginPath)) {
      plugins.add(pluginPath);
      const content = Buffer.from(JSON.stringify({ name: pluginName }));
      for (const manifestDirectory of [".claude-plugin", ".codex-plugin"]) {
        files.push({ path: `${pluginPath}/${manifestDirectory}/plugin.json`, content, executable: false });
      }
    }
    const resources = skill.resource.files
      ? skill.resource.files.map((file) => ({
          path: safeResourcePath(file.path),
          content: Buffer.from(file.content),
          executable: false,
        }))
      : readSkillDirectory(skill.resource.path, skill.resource.pluginPath);
    if (!resources.some((file) => file.path === "SKILL.md")) {
      throw new SkillMaterializationError("Authorized skill is missing SKILL.md");
    }
    const resourcePaths = new Set<string>();
    for (const resource of resources) {
      if (resource.path !== "SKILL.md" && basename(resource.path).toLowerCase() === "skill.md") {
        throw new SkillMaterializationError("Unauthorized nested skill resource");
      }
      const key = resource.path.toLowerCase();
      if (resourcePaths.has(key)) throw new SkillMaterializationError("Duplicate skill resource path");
      resourcePaths.add(key);
      files.push({ ...resource, path: `${skillDirectory}/${resource.path}` });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, pluginPaths: [...plugins].sort(), aliases, nativeNames };
}

function materializedPluginName(skill: SkillCatalogEntry): string {
  const separator = skill.id.lastIndexOf(":");
  const namespace = separator > 0 ? skill.id.slice(0, separator) : "local";
  if (skill.resource.pluginPath && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(namespace) && namespace.length <= 64) {
    return namespace;
  }
  return `ravi-selected-${digest(namespace).slice(0, 16)}`;
}

function safeSegment(value: string): string {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(value) && value.length <= 64
    ? value
    : `skill-${digest(value).slice(0, 24)}`;
}

function safeResourcePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    isAbsolute(value) ||
    parts.some((part) => !part || part === "." || part === ".." || /[:\0<>"|?*]/.test(part) || /[. ]$/.test(part)) ||
    parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  ) {
    throw new SkillMaterializationError("Unsafe skill resource path");
  }
  return normalized;
}

function readSkillDirectory(skillPath: string, pluginPath: string | undefined): MaterializedFile[] {
  if (basename(skillPath) !== "SKILL.md") throw new SkillMaterializationError("Expected an authorized SKILL.md path");
  if (pluginPath) {
    const relativePath = relative(resolve(pluginPath), resolve(skillPath));
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new SkillMaterializationError("Skill source is outside the declared plugin boundary");
    }
  }
  assertNoSymlinks(resolve(skillPath));
  return readDirectory(dirname(resolve(skillPath)));
}

function readDirectory(root: string, current = root): MaterializedFile[] {
  const stat = lstatSync(current);
  if (stat.isSymbolicLink())
    throw new SkillMaterializationError("Symbolic links are not allowed in skill materialization");
  if (!stat.isDirectory()) throw new SkillMaterializationError("Expected a skill directory");
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const path = join(current, entry.name);
    const entryStat = lstatSync(path);
    if (entryStat.isSymbolicLink()) {
      throw new SkillMaterializationError("Symbolic links are not allowed in skill materialization");
    }
    if (entryStat.isDirectory()) return readDirectory(root, path);
    if (!entryStat.isFile()) throw new SkillMaterializationError("Unsupported skill resource file type");
    return [
      {
        path: safeResourcePath(relative(root, path)),
        content: readFileSync(path),
        executable: process.platform !== "win32" && Boolean(entryStat.mode & 0o111),
      },
    ];
  });
}

function assertNoSymlinks(path: string): void {
  const { root } = parse(path);
  let current = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      throw new SkillMaterializationError("Symbolic links are not allowed in skill materialization paths");
    }
  }
}

function verifyMaterialization(root: string, expected: readonly MaterializedFile[]): void {
  assertNoSymlinks(root);
  const actual = new Map(readDirectory(root).map((file) => [file.path, file]));
  if (actual.size !== expected.length) throw new SkillMaterializationError("Skill materialization integrity changed");
  for (const file of expected) {
    const present = actual.get(file.path);
    if (!present || digest(present.content) !== digest(file.content) || present.executable !== file.executable) {
      throw new SkillMaterializationError("Skill materialization integrity changed");
    }
  }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
