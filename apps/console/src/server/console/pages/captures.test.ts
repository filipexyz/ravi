import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  createPageCapture,
  type PageCaptureImageWithAsset,
  type PageCaptureRepository,
  type PageCaptureSetRecord,
  type PageCaptureWorker,
} from "./captures";

test("creates a ready thumbnail with release and artifact-version lineage", async () => {
  const harness = captureHarness();
  const capture = await createPageCapture({
    input: { path: "/docs", mode: "thumbnail", idempotencyKey: "capture-test-1" },
    projectRef: "core",
    repository: harness.repository,
    requestId: "req_capture_1",
    worker: harness.worker,
    workspace: workspace(),
    findProject: mock(async () => ({ id: PROJECT_ID })) as never,
    createSession: harness.createSession as never,
    expireSession: harness.expireSession as never,
  });

  expect(capture).toMatchObject({
    status: "ready",
    mode: "thumbnail",
    projectId: PROJECT_ID,
    siteId: SITE_ID,
    routeId: ROUTE_ID,
    releaseId: RELEASE_ID,
    sourceArtifactId: SOURCE_ARTIFACT_ID,
    sourceArtifactVersionId: SOURCE_VERSION_ID,
    images: [
      {
        sequence: 0,
        role: "thumbnail",
        width: 1440,
        height: 900,
        mimeType: "image/jpeg",
      },
    ],
  });
  expect(harness.worker.capture).toHaveBeenCalledTimes(1);
  expect(harness.createSession).toHaveBeenCalledTimes(1);
  expect(harness.expireSession).toHaveBeenCalledTimes(1);
  expect(harness.failed).toEqual([]);
});

test("returns an existing capture for the same idempotency key without rendering again", async () => {
  const harness = captureHarness();
  harness.existing = captureRecord({ status: "ready", idempotencyKey: "capture-existing" });

  const capture = await createPageCapture({
    input: { path: "/", idempotencyKey: "capture-existing" },
    projectRef: "core",
    repository: harness.repository,
    requestId: "req_capture_2",
    worker: harness.worker,
    workspace: workspace(),
    findProject: mock(async () => ({ id: PROJECT_ID })) as never,
    createSession: harness.createSession as never,
    expireSession: harness.expireSession as never,
  });

  expect(capture.id).toBe(harness.existing!.id);
  expect(harness.worker.capture).not.toHaveBeenCalled();
  expect(harness.createSession).not.toHaveBeenCalled();
});

test("rejects future segmented capture mode until the executor is implemented", async () => {
  const harness = captureHarness();
  await expect(
    createPageCapture({
      input: { path: "/", mode: "segmented" },
      projectRef: "core",
      repository: harness.repository,
      requestId: "req_capture_3",
      worker: harness.worker,
      workspace: workspace(),
      findProject: mock(async () => ({ id: PROJECT_ID })) as never,
      createSession: harness.createSession as never,
      expireSession: harness.expireSession as never,
    }),
  ).rejects.toMatchObject({
    status: 400,
    payload: { error: "capture_mode_not_supported" },
  } satisfies Partial<ConsoleApiError>);
  expect(harness.worker.capture).not.toHaveBeenCalled();
});

test("captures nothing when the path serves another page or version than the caller planned", async () => {
  const harness = captureHarness();
  await expect(
    createPageCapture({
      planned: { routeId: ROUTE_ID, artifactVersionId: "00000000-0000-4000-8000-000000000099" },
      input: { path: "/docs", mode: "thumbnail", idempotencyKey: "capture-planned-old-version" },
      projectRef: "core",
      repository: harness.repository,
      requestId: "req_capture_4",
      worker: harness.worker,
      workspace: workspace(),
      findProject: mock(async () => ({ id: PROJECT_ID })) as never,
      createSession: harness.createSession as never,
      expireSession: harness.expireSession as never,
    }),
  ).rejects.toMatchObject({ status: 409, payload: { error: "page_changed" } } satisfies Partial<ConsoleApiError>);
  expect(harness.worker.capture).not.toHaveBeenCalled();
  expect(harness.createSession).not.toHaveBeenCalled();
});

