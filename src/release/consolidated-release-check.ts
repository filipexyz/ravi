import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_VERSION = "3.260714.2";
const EXPECTED_SOURCE_COMMIT = "5ea4f0be15fd8b021f86f6c2b89b0af9abdcc267";
const EXPECTED_SOURCE_TREE = "d3152a562c16e38291063ea8a10a226b0b12b832";
const EXPECTED_TARBALL_SHA256 = "b428341c6bf0716933210f71b445aea86434de24e5e123cd4a6161f9fad74f67";
const EXPECTED_BUNDLE_DEBUG_ID = "41D6D84D3D7F5BA364756E2164756E21";

const EXPECTED_HEAD_DELTA_PATHS = ["src/release/consolidated-release-check.ts"] as const;

export const EXPECTED_PACKAGE_FILE_SHA256: Readonly<Record<string, string>> = {
  "README.md": "0fcda32e8f55e3baef318b0e9fca30dc28c1a46f374accaac4da613d490b9a9e",
  "bin/ravi": "6084ed621b1c175966faf45bb19e3f9f444e20fa8d25a8daf51d656ce45e454e",
  "dist/bundle/index.js": "d9c78c7a6e8f81f7934045b01aadbcfd445e1bfa28037c6e6fe017b94da5e962",
  "dist/bundle/index.js.map": "7562b8f22e7848effe2ec6f595487f4aa791ca48c993052e49d4dc42bb511ed8",
  "dist/bundle/internal-plugins.json": "2f3c0bb778872f5ddf18503872851419b7480db07cca38168e6fa53cbdff1057",
  "dist/tui/index.js": "7aed0e4bb11d70f27931f700c846e9ac93189f6f0ae15d57b2da1aa53df2e166",
  "dist/tui/index.js.map": "84db5ffd39c452dc0960e223b934a9a6fa0441c01082c9f8bb406fb4fd01c3be",
  "package.json": "56eb5fa810de8ddb413ca48b2287a11de55961bd4c59588243264aeda9f7bb0d",
};

