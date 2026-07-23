import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { file as bunFile } from "bun";
import { ConsoleApiClient, getMeWithAutoRefresh, normalizeConsoleUrl } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import { deleteCloudCredentials, readCloudCredentials, writeCloudCredentials } from "../cloud-auth/storage.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import {
  createArtifact,
  createArtifactPackage,
  listArtifactEvents,
  getArtifactDetails,
  getArtifactVersion,
  recordArtifactPublishState,
  type ArtifactEvent,
  type ArtifactRecord,
  type ArtifactVersion,
  type ArtifactVersionAsset,
} from "./store.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
type HeaderMap = Record<string, string>;
type ArtifactPackageSource =
  | { target: "directory" | "file" }
  | { target: "local_artifact"; artifactId: string; versionId: string; versionNumber: number };

const LOCAL_ARTIFACT_ID_PATTERN = /^art_[a-z0-9]+_[a-z0-9]+$/;

export type PublishVisibility = "public" | "private" | "protected_link";

export interface ArtifactPublishOptions {
  project?: string;
  site?: string;
  route?: string;
  visibility?: string;
  console?: string;
  uploadSession?: string;
  idempotencyKey?: string;
  name?: string;
  slug?: string;
  description?: string;
  entrypoint?: string;
  artifactVersion?: number;
  basePath?: string;
  assetBase?: string;
  activate?: boolean;
  replaceRelease?: boolean;
  reason?: string;
  tool?: string;
  publishToPages?: boolean;
  json?: boolean;
}

export interface ArtifactReleaseActivateOptions {
  site?: string;
  release?: string;
  artifactVersion?: number;
  console?: string;
  json?: boolean;
}

export interface ArtifactPublishDeps {
  client?: ConsoleApiClient;
  fetch?: FetchLike;
  readCredentials?: typeof readCloudCredentials;
  writeCredentials?: typeof writeCloudCredentials;
  deleteCredentials?: typeof deleteCloudCredentials;
}

export interface PackageManifestFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
  stagingKey?: string | null;
}

export interface PackageManifest {
  entrypoint?: string;
  basePath?: string;
  assetBase?: string;
  files: PackageManifestFile[];
}

export interface BuiltPackageManifest {
  rootPath: string;
  isDirectory: boolean;
  manifest: PackageManifest;
  files: Array<PackageManifestFile & { absolutePath: string }>;
  source: ArtifactPackageSource;
  artifactDefaults: {
    name: string;
    description: string | null;
    localArtifactId: string | null;
  };
}

export interface ArtifactPublishResult {
  success: true;
  consoleUrl: string;
  authenticated: true;
  uploadSession: unknown;
  upload: {
    attempted: number;
    skipped: number;
  };
  artifact: unknown;
  artifactVersion: unknown;
  site: unknown;
  publish: unknown;
  release: unknown;
  routes: unknown[];
  url: string | null;
  localSync: LocalPublishSyncResult;
}

export interface ArtifactReleaseActivateResult {
  success: true;
  consoleUrl: string;
  authenticated: true;
  site: unknown;
  release: unknown;
  routes: unknown[];
  url: string | null;
  localSync: LocalReleaseActivationSyncResult;
}

export type LocalPublishSyncResult =
  | { status: "skipped"; reason: "package_source" }
  | { status: "recorded"; artifactId: string; versionId: string; versionNumber: number; eventType: "published" }
  | { status: "failed"; artifactId: string; versionId: string; versionNumber: number; error: string };

export type LocalReleaseActivationSyncResult =
  | {
      status: "recorded";
      artifactId: string;
      versionId?: string;
      versionNumber?: number;
      eventType: "release_activated";
    }
  | {
      status: "failed";
      artifactId: string;
      versionId?: string;
      versionNumber?: number;
      error: string;
    };

