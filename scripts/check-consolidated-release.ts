#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_VERSION = "3.260714.1";

const REQUIRED_COMMITS = [
  { id: "ea07c838c34aef25bf71948d46e901416cf8ede6", label: "durable learning loops" },
  { id: "953a4162d754ca230d8c64fb1e3e5770e47ecad2", label: "CRM public read" },
  { id: "af8fc53f60071e3eea5722500a917f79007021a9", label: "safe reading-list and Pi" },
  { id: "0bb3f8660998c05c80f572949d5db4fdf35d0699", label: "runtime target failover" },
] as const;

const EXCLUDED_COMMITS = [
  { id: "f1571f1523103280b6d2c949a526d6e3ba9fa809", label: "rejected provenance guard" },
] as const;

type SourceEvidence = {
  path: string;
  tokens: string[];
};

type FeatureEvidence = {
  id: string;
  bundleTokens: string[];
  sources: SourceEvidence[];
};

const REQUIRED_FEATURES: FeatureEvidence[] = [
  {
    id: "learning-loop",
    bundleTokens: ["learningLoopCadence", "learning loop terminal tick"],
    sources: [
      {
        path: "src/runtime/learning-loop-cadence.ts",
        tokens: ["noteTerminalTurnForLearningLoop", "advanceLearningLoopCadenceState", "learning loop terminal tick"],
      },
    ],
  },
  {
    id: "pi-hookless-full-access",
    bundleTokens: ["provider-native", "restricted tool access"],
    sources: [
      {
        path: "src/runtime/host-services.ts",
        tokens: [
          "resolveScopedTurnToolAccessMode",
          "providerCannotEnforceRestriction",
          "agentHasGrantedFullToolAuthority",
        ],
      },
      {
        path: "src/runtime/session-launcher.ts",
        tokens: ["resolveScopedTurnToolAccessMode(runtimeCapabilities, agent.id)"],
      },
    ],
  },
  {
    id: "crm-public-read",
    bundleTokens: ["getAllContactAccessRecords", "readableContactIds"],
    sources: [
      {
        path: "src/cli/commands/crm.ts",
        tokens: ["listReadableCrmContactIds", "readableContactIds: listReadableCrmContactIds()"],
      },
      {
        path: "src/contacts.ts",
        tokens: ["getAllContactAccessRecords", "addReadableContactIdsFilter"],
      },
    ],
  },
  {
    id: "safe-reading-list",
    bundleTokens: ["unsafe_any_with_negative", "readableContactIds"],
    sources: [
      {
        path: "src/chats/reading-lists.ts",
        tokens: ["unsafe_any_with_negative", "previewChatReadingListMembers", "recomputeChatReadingListMembers"],
      },
      {
        path: "src/cli/commands/chats.ts",
        tokens: ["previewChatReadingListMembers(list)", "recomputeChatReadingListMembers(list)"],
      },
    ],
  },
  {
    id: "runtime-target-failover",
    bundleTokens: ["RuntimeTargetsCommands", "runtime.targets"],
    sources: [
      {
        path: "src/runtime/target-policy.ts",
        tokens: ["selectRuntimeTarget", "decideRuntimeTargetFailure", "classifyRuntimeTargetFailure"],
      },
      {
        path: "src/cli/commands/runtime-targets.ts",
        tokens: ['name: "runtime.targets"', "export class RuntimeTargetsCommands"],
      },
    ],
  },
];

type ArtifactContent = {
  bundle: string;
  kind: "directory" | "tarball";
  packageJson: string;
  sourceMap: string;
};