function captureHarness() {
  let current = captureRecord();
  const images: PageCaptureImageWithAsset[] = [];
  const failed: string[] = [];
  const worker: PageCaptureWorker = {
    capture: mock(async (input) => ({
      storageKey: `org/${input.organizationId}/project/${input.projectId}/artifact/${input.captureArtifactId}/version/${input.captureArtifactVersionId}/thumbnail.jpg`,
      filename: "thumbnail.jpg",
      role: "thumbnail" as const,
      mimeType: "image/jpeg" as const,
      width: 1440,
      height: 900,
      sizeBytes: 1024,
      sha256: "a".repeat(64),
    })),
    readImage: mock(async () => new Response("image", { status: 200 })),
  };
  const state = {
    existing: null as ReturnType<typeof captureRecord> | null,
    failed,
    worker,
    createSession: mock(async () => ({
      sessionId: "00000000-0000-4000-8000-000000000099",
      sessionToken: "sessionabcdefghijklmnopqrstuvwxyz123456",
      expiresAt: new Date(Date.now() + 60_000),
    })),
    expireSession: mock(async () => undefined),
    repository: null as unknown as PageCaptureRepository,
  };
  state.repository = {
    findPublishedTarget: mock(async () => target()),
    findByIdempotency: mock(async () => state.existing),
    createPending: mock(async (input) => {
      current = captureRecord({ ...input.capture, status: "pending" });
      return current;
    }),
    markCapturing: mock(async () => {
      current = captureRecord({ ...current, status: "capturing", startedAt: new Date() });
    }),
    markReady: mock(async (input) => {
      current = captureRecord({ ...current, status: "ready", completedAt: new Date() });
      images.splice(0, images.length, {
        image: {
          id: input.imageId,
          captureSetId: input.captureId,
          assetId: input.assetId,
          sequence: 0,
          role: "thumbnail",
          width: input.result.width,
          height: input.result.height,
          mimeType: input.result.mimeType,
          sizeBytes: input.result.sizeBytes,
          sha256: input.result.sha256,
          clipJson: {},
          metadataJson: {},
          createdAt: new Date(),
        },
        asset: {
          id: input.assetId,
          artifactId: input.artifactId,
          artifactVersionId: input.artifactVersionId,
          role: "thumbnail",
          path: "thumbnail.jpg",
          mimeType: "image/jpeg",
          sizeBytes: input.result.sizeBytes,
          sha256: input.result.sha256,
          visibility: "private",
          storageJson: { r2Key: input.result.storageKey },
          metadataJson: {},
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      return current;
    }),
    markFailed: mock(async (input) => {
      failed.push(input.failureCode);
      current = captureRecord({ ...current, status: "failed", failureCode: input.failureCode });
    }),
    findById: mock(async () => current),
    listImages: mock(async () => images),
    findImage: mock(async () => null),
  };
  return state;
}

function captureRecord(overrides: Partial<PageCaptureSetRecord> = {}): PageCaptureSetRecord {
  const now = new Date("2026-07-10T18:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000050",
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    siteId: SITE_ID,
    routeId: ROUTE_ID,
    releaseId: RELEASE_ID,
    releaseRouteId: RELEASE_ROUTE_ID,
    sourceArtifactId: SOURCE_ARTIFACT_ID,
    sourceArtifactVersionId: SOURCE_VERSION_ID,
    captureArtifactId: "00000000-0000-4000-8000-000000000060",
    captureArtifactVersionId: "00000000-0000-4000-8000-000000000061",
    mode: "thumbnail" as const,
    status: "pending" as const,
    provider: "cloudflare_browser_run",
    configHash: defaultConfigHash(),
    configJson: {},
    idempotencyKey: "capture-test-1",
    requestedByActorType: "user" as const,
    requestedByActorId: USER_ID,
    failureCode: null,
    failureMetadataJson: {},
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function target() {
  const now = new Date();
  return {
    site: {
      id: SITE_ID,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      slug: "rbbt-core",
      defaultHostname: "rbbt-core.ravi.page",
      defaultVisibility: "private" as const,
      activeReleaseId: RELEASE_ID,
      isDefault: true,
      status: "active" as const,
      createdByActorType: "user" as const,
      createdByActorId: USER_ID,
      metadataJson: {},
      createdAt: now,
      updatedAt: now,
    },
    release: {
      id: RELEASE_ID,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      siteId: SITE_ID,
      releaseNumber: 3,
      previousReleaseId: null,
      status: "active" as const,
      reason: null,
      manifestHash: null,
      createdByActorType: "user" as const,
      createdByActorId: USER_ID,
      activatedAt: now,
      createdAt: now,
    },
    releaseRoute: {
      id: RELEASE_ROUTE_ID,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      siteId: SITE_ID,
      releaseId: RELEASE_ID,
      routeId: ROUTE_ID,
      path: "/",
      matchType: "spa" as const,
      priority: 0,
      artifactId: SOURCE_ARTIFACT_ID,
      artifactVersionId: SOURCE_VERSION_ID,
      entrypoint: "index.html",
      assetBase: "/",
      visibility: "private" as const,
      routeConfigJson: {},
      createdAt: now,
    },
    effectiveVisibility: "private" as const,
  };
}

function workspace() {
  return {
    mode: "workos" as const,
    user: { id: USER_ID },
    organization: { id: ORG_ID },
    membership: { role: "owner" },
  };
}

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "00000000-0000-4000-8000-000000000002";
const SITE_ID = "00000000-0000-4000-8000-000000000003";
const ROUTE_ID = "00000000-0000-4000-8000-000000000004";
const RELEASE_ID = "00000000-0000-4000-8000-000000000005";
const RELEASE_ROUTE_ID = "00000000-0000-4000-8000-000000000006";
const SOURCE_ARTIFACT_ID = "00000000-0000-4000-8000-000000000007";
const SOURCE_VERSION_ID = "00000000-0000-4000-8000-000000000008";
const USER_ID = "00000000-0000-4000-8000-000000000009";

function defaultConfigHash() {
  return createHash("sha256")
    .update(JSON.stringify({
      viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      format: "jpeg",
      quality: 82,
      timeoutMs: 30000,
    }))
    .digest("hex");
}