export async function publishArtifactToConsole(
  target: string,
  options: ArtifactPublishOptions = {},
  deps: ArtifactPublishDeps = {},
): Promise<ArtifactPublishResult> {
  const credentials = requireStoredCredentials((deps.readCredentials ?? readCloudCredentials)(), options.console);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const auth = await getMeWithAutoRefresh({
    client,
    credentials,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });

  const publishOptions = normalizePublishOptions(options);
  if (!publishOptions.uploadSession && !publishOptions.project) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Missing --project. Console upload sessions require a project ref.");
  }

  const publishTarget = await preparePublishTarget(target, publishOptions);
  const packageBuild = await buildArtifactPackageManifest(publishTarget, publishOptions);
  const uploadSessionId = publishOptions.uploadSession;
  const uploadSessionResult = uploadSessionId
    ? { uploadSession: { id: uploadSessionId }, uploadPolicy: { directUpload: false } }
    : await client.createPageUploadSession(
        {
          projectRef: publishOptions.project as string,
          siteRef: publishOptions.site ?? null,
          idempotencyKey: publishOptions.idempotencyKey ?? null,
          packageManifest: packageBuild.manifest,
        },
        auth.credentials.accessToken,
      );

  const sessionRecord = objectValue(uploadSessionResult.uploadSession);
  const resolvedUploadSessionId = stringValue(sessionRecord?.id);
  if (!resolvedUploadSessionId) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Console did not return an upload session id.");
  }

  const uploadPolicy = objectValue(uploadSessionResult.uploadPolicy) ?? {};
  const stagingPrefix = stringValue(uploadPolicy.stagingPrefix) ?? stringValue(sessionRecord?.stagingPrefix);
  const manifest = withUploadPolicyStagingKeys(packageBuild.manifest, uploadPolicy, stagingPrefix);
  const files = packageBuild.files.map((file) => ({
    ...file,
    stagingKey: manifest.files.find((item) => item.path === file.path)?.stagingKey ?? null,
  }));

  const upload = await uploadPackageFiles({
    fetch: deps.fetch,
    files,
    uploadPolicy,
  });

  const shouldPublishPage = Boolean(publishOptions.publishToPages || publishOptions.site);
  const finalizePayload = await client.finalizeArtifactPublish(
    {
      uploadSessionId: resolvedUploadSessionId,
      idempotencyKey: publishOptions.idempotencyKey ?? null,
      artifact: {
        name: publishOptions.name ?? packageBuild.artifactDefaults.name,
        slug: publishOptions.slug ?? null,
        description: publishOptions.description ?? packageBuild.artifactDefaults.description,
        localArtifactId: packageBuild.artifactDefaults.localArtifactId,
      },
      packageManifest: manifest,
      ...(shouldPublishPage
        ? {
            publish: {
              ...(publishOptions.site ? { siteRef: publishOptions.site } : {}),
              activate: publishOptions.activate !== false,
              replaceRelease: Boolean(publishOptions.replaceRelease),
              reason: publishOptions.reason ?? null,
              visibility: publishOptions.visibility,
              route: {
                path: publishOptions.route ?? "/",
                visibility: publishOptions.visibility,
              },
            },
          }
        : {}),
      source: {
        tool: publishOptions.tool ?? "ravi artifacts publish",
        ...packageBuild.source,
      },
    },
    auth.credentials.accessToken,
  );

  const payload = objectValue(finalizePayload) ?? {};
  const result: ArtifactPublishResult = {
    success: true,
    consoleUrl: credentials.consoleUrl,
    authenticated: true,
    uploadSession: publicUploadSessionResult(uploadSessionResult.uploadSession),
    upload,
    artifact: payload.artifact ?? null,
    artifactVersion: payload.artifactVersion ?? null,
    site: payload.site ?? null,
    publish: payload.publish ?? null,
    release: payload.release ?? null,
    routes: Array.isArray(payload.routes) ? payload.routes : [],
    url: extractPublishedUrl(payload),
    localSync: { status: "skipped", reason: "package_source" },
  };
  result.localSync = recordLocalPublishSync({
    packageBuild,
    publishOptions,
    result,
    uploadSessionId: resolvedUploadSessionId,
  });
  return result;
}

async function preparePublishTarget(target: string, options: ArtifactPublishOptions): Promise<string> {
  if (isLocalArtifactId(target)) return target;

  const rootPath = resolve(target);
  let originalStat: Awaited<ReturnType<typeof lstat>>;
  try {
    originalStat = await lstat(rootPath);
  } catch {
    return target;
  }
  if (originalStat.isSymbolicLink()) return target;

  const rootRealPath = await realpath(rootPath);
  const rootStat = await lstat(rootRealPath);
  if (rootStat.isDirectory()) {
    const result = createArtifactPackage({
      rootPath: rootRealPath,
      artifact: {
        title: options.name ?? defaultArtifactName(target),
        ...(options.description ? { summary: options.description } : {}),
      },
      ...(options.entrypoint ? { entrypoint: options.entrypoint } : {}),
      ...(options.basePath ? { basePath: options.basePath } : {}),
      ...(options.assetBase ? { assetBase: options.assetBase } : {}),
    });
    return result.artifact.id;
  }

  if (rootStat.isFile()) {
    const artifact = createArtifact({
      title: options.name ?? defaultArtifactName(target),
      ...(options.description ? { summary: options.description } : {}),
      filePath: rootRealPath,
    });
    return artifact.id;
  }

  return target;
}

