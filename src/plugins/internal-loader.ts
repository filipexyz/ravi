import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface PluginFile {
  path: string;
  content: string;
}

export interface InternalPlugin {
  name: string;
  manifest: Record<string, unknown>;
  files: PluginFile[];
}

interface InternalPluginsArtifact {
  schemaVersion: 1;
  plugins: InternalPlugin[];
}

const GENERATED_INTERNAL_PLUGINS_FILE = "internal-plugins.json";
const TEXT_FILE_EXTENSIONS = new Set([".md", ".json", ".txt"]);

function modulePath(): string {
  return fileURLToPath(import.meta.url);
}

function moduleDir(): string {
  return dirname(modulePath());
}

function isPackagedRuntime(): boolean {
  const normalizedPath = modulePath().split(sep).join("/");
  const entrypoint = (process.argv[1] ?? "").split(sep).join("/");
  return normalizedPath.includes("/dist/bundle/") || entrypoint.includes("/dist/bundle/");
}

function packagedRuntimeDir(): string {
  const entrypoint = process.argv[1] ?? "";
  if (entrypoint.split(sep).join("/").includes("/dist/bundle/")) {
    return dirname(entrypoint);
  }
  return moduleDir();
}

function sourceInternalPluginsDir(): string {
  return join(moduleDir(), "internal");
}

function generatedInternalPluginsPath(): string {
  return join(packagedRuntimeDir(), GENERATED_INTERNAL_PLUGINS_FILE);
}

export function loadInternalPlugins(): InternalPlugin[] {
  return isPackagedRuntime() ? loadGeneratedInternalPlugins(generatedInternalPluginsPath()) : scanInternalPlugins();
}

export function buildInternalPluginsArtifact(outputFile: string): InternalPluginsArtifact {
  const artifact: InternalPluginsArtifact = {
    schemaVersion: 1,
    plugins: scanInternalPlugins(),
  };
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function loadGeneratedInternalPlugins(path: string): InternalPlugin[] {
  if (!existsSync(path)) {
    throw new Error(`Generated internal plugins artifact not found: ${path}. Run bun run build.`);
  }

  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<InternalPluginsArtifact>;
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.plugins)) {
    throw new Error(`Invalid generated internal plugins artifact: ${path}`);
  }
  return raw.plugins;
}

function scanInternalPlugins(): InternalPlugin[] {
  const pluginsDir = sourceInternalPluginsDir();
  if (!existsSync(pluginsDir)) {
    throw new Error(`Internal plugins source directory not found: ${pluginsDir}`);
  }

  const plugins: InternalPlugin[] = [];
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const pluginPath = join(pluginsDir, entry.name);
    const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    plugins.push({
      name: entry.name,
      manifest,
      files: collectPluginFiles(pluginPath),
    });
  }

  return plugins.sort((a, b) => a.name.localeCompare(b.name));
}

function collectPluginFiles(dir: string, basePath = ""): PluginFile[] {
  const files: PluginFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      files.push(...collectPluginFiles(fullPath, relativePath));
      continue;
    }

    if (!TEXT_FILE_EXTENSIONS.has(extname(entry.name))) continue;
    files.push({
      path: relativePath,
      content: readFileSync(fullPath, "utf8"),
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