type GateResult = {
  artifact: string;
  bundleSha256: string;
  features: string[];
  head: string;
  includedCommits: string[];
  kind: ArtifactContent["kind"];
  ok: true;
  sourceMapSha256: string;
  version: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function textOutput(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function run(command: string[], cwd: string): { exitCode: number; stderr: string; stdout: string } {
  const result = Bun.spawnSync({ cmd: command, cwd, stderr: "pipe", stdout: "pipe" });
  return {
    exitCode: result.exitCode,
    stderr: textOutput(result.stderr),
    stdout: textOutput(result.stdout),
  };
}

function requireSuccessful(command: string[], cwd: string): string {
  const result = run(command, cwd);
  if (result.exitCode !== 0) {
    fail(`${command.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertContains(content: string, token: string, subject: string): void {
  if (!content.includes(token)) fail(`${subject} is missing required evidence: ${token}`);
}

function readTarEntry(tarball: string, entry: string, projectRoot: string): string {
  return requireSuccessful(["tar", "-xOzf", tarball, entry], projectRoot);
}

function readArtifact(artifactPath: string, projectRoot: string): ArtifactContent {
  if (artifactPath.endsWith(".tgz")) {
    if (!existsSync(artifactPath)) fail(`tarball not found: ${artifactPath}`);
    const entries = requireSuccessful(["tar", "-tzf", artifactPath], projectRoot).split("\n");
    for (const entry of ["package/package.json", "package/dist/bundle/index.js", "package/dist/bundle/index.js.map"]) {
      if (!entries.includes(entry)) fail(`tarball is missing required entry: ${entry}`);
    }
    return {
      bundle: readTarEntry(artifactPath, "package/dist/bundle/index.js", projectRoot),
      kind: "tarball",
      packageJson: readTarEntry(artifactPath, "package/package.json", projectRoot),
      sourceMap: readTarEntry(artifactPath, "package/dist/bundle/index.js.map", projectRoot),
    };
  }

  const packageRoot = artifactPath;
  const paths = {
    bundle: resolve(packageRoot, "dist/bundle/index.js"),
    packageJson: resolve(packageRoot, "package.json"),
    sourceMap: resolve(packageRoot, "dist/bundle/index.js.map"),
  };
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path)) fail(`${name} not found: ${path}`);
  }
  return {
    bundle: readFileSync(paths.bundle, "utf8"),
    kind: "directory",
    packageJson: readFileSync(paths.packageJson, "utf8"),
    sourceMap: readFileSync(paths.sourceMap, "utf8"),
  };
}

function assertCleanTrackedTree(projectRoot: string): void {
  for (const args of [
    ["git", "diff", "--quiet", "--"],
    ["git", "diff", "--cached", "--quiet", "--"],
  ]) {
    const result = run(args, projectRoot);
    if (result.exitCode === 1) fail("tracked source tree is dirty; commit or revert changes before packaging");
    if (result.exitCode !== 0) fail(`${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
}

function assertCommitSet(projectRoot: string): { head: string; includedCommits: string[] } {
  const head = requireSuccessful(["git", "rev-parse", "HEAD"], projectRoot).trim();
  const includedCommits: string[] = [];
  for (const commit of REQUIRED_COMMITS) {
    const result = run(["git", "merge-base", "--is-ancestor", commit.id, head], projectRoot);
    if (result.exitCode !== 0) fail(`HEAD omits ${commit.label}: ${commit.id}`);
    includedCommits.push(commit.id);
  }
  for (const commit of EXCLUDED_COMMITS) {
    const known = run(["git", "cat-file", "-e", `${commit.id}^{commit}`], projectRoot);
    if (known.exitCode !== 0) continue;
    const result = run(["git", "merge-base", "--is-ancestor", commit.id, head], projectRoot);
    if (result.exitCode === 0) fail(`HEAD contains explicitly excluded ${commit.label}: ${commit.id}`);
    if (result.exitCode > 1) fail(`could not verify excluded commit ${commit.id}: ${result.stderr.trim()}`);
  }
  return { head, includedCommits };
}

function parseSourceMap(sourceMapText: string): { sources: string[]; sourcesContent: string[] } {
  const parsed = JSON.parse(sourceMapText) as { sources?: unknown; sourcesContent?: unknown };
  if (!Array.isArray(parsed.sources) || !parsed.sources.every((value) => typeof value === "string")) {
    fail("bundle source map has no valid sources array");
  }
  if (!Array.isArray(parsed.sourcesContent) || !parsed.sourcesContent.every((value) => typeof value === "string")) {
    fail("bundle source map has no complete sourcesContent array");
  }
  if (parsed.sources.length !== parsed.sourcesContent.length) fail("bundle source map source/content counts diverge");
  return { sources: parsed.sources, sourcesContent: parsed.sourcesContent };
}

function verifyFeatureEvidence(
  feature: FeatureEvidence,
  artifact: ArtifactContent,
  sourceMap: { sources: string[]; sourcesContent: string[] },
  projectRoot: string,
): void {
  for (const token of feature.bundleTokens) assertContains(artifact.bundle, token, `${feature.id} bundle`);
  for (const source of feature.sources) {
    const sourceIndex = sourceMap.sources.findIndex(
      (candidate) => candidate === source.path || candidate.endsWith(`/${source.path}`),
    );
    if (sourceIndex < 0) fail(`${feature.id} source is absent from the packaged source map: ${source.path}`);
    const packagedSource = sourceMap.sourcesContent[sourceIndex];
    const currentSourcePath = resolve(projectRoot, source.path);
    if (!existsSync(currentSourcePath)) fail(`current source is missing: ${source.path}`);
    const currentSource = readFileSync(currentSourcePath, "utf8");
    if (packagedSource !== currentSource) fail(`${feature.id} packaged source is stale or divergent: ${source.path}`);
    for (const token of source.tokens) assertContains(packagedSource, token, `${feature.id} source ${source.path}`);
  }
}

export function checkConsolidatedRelease(projectRoot: string, artifactPath: string): GateResult {
  assertCleanTrackedTree(projectRoot);
  const { head, includedCommits } = assertCommitSet(projectRoot);
  const artifact = readArtifact(artifactPath, projectRoot);
  const packageJson = JSON.parse(artifact.packageJson) as { name?: string; version?: string };
  if (packageJson.name !== "ravi.bot") fail(`unexpected package name: ${packageJson.name ?? "missing"}`);
  if (packageJson.version !== EXPECTED_VERSION) {
    fail(`candidate version must be ${EXPECTED_VERSION}, got ${packageJson.version ?? "missing"}`);
  }
  assertContains(artifact.bundle, "sourceMappingURL=index.js.map", "bundle");
  const sourceMap = parseSourceMap(artifact.sourceMap);
  for (const feature of REQUIRED_FEATURES) verifyFeatureEvidence(feature, artifact, sourceMap, projectRoot);
  return {
    artifact: artifactPath,
    bundleSha256: sha256(artifact.bundle),
    features: REQUIRED_FEATURES.map((feature) => feature.id),
    head,
    includedCommits,
    kind: artifact.kind,
    ok: true,
    sourceMapSha256: sha256(artifact.sourceMap),
    version: packageJson.version,
  };
}

function parseArgs(args: string[]): { artifactPath: string; json: boolean } {
  let artifactPath = ".";
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--artifact") {
      const value = args[index + 1];
      if (!value) fail("--artifact requires a package directory or .tgz path");
      artifactPath = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  return { artifactPath: resolve(process.cwd(), artifactPath), json };
}

async function main(): Promise<void> {
  const projectRoot = resolve(import.meta.dir, "..");
  const args = parseArgs(Bun.argv.slice(2));
  try {
    const result = checkConsolidatedRelease(projectRoot, args.artifactPath);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`Consolidated release OK: ${result.version} ${result.head.slice(0, 12)}`);
    console.log(`Artifact: ${result.kind} ${result.artifact}`);
    console.log(`Bundle SHA-256: ${result.bundleSha256}`);
    console.log(`Source map SHA-256: ${result.sourceMapSha256}`);
    console.log(`Features: ${result.features.join(", ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(`Consolidated release blocked: ${message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