export async function activateArtifactReleaseInConsole(
  artifactId: string,
  options: ArtifactReleaseActivateOptions = {},
  deps: ArtifactPublishDeps = {},
): Promise<ArtifactReleaseActivateResult> {
  const credentials = requireStoredCredentials((deps.readCredentials ?? readCloudCredentials)(), options.console);
  const client = deps.client ?? new ConsoleApiClient({ consoleUrl: credentials.consoleUrl });
  const auth = await getMeWithAutoRefresh({
    client,
    credentials,
    write: deps.writeCredentials ?? writeCloudCredentials,
    delete: deps.deleteCredentials ?? deleteCloudCredentials,
  });

  const selection = resolvePublishedReleaseSelection(artifactId, options);
  const payload =
    objectValue(
      await client.activatePageSiteRelease(
        {
          siteRef: selection.siteRef,
          releaseId: selection.releaseId,
        },
        auth.credentials.accessToken,
      ),
    ) ?? {};

  const result: ArtifactReleaseActivateResult = {
    success: true,
    consoleUrl: credentials.consoleUrl,
    authenticated: true,
    site: payload.site ?? selection.summary?.site ?? null,
    release: payload.release ?? compactObject({ id: selection.releaseId, releaseNumber: selection.releaseNumber }),
    routes: Array.isArray(payload.routes) ? payload.routes : [],
    url: extractPublishedUrl(payload) ?? selection.url ?? null,
    localSync: { status: "failed", artifactId, error: "not recorded" },
  };

  result.localSync = recordLocalReleaseActivationSync({
    artifactId,
    selection,
    options,
    result,
  });
  return result;
}

export async function buildArtifactPackageManifest(
  target: string,
  options: Pick<ArtifactPublishOptions, "entrypoint" | "artifactVersion" | "basePath" | "assetBase"> = {},
): Promise<BuiltPackageManifest> {
  const rootPath = resolve(target);
  let originalStat: Awaited<ReturnType<typeof lstat>>;
  try {
    originalStat = await lstat(rootPath);
  } catch (error) {
    if (isLocalArtifactId(target) && isNotFoundError(error)) {
      return buildLocalArtifactPackageManifest(target, options);
    }
    throw new CloudAuthError("PAYLOAD_INVALID", `Artifact package target not found: ${target}`, { cause: error });
  }
  if (originalStat.isSymbolicLink()) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Refusing to publish a symlink target.");
  }
  const rootRealPath = await realpath(rootPath);
  const rootStat = await lstat(rootRealPath);

  const entries = rootStat.isDirectory()
    ? await collectDirectoryFiles(rootRealPath)
    : [{ absolutePath: rootRealPath, packagePath: basename(rootRealPath) }];

  if (entries.length === 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Artifact package is empty.");
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const fileStat = await stat(entry.absolutePath);
      const sha256 = await sha256File(entry.absolutePath);
      return {
        absolutePath: entry.absolutePath,
        path: normalizePackagePath(entry.packagePath),
        sha256,
        sizeBytes: fileStat.size,
        contentType: contentTypeFor(entry.packagePath),
      };
    }),
  );
  files.sort((left, right) => left.path.localeCompare(right.path));
  const entrypoint = options.entrypoint
    ? normalizePackagePath(options.entrypoint)
    : inferEntrypoint(files, rootStat.isDirectory());
  if (!files.some((file) => file.path === entrypoint)) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Package entrypoint is not included in files: ${entrypoint}`);
  }

  return {
    rootPath: rootRealPath,
    isDirectory: rootStat.isDirectory(),
    files,
    source: { target: rootStat.isDirectory() ? "directory" : "file" },
    artifactDefaults: {
      name: defaultArtifactName(target),
      description: null,
      localArtifactId: null,
    },
    manifest: {
      entrypoint,
      ...(options.basePath ? { basePath: options.basePath } : {}),
      ...(options.assetBase ? { assetBase: options.assetBase } : {}),
      files: files.map(({ path, sha256, sizeBytes, contentType }) => ({
        path,
        sha256,
        sizeBytes,
        contentType,
      })),
    },
  };
}

export function normalizePublishOptions(options: ArtifactPublishOptions): ArtifactPublishOptions {
  const consoleUrl = options.console ? normalizeConsoleUrl(options.console) : undefined;
  const visibility = options.visibility ? normalizeVisibility(options.visibility) : undefined;
  const route = options.route ? normalizeRoutePath(options.route) : undefined;
  const artifactVersion = normalizeArtifactVersionNumber(options.artifactVersion);
  return {
    ...options,
    console: consoleUrl,
    visibility,
    route,
    artifactVersion,
  };
}

async function buildLocalArtifactPackageManifest(
  artifactId: string,
  options: Pick<ArtifactPublishOptions, "entrypoint" | "artifactVersion" | "basePath" | "assetBase">,
): Promise<BuiltPackageManifest> {
  const details = getArtifactDetails(artifactId);
  if (!details) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Local artifact not found: ${artifactId}`);
  }

  const version = getArtifactVersion(artifactId, options.artifactVersion);
  if (!version) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `Local artifact version not found: ${artifactId}${options.artifactVersion ? ` v${options.artifactVersion}` : ""}`,
    );
  }

  const files = await buildLocalArtifactFiles(version);
  const manifestEntrypoint = stringValue(version.manifest.entrypoint);
  const entrypoint = options.entrypoint
    ? normalizePackagePath(options.entrypoint)
    : manifestEntrypoint
      ? normalizePackagePath(manifestEntrypoint)
      : inferEntrypoint(files, files.length > 1);
  if (!files.some((file) => file.path === entrypoint)) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Package entrypoint is not included in files: ${entrypoint}`);
  }

  return {
    rootPath: artifactId,
    isDirectory: files.length > 1,
    files,
    source: {
      target: "local_artifact",
      artifactId,
      versionId: version.id,
      versionNumber: version.versionNumber,
    },
    artifactDefaults: {
      name: defaultLocalArtifactName(details.artifact),
      description: details.artifact.summary ?? null,
      localArtifactId: artifactId,
    },
    manifest: {
      entrypoint,
      ...(options.basePath ? { basePath: options.basePath } : {}),
      ...(options.assetBase ? { assetBase: options.assetBase } : {}),
      files: files.map(({ path, sha256, sizeBytes, contentType }) => ({
        path,
        sha256,
        sizeBytes,
        contentType,
      })),
    },
  };
}

async function buildLocalArtifactFiles(
  version: ArtifactVersion,
): Promise<Array<PackageManifestFile & { absolutePath: string }>> {
  if (version.assets.length === 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Local artifact version has no local publishable files.");
  }

  const seenPaths = new Set<string>();
  const files: Array<PackageManifestFile & { absolutePath: string }> = [];
  for (const asset of version.assets) {
    const packagePath = normalizePackagePath(asset.path);
    if (seenPaths.has(packagePath)) {
      throw new CloudAuthError("PAYLOAD_INVALID", `Duplicate package path in local artifact version: ${packagePath}`);
    }
    seenPaths.add(packagePath);

    const absolutePath = await resolveLocalArtifactAssetPath(asset);
    const fileStat = await stat(absolutePath);
    const sha256 = await sha256File(absolutePath);
    files.push({
      absolutePath,
      path: packagePath,
      sha256,
      sizeBytes: fileStat.size,
      contentType: asset.mimeType ?? contentTypeFor(packagePath),
    });
  }

  if (files.length === 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Local artifact version has no local publishable files.");
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function resolveLocalArtifactAssetPath(asset: ArtifactVersionAsset): Promise<string> {
  const candidates = [asset.blobPath, asset.filePath].filter((item): item is string => Boolean(item?.trim()));
  if (candidates.length === 0) {
    const reason = asset.uri ? "URI-only assets cannot be published without a local file" : "Asset has no local file";
    throw new CloudAuthError("PAYLOAD_INVALID", `${reason}: ${asset.path}`);
  }

  let missing = false;
  let invalidReason: string | null = null;
  for (const candidate of candidates) {
    const absolutePath = resolve(candidate);
    try {
      const fileInfo = await lstat(absolutePath);
      if (fileInfo.isSymbolicLink()) {
        invalidReason = `Refusing to publish symlink asset: ${asset.path}`;
        continue;
      }
      if (!fileInfo.isFile()) {
        invalidReason = `Artifact version asset is not a file: ${asset.path}`;
        continue;
      }
      return realpath(absolutePath);
    } catch (error) {
      if (isNotFoundError(error)) {
        missing = true;
        continue;
      }
      invalidReason = `Unable to read local artifact asset: ${asset.path}`;
    }
  }

  if (invalidReason) {
    throw new CloudAuthError("PAYLOAD_INVALID", invalidReason);
  }
  if (missing) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Missing local file for artifact version asset: ${asset.path}`);
  }
  throw new CloudAuthError("PAYLOAD_INVALID", `Asset has no local publishable file: ${asset.path}`);
}

