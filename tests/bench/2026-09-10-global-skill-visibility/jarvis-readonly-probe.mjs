// Operator probe: pipe this file to `ssh <authorized-host> /usr/bin/node -`.
// Reads files and runs SELECT statements via sqlite3 -readonly. Never imports RAVI.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const packageRoot = "/home/ravi/.nvm/versions/node/v22.22.2/lib/node_modules/ravi.bot";
const database = "/home/ravi/.ravi/ravi.db";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const query = (sql) => JSON.parse(execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", database, sql], { encoding: "utf8" }) || "[]");
const agent = query("SELECT id,cwd,provider,json_extract(defaults,'$.runtimePermissions') runtimePermissions FROM agents WHERE id='jarvis'")[0];
if (!agent) throw new Error("Jarvis does not exist in the inspected database.");
agent.runtimePermissions = JSON.parse(agent.runtimePermissions ?? "null");
const grants = query("SELECT skill_name FROM skill_grants WHERE agent_id='jarvis' ORDER BY skill_name").map((row) => row.skill_name);
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const internal = JSON.parse(readFileSync(join(packageRoot, "dist/bundle/internal-plugins.json"), "utf8"));

function metadata(content, source, directory, pluginName) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1] ?? "";
  const rawName = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
  const name = rawName?.replace(/^["']|["']$/g, "") ?? directory;
  return {
    name,
    directory,
    source,
    ...(pluginName ? { pluginName } : {}),
    requirements: frontmatter.split(/\r?\n/).filter((line) => /^ravi\.requires\s*:/.test(line)),
    digest: sha256(content),
  };
}

function diskSkills(root, source, pluginName) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).flatMap((entry) => {
    const file = join(root, entry.name, "SKILL.md");
    return existsSync(file) ? [metadata(readFileSync(file, "utf8"), source, entry.name, pluginName)] : [];
  });
}

const internalSkills = internal.plugins.flatMap((plugin) => plugin.files.flatMap((file) => {
  const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(file.path);
  return match ? [metadata(file.content, `catalog:${plugin.name}/${match[1]}`, match[1], plugin.name)] : [];
}));
const pluginRoot = "/home/ravi/ravi/plugins";
const installedSkills = readdirSync(pluginRoot).flatMap((name) => existsSync(join(pluginRoot, name, ".claude-plugin/plugin.json"))
  ? diskSkills(join(pluginRoot, name, "skills"), `plugin:${name}`, name)
  : []);
const workspaceSkills = [".agents", ".claude", ".codex"].flatMap((name) => diskSkills(join(agent.cwd, name, "skills"), `local:workspace:${name.slice(1)}`));
const nativeDiskSkills = diskSkills("/home/ravi/.codex/skills", "codex-home");
const sourceMap = JSON.parse(readFileSync(join(packageRoot, "dist/bundle/index.js.map"), "utf8"));
const permissionSources = ["runtime-bootstrap-provider.ts", "agent-default-capabilities-provider.ts", "provider-registry.ts"].map((name) => {
  const index = sourceMap.sources.findIndex((source) => source.endsWith(`/permissions/${name}`));
  if (index < 0) throw new Error(`Permission source unavailable: ${name}`);
  return { name, digest: sha256(sourceMap.sourcesContent[index].replaceAll("\r\n", "\n")) };
});

console.log(JSON.stringify({
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  package: { path: packageRoot, realPath: realpathSync(packageRoot), version: packageJson.version, gitHead: packageJson.gitHead ?? null, bundleSha256: sha256(readFileSync(join(packageRoot, "dist/bundle/index.js"))) },
  database,
  agent,
  grants,
  contextSummary: query("SELECT kind, COUNT(*) count FROM contexts WHERE agent_id='jarvis' GROUP BY kind"),
  permissionSources,
  catalog: [...internalSkills, ...installedSkills, ...workspaceSkills],
  nativeDiskSkills,
  limitations: ["No execution context for Jarvis was assumed or created.", "Disk inventory is not proof of native model exposure.", "Only named source directories are inventoried; runtime plugins passed by a future execution are not assumed.", "Runtime revision is unknown when package gitHead is absent."],
}));