export const EXPECTED_PACKAGE_FILES = [
  "README.md",
  "bin/ravi",
  "dist/bundle/index.js",
  "dist/bundle/index.js.map",
  "dist/bundle/internal-plugins.json",
  "dist/tui/index.js",
  "dist/tui/index.js.map",
  "package.json",
] as const;

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
      {
        path: "src/runtime/host-event-loop.ts",
        tokens: ["cadenceDeferredForRuntimeTarget", "pendingTaskQuota", "noteTerminalTurnForCadence"],
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
        path: "src/runtime/host-event-loop.ts",
        tokens: ["taskQuotaTaskId", "pendingTaskQuota", "runtime_target_switch"],
      },
      {
        path: "src/runtime/session-launcher.ts",
        tokens: ["runtime.target.exhausted", "pendingTaskQuota", "blockTaskForProviderQuota"],
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
  files: Map<string, string>;
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
  packageSha256: string;
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
  // biome-ignore lint/correctness/noUndeclaredVariables: Bun runtime global
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

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertContains(content: string, token: string, subject: string): void {
  if (!content.includes(token)) fail(`${subject} is missing required evidence: ${token}`);
}

function readTarEntry(tarball: string, entry: string, projectRoot: string): string {
  return requireSuccessful(["tar", "-xOzf", tarball, entry], projectRoot);
}

export function assertExactTarballEntries(entries: string[]): void {
  const normalizedEntries = entries.filter(Boolean).sort();
  const expectedEntries = EXPECTED_PACKAGE_FILES.map((path) => `package/${path}`).sort();
  if (
    normalizedEntries.length !== expectedEntries.length ||
    normalizedEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    const missing = expectedEntries.filter((entry) => !normalizedEntries.includes(entry));
    const unexpected = normalizedEntries.filter((entry) => !expectedEntries.includes(entry));
    fail(
      `tarball file set diverges from the release contract (missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"})`,
    );
  }
}

function readArtifact(artifactPath: string, projectRoot: string): ArtifactContent {
  if (artifactPath.endsWith(".tgz")) {
    if (!existsSync(artifactPath)) fail(`tarball not found: ${artifactPath}`);
    const tarballSha256 = sha256(readFileSync(artifactPath));
    if (tarballSha256 !== EXPECTED_TARBALL_SHA256) {
      fail(`tarball SHA-256 mismatch: expected ${EXPECTED_TARBALL_SHA256}, got ${tarballSha256}`);
    }
    const entries = requireSuccessful(["tar", "-tzf", artifactPath], projectRoot).split("\n").filter(Boolean);
    assertExactTarballEntries(entries);
    const files = new Map(
      EXPECTED_PACKAGE_FILES.map((path) => [path, readTarEntry(artifactPath, `package/${path}`, projectRoot)]),
    );
    return {
      bundle: files.get("dist/bundle/index.js") ?? fail("tarball bundle is unreadable"),
      files,
      kind: "tarball",
      packageJson: files.get("package.json") ?? fail("tarball package.json is unreadable"),
      sourceMap: files.get("dist/bundle/index.js.map") ?? fail("tarball source map is unreadable"),
    };
  }

  const packageRoot = artifactPath;
  const files = new Map<string, string>();
  for (const relativePath of EXPECTED_PACKAGE_FILES) {
    const path = resolve(packageRoot, relativePath);
    if (!existsSync(path)) fail(`package file not found: ${path}`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`package file must be a regular file: ${path}`);
    files.set(relativePath, readFileSync(path, "utf8"));
  }
  return {
    bundle: files.get("dist/bundle/index.js") ?? fail("package bundle is unreadable"),
    files,
    kind: "directory",
    packageJson: files.get("package.json") ?? fail("package.json is unreadable"),
    sourceMap: files.get("dist/bundle/index.js.map") ?? fail("package source map is unreadable"),
  };
}

export function assertPackageFilesMatchCheckout(
  files: ReadonlyMap<string, string>,
  projectRoot: string,
  expectedHashes?: Readonly<Record<string, string>>,
): string {
  const fileHashes: string[] = [];
  for (const relativePath of EXPECTED_PACKAGE_FILES) {
    const checkoutPath = resolve(projectRoot, relativePath);
    if (!existsSync(checkoutPath)) fail(`checkout release file is missing: ${relativePath}`);
    const checkoutContent = readFileSync(checkoutPath, "utf8");
    const artifactContent = files.get(relativePath) ?? fail(`artifact release file is missing: ${relativePath}`);
    if (artifactContent !== checkoutContent) fail(`artifact release file diverges from checkout: ${relativePath}`);
    const artifactSha256 = sha256(artifactContent);
    const expectedSha256 = expectedHashes?.[relativePath];
    if (expectedHashes && !expectedSha256) fail(`release contract omits package file hash: ${relativePath}`);
    if (expectedSha256 && artifactSha256 !== expectedSha256) {
      fail(`package file SHA-256 mismatch for ${relativePath}: expected ${expectedSha256}, got ${artifactSha256}`);
    }
    fileHashes.push(`${relativePath}\0${artifactSha256}`);
  }
  return sha256(fileHashes.join("\n"));
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
  const parent = requireSuccessful(["git", "rev-parse", "HEAD^"], projectRoot).trim();
  if (parent !== EXPECTED_SOURCE_COMMIT) {
    fail(`release gate must be the direct child of source commit ${EXPECTED_SOURCE_COMMIT}; got parent ${parent}`);
  }
  const sourceTree = requireSuccessful(["git", "rev-parse", `${EXPECTED_SOURCE_COMMIT}^{tree}`], projectRoot).trim();
  if (sourceTree !== EXPECTED_SOURCE_TREE) {
    fail(`source tree mismatch: expected ${EXPECTED_SOURCE_TREE}, got ${sourceTree}`);
  }
  const changedPaths = requireSuccessful(
    ["git", "diff", "--no-renames", "--name-only", EXPECTED_SOURCE_COMMIT, head, "--"],
    projectRoot,
  )
    .split("\n")
    .filter(Boolean)
    .sort();
  const expectedDeltaPaths = [...EXPECTED_HEAD_DELTA_PATHS].sort();
  if (changedPaths.join("\n") !== expectedDeltaPaths.join("\n")) {
    fail(
      `release gate delta is not exact: expected ${expectedDeltaPaths.join(", ")}; got ${changedPaths.join(", ") || "none"}`,
    );
  }
  const includedCommits: string[] = [];
  for (const commit of REQUIRED_COMMITS) {
    const result = run(["git", "merge-base", "--is-ancestor", commit.id, EXPECTED_SOURCE_COMMIT], projectRoot);
    if (result.exitCode !== 0) fail(`source commit omits ${commit.label}: ${commit.id}`);
    includedCommits.push(commit.id);
  }
  for (const commit of EXCLUDED_COMMITS) {
    const known = run(["git", "cat-file", "-e", `${commit.id}^{commit}`], projectRoot);
    if (known.exitCode !== 0) fail(`cannot verify explicitly excluded ${commit.label}: ${commit.id}`);
    const result = run(["git", "merge-base", "--is-ancestor", commit.id, EXPECTED_SOURCE_COMMIT], projectRoot);
    if (result.exitCode === 0) fail(`source commit contains explicitly excluded ${commit.label}: ${commit.id}`);
    if (result.exitCode > 1) fail(`could not verify excluded commit ${commit.id}: ${result.stderr.trim()}`);
  }
  return { head, includedCommits };
}

function parseSourceMap(sourceMapText: string): { debugId: string; sources: string[]; sourcesContent: string[] } {
  const parsed = JSON.parse(sourceMapText) as { debugId?: unknown; sources?: unknown; sourcesContent?: unknown };
  if (typeof parsed.debugId !== "string" || !/^[0-9A-F]{32}$/.test(parsed.debugId)) {
    fail("bundle source map has no valid debugId");
  }
  if (!Array.isArray(parsed.sources) || !parsed.sources.every((value) => typeof value === "string")) {
    fail("bundle source map has no valid sources array");
  }
  if (!Array.isArray(parsed.sourcesContent) || !parsed.sourcesContent.every((value) => typeof value === "string")) {
    fail("bundle source map has no complete sourcesContent array");
  }
  if (parsed.sources.length !== parsed.sourcesContent.length) fail("bundle source map source/content counts diverge");
  return { debugId: parsed.debugId, sources: parsed.sources, sourcesContent: parsed.sourcesContent };
}

export function assertBundleMapBinding(bundle: string, sourceMapDebugId: string, expectedDebugId: string): void {
  const debugIds = [...bundle.matchAll(/^\/\/# debugId=([0-9A-F]{32})$/gm)].map((match) => match[1]);
  if (debugIds.length !== 1) fail(`bundle must contain exactly one debugId, got ${debugIds.length}`);
  const bundleDebugId = debugIds[0];
  if (bundleDebugId !== sourceMapDebugId) {
    fail(`bundle/source map debugId mismatch: bundle ${bundleDebugId}, map ${sourceMapDebugId}`);
  }
  if (bundleDebugId !== expectedDebugId) {
    fail(`release debugId mismatch: expected ${expectedDebugId}, got ${bundleDebugId}`);
  }
  const sourceMapUrls = [...bundle.matchAll(/^\/\/# sourceMappingURL=(.+)$/gm)].map((match) => match[1]);
  if (sourceMapUrls.length !== 1 || sourceMapUrls[0] !== "index.js.map") {
    fail(`bundle must reference exactly index.js.map, got ${sourceMapUrls.join(", ") || "none"}`);
  }
}

function normalizeMappedProjectSource(source: string): string | null {
  let normalized = source.replaceAll("\\", "/");
  while (normalized.startsWith("../")) normalized = normalized.slice(3);
  if (!normalized.startsWith("src/") || normalized.includes("/../")) return null;
  return normalized;
}

export function assertMappedSourcesMatchCheckout(
  sourceMap: { sources: string[]; sourcesContent: string[] },
  projectRoot: string,
): void {
  let mappedProjectSources = 0;
  for (let index = 0; index < sourceMap.sources.length; index += 1) {
    const sourcePath = normalizeMappedProjectSource(sourceMap.sources[index]);
    if (!sourcePath) continue;
    mappedProjectSources += 1;
    const checkoutPath = resolve(projectRoot, sourcePath);
    if (!existsSync(checkoutPath)) fail(`mapped checkout source is missing: ${sourcePath}`);
    if (readFileSync(checkoutPath, "utf8") !== sourceMap.sourcesContent[index]) {
      fail(`mapped source diverges from checkout: ${sourcePath}`);
    }
  }
  if (mappedProjectSources === 0) fail("bundle source map contains no checkout sources");
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
  const packageSha256 = assertPackageFilesMatchCheckout(artifact.files, projectRoot, EXPECTED_PACKAGE_FILE_SHA256);
  const packageJson = JSON.parse(artifact.packageJson) as { name?: string; version?: string };
  if (packageJson.name !== "ravi.bot") fail(`unexpected package name: ${packageJson.name ?? "missing"}`);
  if (packageJson.version !== EXPECTED_VERSION) {
    fail(`candidate version must be ${EXPECTED_VERSION}, got ${packageJson.version ?? "missing"}`);
  }
  const sourceMap = parseSourceMap(artifact.sourceMap);
  assertBundleMapBinding(artifact.bundle, sourceMap.debugId, EXPECTED_BUNDLE_DEBUG_ID);
  assertMappedSourcesMatchCheckout(sourceMap, projectRoot);
  for (const feature of REQUIRED_FEATURES) verifyFeatureEvidence(feature, artifact, sourceMap, projectRoot);
  return {
    artifact: artifactPath,
    bundleSha256: sha256(artifact.bundle),
    features: REQUIRED_FEATURES.map((feature) => feature.id),
    head,
    includedCommits,
    kind: artifact.kind,
    ok: true,
    packageSha256,
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

export async function runConsolidatedReleaseCheckCli(
  // biome-ignore lint/correctness/noUndeclaredVariables: Bun runtime global
  argv: string[] = Bun.argv.slice(2),
  projectRoot = resolve(import.meta.dir, "../.."),
): Promise<void> {
  const args = parseArgs(argv);
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
    console.log(`Package SHA-256: ${result.packageSha256}`);
    console.log(`Features: ${result.features.join(", ")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (args.json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    else console.error(`Consolidated release blocked: ${message}`);
    process.exitCode = 1;
  }
}