function requireStoredCredentials(credentials: CloudCredentials | null, consoleUrl?: string): CloudCredentials {
  if (!credentials) {
    throw new CloudAuthError("AUTH_REQUIRED", "No Ravi Cloud CLI credentials found. Run `ravi login`.");
  }
  if (consoleUrl && normalizeConsoleUrl(consoleUrl) !== credentials.consoleUrl) {
    throw new CloudAuthError(
      "AUTH_REQUIRED",
      `No Ravi Cloud CLI credentials found for ${normalizeConsoleUrl(consoleUrl)}. Run \`ravi login --console ${normalizeConsoleUrl(
        consoleUrl,
      )}\`.`,
    );
  }
  return credentials;
}

async function collectDirectoryFiles(
  rootRealPath: string,
): Promise<Array<{ absolutePath: string; packagePath: string }>> {
  const files: Array<{ absolutePath: string; packagePath: string }> = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store" || entry.name === ".git") continue;
      const absolutePath = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new CloudAuthError(
          "PAYLOAD_INVALID",
          `Refusing to publish symlink: ${relative(rootRealPath, absolutePath)}`,
        );
      }
      const resolvedPath = await realpath(absolutePath);
      assertInsideRoot(rootRealPath, resolvedPath);
      if (entry.isDirectory()) {
        await visit(resolvedPath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath: resolvedPath,
          packagePath: relative(rootRealPath, resolvedPath).split(sep).join("/"),
        });
      }
    }
  }

  await visit(rootRealPath);
  return files;
}

function withUploadPolicyStagingKeys(
  manifest: PackageManifest,
  uploadPolicy: Record<string, unknown>,
  stagingPrefix: string | null,
): PackageManifest {
  const policyStagingKeys = stagingKeysFromUploadPolicy(uploadPolicy);
  return {
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      stagingKey:
        policyStagingKeys.get(file.path) ??
        (stagingPrefix ? `${stagingPrefix.replace(/\/+$/, "")}/${file.path}` : (file.stagingKey ?? null)),
    })),
  };
}

function stagingKeysFromUploadPolicy(policy: Record<string, unknown>): Map<string, string> {
  const keys = new Map<string, string>();
  for (const source of [policy.files, policy.uploads]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) {
      const entry = objectValue(item);
      const path = stringValue(entry?.path);
      const stagingKey = stringValue(entry?.stagingKey);
      if (path && stagingKey) keys.set(path, stagingKey);
    }
  }
  return keys;
}

async function uploadPackageFiles(input: {
  fetch?: FetchLike;
  files: Array<PackageManifestFile & { absolutePath: string }>;
  uploadPolicy: Record<string, unknown>;
}): Promise<{ attempted: number; skipped: number }> {
  let attempted = 0;
  let skipped = 0;
  const directUpload = input.uploadPolicy.directUpload !== false;
  for (const file of input.files) {
    const request = uploadRequestFor(input.uploadPolicy, file);
    if (!request) {
      if (directUpload) {
        throw new CloudAuthError("PAYLOAD_INVALID", `Console did not return an upload request for ${file.path}.`);
      }
      skipped += 1;
      continue;
    }
    attempted += 1;
    const headers = new Headers(request.headers);
    if (!headers.has("content-type")) headers.set("content-type", file.contentType);
    headers.delete("content-length");
    const body = bunFile(file.absolutePath, {
      type: headers.get("content-type") ?? file.contentType,
    });
    const response = await (input.fetch ?? fetch)(request.url, {
      method: request.method,
      headers,
      body,
    });
    if (!response.ok) {
      throw new CloudAuthError("SERVER_UNAVAILABLE", `Console upload failed for ${file.path}.`, {
        status: response.status,
      });
    }
  }
  return { attempted, skipped };
}

function uploadRequestFor(
  policy: Record<string, unknown>,
  file: PackageManifestFile,
): { url: string; method: string; headers?: HeaderMap } | null {
  if (policy.directUpload === false) return null;
  const explicit = uploadEntryFor(policy, file);
  if (explicit) return explicit;

  const template = stringValue(policy.uploadUrlTemplate);
  if (template) {
    return {
      url: template
        .replaceAll("{path}", encodePath(file.path))
        .replaceAll("{stagingKey}", encodePath(file.stagingKey ?? file.path)),
      method: stringValue(policy.method) ?? "PUT",
      headers: headersValue(policy.headers),
    };
  }

  const uploadUrl = stringValue(policy.uploadUrl);
  if (!uploadUrl) return null;
  const url =
    policy.singleFile === true || !uploadUrl.endsWith("/")
      ? uploadUrl
      : `${uploadUrl}${encodePath(file.stagingKey ?? file.path)}`;
  return {
    url,
    method: stringValue(policy.method) ?? "PUT",
    headers: headersValue(policy.headers),
  };
}

function uploadEntryFor(
  policy: Record<string, unknown>,
  file: PackageManifestFile,
): { url: string; method: string; headers?: HeaderMap } | null {
  const uploadSources = [policy.files, policy.uploads];
  const candidates = [file.path, file.stagingKey].filter((item): item is string => Boolean(item));
  for (const uploads of uploadSources) {
    if (Array.isArray(uploads)) {
      for (const item of uploads) {
        const entry = objectValue(item);
        if (!entry) continue;
        const path = stringValue(entry.path) ?? stringValue(entry.stagingKey);
        if (path && candidates.includes(path)) {
          const request = uploadEntryToRequest(entry);
          if (request) return request;
        }
      }
    }
    const map = objectValue(uploads);
    if (map) {
      for (const candidate of candidates) {
        const entry = map[candidate];
        if (typeof entry === "string") return { url: entry, method: stringValue(policy.method) ?? "PUT" };
        const request = uploadEntryToRequest(objectValue(entry));
        if (request) return request;
      }
    }
  }
  return null;
}

function uploadEntryToRequest(
  entry: Record<string, unknown> | null,
): { url: string; method: string; headers?: HeaderMap } | null {
  const url = stringValue(entry?.url) ?? stringValue(entry?.uploadUrl);
  if (!url) return null;
  return {
    url,
    method: stringValue(entry?.method) ?? "PUT",
    headers: headersValue(entry?.headers),
  };
}

function publicUploadSessionResult(value: unknown): Record<string, unknown> | null {
  const session = objectValue(value);
  if (!session) return null;
  const safe: Record<string, unknown> = {};
  for (const key of ["id", "status", "expiresAt", "finalizedAt"]) {
    if (session[key] !== undefined) safe[key] = session[key];
  }
  return safe;
}

type PublishedReleaseSelection = {
  artifact: ArtifactRecord;
  event: ArtifactEvent | null;
  summary: Record<string, unknown> | null;
  siteRef: string;
  releaseId: string;
  localVersionId?: string;
  localVersionNumber?: number;
  releaseNumber?: number;
  url?: string | null;
};

function resolvePublishedReleaseSelection(
  artifactId: string,
  options: ArtifactReleaseActivateOptions,
): PublishedReleaseSelection {
  const details = getArtifactDetails(artifactId);
  if (!details) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Local artifact not found: ${artifactId}`);
  }

  const artifactVersion = normalizeArtifactVersionNumber(options.artifactVersion);
  if (artifactVersion !== undefined && !getArtifactVersion(artifactId, artifactVersion)) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Local artifact version not found: ${artifactId} v${artifactVersion}`);
  }

  const releaseOption = options.release?.trim() || undefined;
  const siteOption = options.site?.trim() || undefined;
  if (artifactVersion === undefined && !releaseOption) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      "Missing release selector. Use --version <n> or --release <id> to activate an existing Pages release.",
    );
  }

  const publishedEvents = listArtifactEvents(artifactId).filter((event) => event.eventType === "published");
  const event = findPublishedReleaseEvent(publishedEvents, { artifactVersion, releaseId: releaseOption });
  const summary = event?.payload ?? null;

  if (!event && (!releaseOption || !siteOption)) {
    const hint =
      artifactVersion !== undefined
        ? `No Pages release is recorded for ${artifactId} v${artifactVersion}. Publish that version first.`
        : "Activating an explicit release not recorded locally requires --site.";
    throw new CloudAuthError("PAYLOAD_INVALID", hint);
  }

  const site = objectValue(summary?.site);
  const remote = objectValue(summary?.remote);
  const local = objectValue(summary?.local);
  const releaseId = releaseOption ?? stringValue(remote?.releaseId);
  const siteRef = siteOption ?? stringValue(site?.ref) ?? stringValue(site?.id);
  if (!releaseId) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Published artifact metadata does not include a Console release id.");
  }
  if (!siteRef) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Published artifact metadata does not include a Console site ref.");
  }

  return {
    artifact: details.artifact,
    event: event ?? null,
    summary,
    siteRef,
    releaseId,
    ...(stringValue(local?.versionId) ? { localVersionId: stringValue(local?.versionId) as string } : {}),
    ...((numberValue(local?.versionNumber) ?? artifactVersion)
      ? { localVersionNumber: (numberValue(local?.versionNumber) ?? artifactVersion) as number }
      : {}),
    ...(numberValue(remote?.releaseNumber) ? { releaseNumber: numberValue(remote?.releaseNumber) as number } : {}),
    url: stringValue(remote?.url),
  };
}

function findPublishedReleaseEvent(
  events: ArtifactEvent[],
  input: { artifactVersion?: number; releaseId?: string },
): ArtifactEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event?.payload) continue;
    const local = objectValue(event.payload.local);
    const remote = objectValue(event.payload.remote);
    const versionMatches =
      input.artifactVersion === undefined || numberValue(local?.versionNumber) === input.artifactVersion;
    const releaseMatches = !input.releaseId || stringValue(remote?.releaseId) === input.releaseId;
    if (versionMatches && releaseMatches) {
      return event;
    }
  }
  return null;
}

function recordLocalReleaseActivationSync(input: {
  artifactId: string;
  selection: PublishedReleaseSelection;
  options: ArtifactReleaseActivateOptions;
  result: ArtifactReleaseActivateResult;
}): LocalReleaseActivationSyncResult {
  try {
    const syncedAt = new Date().toISOString();
    const summary = buildLocalReleaseActivationSummary({
      selection: input.selection,
      options: input.options,
      result: input.result,
      syncedAt,
    });
    recordArtifactPublishState(input.artifactId, {
      eventType: "release_activated",
      source: "ravi artifacts release activate",
      message: `Pages release ${input.selection.releaseId} activated`,
      payload: summary,
      metadataSummary: summary,
    });
    return {
      status: "recorded",
      artifactId: input.artifactId,
      ...(input.selection.localVersionId ? { versionId: input.selection.localVersionId } : {}),
      ...(input.selection.localVersionNumber ? { versionNumber: input.selection.localVersionNumber } : {}),
      eventType: "release_activated",
    };
  } catch (error) {
    return {
      status: "failed",
      artifactId: input.artifactId,
      ...(input.selection.localVersionId ? { versionId: input.selection.localVersionId } : {}),
      ...(input.selection.localVersionNumber ? { versionNumber: input.selection.localVersionNumber } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildLocalReleaseActivationSummary(input: {
  selection: PublishedReleaseSelection;
  options: ArtifactReleaseActivateOptions;
  result: ArtifactReleaseActivateResult;
  syncedAt: string;
}): Record<string, unknown> {
  const previous = input.selection.summary ?? {};
  const previousProject = objectValue(previous.project) ?? {};
  const previousSite = objectValue(previous.site) ?? {};
  const previousRoute = objectValue(previous.route) ?? {};
  const previousRemote = objectValue(previous.remote) ?? {};
  const previousLocal = objectValue(previous.local) ?? {};
  const site = objectValue(input.result.site);
  const release = objectValue(input.result.release);
  const routes = Array.isArray(input.result.routes) ? input.result.routes.map(summarizeRoute).filter(Boolean) : [];

  return compactObject({
    consoleUrl: input.result.consoleUrl,
    project: compactObject({
      ref: stringValue(previousProject.ref),
      id: stringValue(previousProject.id) ?? stringValue(release?.projectId),
    }),
    site: compactObject({
      ref: input.options.site ?? stringValue(previousSite.ref),
      id: stringValue(site?.id) ?? stringValue(previousSite.id) ?? stringValue(release?.siteId),
      hostname:
        stringValue(site?.defaultHostname) ?? stringValue(previousSite.hostname) ?? stringValue(release?.hostname),
    }),
    route: compactObject({
      path: stringValue(previousRoute.path) ?? routes[0]?.path ?? "/",
      visibility: stringValue(previousRoute.visibility),
      activate: true,
      replaceRelease: previousRoute.replaceRelease === true ? true : null,
    }),
    local: compactObject({
      artifactId: input.selection.artifact.id,
      versionId: stringValue(previousLocal.versionId) ?? input.selection.localVersionId,
      versionNumber: numberValue(previousLocal.versionNumber) ?? input.selection.localVersionNumber,
    }),
    remote: compactObject({
      artifactId: stringValue(previousRemote.artifactId),
      artifactSlug: stringValue(previousRemote.artifactSlug),
      artifactVersionId: stringValue(previousRemote.artifactVersionId),
      artifactVersionNumber: numberValue(previousRemote.artifactVersionNumber),
      publishId: stringValue(previousRemote.publishId),
      publishStatus: stringValue(previousRemote.publishStatus),
      releaseId: stringValue(release?.id) ?? input.selection.releaseId,
      releaseNumber: numberValue(release?.releaseNumber) ?? input.selection.releaseNumber,
      url: input.result.url ?? stringValue(previousRemote.url),
    }),
    routes: routes.length > 0 ? routes : null,
    source: {
      tool: "ravi artifacts release activate",
      target: "local_artifact",
      previousEventId: input.selection.event?.id ?? null,
    },
    syncedAt: input.syncedAt,
  });
}

function recordLocalPublishSync(input: {
  packageBuild: BuiltPackageManifest;
  publishOptions: ArtifactPublishOptions;
  result: ArtifactPublishResult;
  uploadSessionId: string;
}): LocalPublishSyncResult {
  if (input.packageBuild.source.target !== "local_artifact") {
    return { status: "skipped", reason: "package_source" };
  }

  const source = input.packageBuild.source;
  try {
    const syncedAt = new Date().toISOString();
    const summary = buildLocalPublishSummary({
      packageBuild: input.packageBuild,
      publishOptions: input.publishOptions,
      result: input.result,
      uploadSessionId: input.uploadSessionId,
      syncedAt,
    });
    recordArtifactPublishState(source.artifactId, {
      eventType: "published",
      source: "ravi artifacts publish",
      message: `Artifact version ${source.versionNumber} published`,
      payload: summary,
      metadataSummary: summary,
    });
    return {
      status: "recorded",
      artifactId: source.artifactId,
      versionId: source.versionId,
      versionNumber: source.versionNumber,
      eventType: "published",
    };
  } catch (error) {
    return {
      status: "failed",
      artifactId: source.artifactId,
      versionId: source.versionId,
      versionNumber: source.versionNumber,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildLocalPublishSummary(input: {
  packageBuild: BuiltPackageManifest;
  publishOptions: ArtifactPublishOptions;
  result: ArtifactPublishResult;
  uploadSessionId: string;
  syncedAt: string;
}): Record<string, unknown> {
  const source = input.packageBuild.source;
  if (source.target !== "local_artifact") {
    throw new Error("Local publish summary requires local artifact source.");
  }

  const artifact = objectValue(input.result.artifact);
  const artifactVersion = objectValue(input.result.artifactVersion);
  const site = objectValue(input.result.site);
  const publish = objectValue(input.result.publish);
  const release = objectValue(input.result.release);
  const routes = Array.isArray(input.result.routes) ? input.result.routes.map(summarizeRoute).filter(Boolean) : [];

  return compactObject({
    consoleUrl: input.result.consoleUrl,
    project: compactObject({
      ref: input.publishOptions.project ?? null,
      id: stringValue(artifact?.projectId) ?? stringValue(publish?.projectId) ?? stringValue(release?.projectId),
    }),
    site: compactObject({
      ref: input.publishOptions.site ?? null,
      id: stringValue(site?.id) ?? stringValue(publish?.siteId) ?? stringValue(release?.siteId),
      hostname: stringValue(site?.defaultHostname) ?? stringValue(release?.hostname) ?? stringValue(publish?.hostname),
    }),
    route: compactObject({
      path: input.publishOptions.route ?? "/",
      visibility: input.publishOptions.visibility ?? null,
      activate: input.publishOptions.activate !== false,
      replaceRelease: Boolean(input.publishOptions.replaceRelease),
    }),
    local: {
      artifactId: source.artifactId,
      versionId: source.versionId,
      versionNumber: source.versionNumber,
    },
    remote: compactObject({
      artifactId: stringValue(artifact?.id),
      artifactSlug: stringValue(artifact?.slug),
      artifactVersionId: stringValue(artifactVersion?.id),
      artifactVersionNumber: numberValue(artifactVersion?.versionNumber),
      publishId: stringValue(publish?.id),
      publishStatus: stringValue(publish?.status),
      releaseId: stringValue(release?.id),
      releaseNumber: numberValue(release?.releaseNumber),
      url: input.result.url,
    }),
    upload: compactObject({
      sessionId: input.uploadSessionId,
      attempted: input.result.upload.attempted,
      skipped: input.result.upload.skipped,
    }),
    routes: routes.length > 0 ? routes : null,
    idempotencyKeyHash: input.publishOptions.idempotencyKey
      ? `sha256:${sha256String(input.publishOptions.idempotencyKey)}`
      : null,
    packageHash: packageManifestHash(input.packageBuild.manifest),
    source: {
      tool: "ravi artifacts publish",
      target: source.target,
    },
    syncedAt: input.syncedAt,
  });
}

function summarizeRoute(value: unknown): Record<string, unknown> | null {
  const route = objectValue(value);
  if (!route) return null;
  return compactObject({
    id: stringValue(route.id),
    path: stringValue(route.path),
    matchType: stringValue(route.matchType),
    priority: numberValue(route.priority),
    visibility: stringValue(route.visibility),
    artifactId: stringValue(route.artifactId),
    artifactVersionId: stringValue(route.artifactVersionId),
    entrypoint: stringValue(route.entrypoint),
    assetBase: stringValue(route.assetBase),
  });
}

function packageManifestHash(manifest: PackageManifest): string {
  const stable = {
    entrypoint: manifest.entrypoint ?? null,
    basePath: manifest.basePath ?? null,
    assetBase: manifest.assetBase ?? null,
    files: manifest.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
    })),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function sha256String(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function normalizeVisibility(value: string): PublishVisibility {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (normalized === "public" || normalized === "private" || normalized === "protected_link") return normalized;
  throw new CloudAuthError("PAYLOAD_INVALID", "--visibility must be one of: public, private, protected_link.");
}

function normalizeArtifactVersionNumber(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new CloudAuthError("PAYLOAD_INVALID", "--artifact-version must be a positive integer.");
  }
  return value;
}

function normalizeRoutePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizePackagePath(value: string): string {
  const normalized = value.split("\\").join("/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    segments.some((part) => part === ".." || part === "." || part === "") ||
    segments.some((part) => part.startsWith(".")) ||
    segments.some((part) => part === "_ravi")
  ) {
    throw new CloudAuthError("PAYLOAD_INVALID", `Invalid package path: ${value}`);
  }
  return normalized;
}

function inferEntrypoint(files: Array<{ path: string }>, isDirectory: boolean): string {
  if (files.some((file) => file.path === "index.html")) return "index.html";
  if (!isDirectory && files.length === 1 && files[0]) return files[0].path;
  throw new CloudAuthError(
    "PAYLOAD_INVALID",
    "Missing --entrypoint. Directory packages need index.html or an explicit entrypoint.",
  );
}

function assertInsideRoot(root: string, value: string): void {
  if (value !== root && !value.startsWith(`${root}${sep}`)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Refusing to publish a path outside the artifact root.");
  }
}

function isLocalArtifactId(value: string): boolean {
  return LOCAL_ARTIFACT_ID_PATTERN.test(value);
}

function isNotFoundError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function defaultArtifactName(target: string): string {
  try {
    const path = target.startsWith("file://") ? fileURLToPath(target) : target;
    return basename(resolve(path)) || "artifact";
  } catch {
    return "artifact";
  }
}

function defaultLocalArtifactName(artifact: ArtifactRecord): string {
  return artifact.title ?? artifact.id;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function contentTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function extractPublishedUrl(payload: Record<string, unknown>): string | null {
  const candidates = [
    payload.url,
    payload.publicUrl,
    objectValue(payload.release)?.url,
    objectValue(payload.publish)?.url,
    objectValue(payload.artifactVersion)?.url,
  ];
  for (const candidate of candidates) {
    const value = stringValue(candidate);
    if (value) return value;
  }
  return null;
}

function encodePath(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function headersValue(value: unknown): HeaderMap | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  return Object.fromEntries(Object.entries(record).filter(([, item]) => typeof item === "string")) as Record<
    string,
    string
  >;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
