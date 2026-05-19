import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ConsoleApiClient } from "../cloud-auth/client.js";
import { CloudAuthError } from "../cloud-auth/errors.js";
import type { CloudCredentials } from "../cloud-auth/types.js";
import { createIsolatedRaviState, cleanupIsolatedRaviState } from "../test/ravi-state.js";
import {
  createArtifact,
  createArtifactPackage,
  createArtifactVersion,
  getArtifactDetails,
  listArtifactEvents,
  recordArtifactPublishState,
} from "./store.js";
import {
  activateArtifactReleaseInConsole,
  buildArtifactPackageManifest,
  normalizePublishOptions,
  publishArtifactToConsole,
} from "./publish-client.js";

const tempDirs: string[] = [];
let stateDir: string | null = null;

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  if (stateDir) {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  }
});

describe("artifact publish client", () => {
  it("builds a deterministic package manifest with checksums", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Hello</h1>");
    await writeFile(join(dir, "app.js"), "console.log('hi');");

    const result = await buildArtifactPackageManifest(dir);

    expect(result.isDirectory).toBe(true);
    expect(result.manifest.entrypoint).toBe("index.html");
    expect(result.manifest.files.map((file) => file.path)).toEqual(["app.js", "index.html"]);
    expect(result.manifest.files[0]).toMatchObject({
      contentType: "text/javascript; charset=utf-8",
      sizeBytes: 18,
    });
    expect(result.manifest.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects symlink package entries", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "ok");
    await symlink(join(dir, "index.html"), join(dir, "linked.html"));

    await expect(buildArtifactPackageManifest(dir)).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
  });

  it("infers a single-file package entrypoint", async () => {
    const dir = await tempDir();
    const file = join(dir, "pitch.html");
    await writeFile(file, "<h1>Pitch</h1>");

    const result = await buildArtifactPackageManifest(file);

    expect(result.isDirectory).toBe(false);
    expect(result.manifest.entrypoint).toBe("pitch.html");
    expect(result.manifest.files.map((item) => item.path)).toEqual(["pitch.html"]);
  });

  it("validates package paths with Console coarse manifest rules", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "ok");
    await mkdir(join(dir, ".well-known"), { recursive: true });
    await writeFile(join(dir, ".well-known", "assetlinks.json"), "{}");

    await expect(buildArtifactPackageManifest(dir)).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });

    const entrypointDir = await tempDir();
    await writeFile(join(entrypointDir, "index.html"), "ok");
    await expect(buildArtifactPackageManifest(entrypointDir, { entrypoint: "./index.html" })).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });

    const reservedDir = await tempDir();
    await mkdir(join(reservedDir, "assets", "_ravi"), { recursive: true });
    await writeFile(join(reservedDir, "index.html"), "ok");
    await writeFile(join(reservedDir, "assets", "_ravi", "asset.js"), "ok");

    await expect(buildArtifactPackageManifest(reservedDir)).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
  });

  it("requires an entrypoint when a directory package has no index.html", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "app.js"), "console.log('hi');");

    await expect(buildArtifactPackageManifest(dir)).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });

    const result = await buildArtifactPackageManifest(dir, { entrypoint: "app.js" });
    expect(result.manifest.entrypoint).toBe("app.js");
  });

  it("normalizes publish command options", () => {
    expect(normalizePublishOptions({ route: "docs", visibility: "protected-link" })).toMatchObject({
      route: "/docs",
      visibility: "protected_link",
    });
    expect(() => normalizePublishOptions({ visibility: "unlisted" })).toThrow(CloudAuthError);
  });

  it("requires existing ravi login credentials before publishing", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "ok");

    await expect(
      publishArtifactToConsole(dir, { project: "proj" }, { readCredentials: () => null }),
    ).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });
  });

  it("creates an upload session, uploads direct files, and finalizes through the Console API", async () => {
    stateDir = await createIsolatedRaviState("ravi-publish-artifacts-test-");
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Hello</h1>");
    await writeFile(join(dir, "app.js"), "console.log('hi');");
    const uploads: Array<{ url: string; method?: string; headers: Record<string, string>; size: number }> = [];
    const finalize = mock(async (input: Record<string, unknown>, accessToken: string) => {
      expect(accessToken).toBe("access-secret");
      expect(input.uploadSessionId).toBe("upl_123");
      expect(input.publish).toMatchObject({
        siteRef: "docs",
        route: { path: "/guide", visibility: "public" },
      });
      expect(input.packageManifest).toMatchObject({
        entrypoint: "index.html",
        files: [
          { path: "app.js", stagingKey: "uploads/upl_123/app.js" },
          { path: "index.html", stagingKey: "uploads/upl_123/index.html" },
        ],
      });
      expect(input.source).toMatchObject({
        tool: "ravi artifacts publish",
        target: "local_artifact",
        versionNumber: 1,
      });
      return {
        artifact: { id: "art_123" },
        artifactVersion: { id: "ver_123" },
        publish: { id: "pub_123" },
        release: { id: "rel_123", url: "https://example.test/guide" },
        routes: [{ id: "route_123" }],
      };
    });
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async (input: Record<string, unknown>, accessToken: string) => {
        expect(accessToken).toBe("access-secret");
        expect(input).toMatchObject({ projectRef: "proj", siteRef: "docs" });
        expect(input.packageManifest).toMatchObject({
          entrypoint: "index.html",
          files: [{ path: "app.js" }, { path: "index.html" }],
        });
        return {
          uploadSession: { id: "upl_123" },
          uploadPolicy: {
            files: [
              {
                path: "app.js",
                stagingKey: "uploads/upl_123/app.js",
                url: "https://upload.example/app.js",
                method: "PUT",
                headers: {
                  "content-type": "application/signed-js",
                  "x-amz-meta-ravi-file": "app.js",
                },
              },
              {
                path: "index.html",
                stagingKey: "uploads/upl_123/index.html",
                url: "https://upload.example/index.html",
                method: "PUT",
                headers: {
                  "x-amz-meta-ravi-file": "index.html",
                },
              },
            ],
          },
        };
      }),
      finalizeArtifactPublish: finalize,
    } as unknown as ConsoleApiClient;
    const fetchImpl = mock(async (url: string, init?: RequestInit) => {
      uploads.push({
        url,
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        size: await requestBodySize(init?.body),
      });
      return new Response(null, { status: 200 });
    });

    const result = await publishArtifactToConsole(
      dir,
      { project: "proj", site: "docs", route: "guide", visibility: "public" },
      {
        client,
        fetch: fetchImpl,
        readCredentials: () => makeCredentials(),
        writeCredentials: () => {},
        deleteCredentials: () => {},
      },
    );

    expect(result).toMatchObject({
      success: true,
      upload: { attempted: 2, skipped: 0 },
      artifact: { id: "art_123" },
      url: "https://example.test/guide",
    });
    expect(result.localSync).toMatchObject({
      status: "recorded",
      versionNumber: 1,
      eventType: "published",
    });
    expect(result.localSync.status).toBe("recorded");
    if (result.localSync.status === "recorded") {
      expect(getArtifactDetails(result.localSync.artifactId)?.artifact.kind).toBe("artifact");
    }
    expect(result.uploadSession).toEqual({ id: "upl_123" });
    expect(uploads.map((upload) => upload.url).sort()).toEqual([
      "https://upload.example/app.js",
      "https://upload.example/index.html",
    ]);
    expect(uploads.every((upload) => upload.method === "PUT")).toBe(true);
    expect(uploads.find((upload) => upload.url.endsWith("/app.js"))?.headers).toMatchObject({
      "content-type": "application/signed-js",
      "x-amz-meta-ravi-file": "app.js",
    });
    expect(uploads.find((upload) => upload.url.endsWith("/app.js"))?.headers).not.toHaveProperty("content-length");
    expect(uploads.find((upload) => upload.url.endsWith("/app.js"))?.headers).not.toHaveProperty("x-ravi-sha256");
    expect(uploads.find((upload) => upload.url.endsWith("/app.js"))?.size).toBe(18);
    expect(uploads.find((upload) => upload.url.endsWith("/index.html"))?.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "x-amz-meta-ravi-file": "index.html",
    });
    expect(uploads.find((upload) => upload.url.endsWith("/index.html"))?.headers).not.toHaveProperty("content-length");
    expect(uploads.find((upload) => upload.url.endsWith("/index.html"))?.headers).not.toHaveProperty("x-ravi-sha256");
    expect(uploads.find((upload) => upload.url.endsWith("/index.html"))?.size).toBe(14);
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("publishes the latest local artifact version as the package source", async () => {
    stateDir = await createIsolatedRaviState("ravi-publish-artifacts-test-");
    const firstFile = join(stateDir, "draft.html");
    const indexFile = join(stateDir, "index.html");
    const appFile = join(stateDir, "app.js");
    await writeFile(firstFile, "<h1>Draft</h1>");
    await writeFile(indexFile, "<h1>Published</h1>");
    await writeFile(appFile, "console.log('published');");

    const artifact = createArtifact({
      title: "Local Page",
      summary: "Local artifact summary",
      filePath: firstFile,
    });
    const latestVersion = createArtifactVersion(artifact.id, {
      manifest: { entrypoint: "index.html" },
      assets: [
        { path: "index.html", filePath: indexFile, mimeType: "text/html; charset=utf-8" },
        { path: "assets/app.js", blobPath: appFile, mimeType: "text/javascript; charset=utf-8" },
      ],
    });

    const finalize = mock(async (input: Record<string, unknown>) => {
      expect(input.artifact).toMatchObject({
        name: "Local Page",
        description: "Local artifact summary",
        localArtifactId: artifact.id,
      });
      expect(input.packageManifest).toMatchObject({
        entrypoint: "index.html",
        files: [{ path: "assets/app.js" }, { path: "index.html" }],
      });
      expect(input.source).toMatchObject({
        tool: "ravi artifacts publish",
        target: "local_artifact",
        artifactId: artifact.id,
        versionId: latestVersion.id,
        versionNumber: latestVersion.versionNumber,
      });
      return {
        artifact: { id: "cloud_art_123", slug: "local-page", projectId: "proj_123" },
        artifactVersion: { id: "cloud_ver_123", versionNumber: 8 },
        publish: { id: "pub_123", status: "completed", siteId: "site_123", projectId: "proj_123" },
        release: {
          id: "rel_123",
          releaseNumber: 3,
          siteId: "site_123",
          projectId: "proj_123",
          hostname: "docs.ravi.page",
          url: "https://docs.ravi.page/",
        },
        routes: [{ id: "route_123", path: "/", matchType: "spa", artifactVersionId: "cloud_ver_123" }],
      };
    });
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async (input: Record<string, unknown>) => {
        expect(input.packageManifest).toMatchObject({
          entrypoint: "index.html",
          files: [{ path: "assets/app.js" }, { path: "index.html" }],
        });
        return {
          uploadSession: { id: "upl_123" },
          uploadPolicy: { directUpload: false },
        };
      }),
      finalizeArtifactPublish: finalize,
    } as unknown as ConsoleApiClient;

    const result = await publishArtifactToConsole(
      artifact.id,
      { project: "proj", site: "docs", route: "/", visibility: "public", idempotencyKey: "secret-idempotency" },
      {
        client,
        fetch: mock(async () => new Response(null, { status: 200 })),
        readCredentials: () => makeCredentials(),
        writeCredentials: () => {},
        deleteCredentials: () => {},
      },
    );

    expect(result.upload).toEqual({ attempted: 0, skipped: 2 });
    expect(result.localSync).toMatchObject({
      status: "recorded",
      artifactId: artifact.id,
      versionId: latestVersion.id,
      versionNumber: latestVersion.versionNumber,
      eventType: "published",
    });
    expect(finalize).toHaveBeenCalledTimes(1);

    const details = getArtifactDetails(artifact.id);
    expect(details?.artifact.status).toBe(artifact.status);
    const publishedEvent = details?.events.find((event) => event.eventType === "published");
    expect(publishedEvent?.source).toBe("ravi artifacts publish");
    expect(publishedEvent?.payload).toMatchObject({
      consoleUrl: "https://console.example",
      project: { ref: "proj", id: "proj_123" },
      site: { ref: "docs", id: "site_123", hostname: "docs.ravi.page" },
      route: { path: "/", visibility: "public", activate: true },
      local: {
        artifactId: artifact.id,
        versionId: latestVersion.id,
        versionNumber: latestVersion.versionNumber,
      },
      remote: {
        artifactId: "cloud_art_123",
        artifactSlug: "local-page",
        artifactVersionId: "cloud_ver_123",
        artifactVersionNumber: 8,
        publishId: "pub_123",
        publishStatus: "completed",
        releaseId: "rel_123",
        releaseNumber: 3,
        url: "https://docs.ravi.page/",
      },
      upload: { sessionId: "upl_123", attempted: 0, skipped: 2 },
      idempotencyKeyHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(publishedEvent?.payload)).not.toContain("uploadPolicy");
    expect(JSON.stringify(publishedEvent?.payload)).not.toContain("secret-idempotency");
    expect(details?.artifact.metadata).toMatchObject({
      cloud: {
        publish: {
          current: {
            remote: { artifactId: "cloud_art_123", artifactVersionId: "cloud_ver_123" },
            local: { artifactId: artifact.id, versionNumber: latestVersion.versionNumber },
          },
        },
      },
    });
  });

  it("publishes a local directory package artifact from stored blobs", async () => {
    stateDir = await createIsolatedRaviState("ravi-publish-artifacts-test-");
    const packageDir = join(stateDir, "site");
    await mkdir(join(packageDir, "assets"), { recursive: true });
    await writeFile(join(packageDir, "index.html"), "<h1>Stored package</h1>");
    await writeFile(join(packageDir, "assets", "app.js"), "console.log('stored');");

    const packageArtifact = createArtifactPackage({
      rootPath: packageDir,
      artifact: {
        title: "Stored Site",
        summary: "Stored local directory package",
      },
    });
    await rm(packageDir, { recursive: true, force: true });

    const finalize = mock(async (input: Record<string, unknown>) => {
      expect(input.artifact).toMatchObject({
        name: "Stored Site",
        description: "Stored local directory package",
        localArtifactId: packageArtifact.artifact.id,
      });
      expect(input.packageManifest).toMatchObject({
        entrypoint: "index.html",
        files: [{ path: "assets/app.js" }, { path: "index.html" }],
      });
      expect(input.source).toMatchObject({
        target: "local_artifact",
        artifactId: packageArtifact.artifact.id,
        versionId: packageArtifact.version.id,
        versionNumber: 1,
      });
      return {
        artifact: { id: "cloud_art_pkg" },
        artifactVersion: { id: "cloud_ver_pkg", versionNumber: 1 },
        publish: { id: "pub_pkg", status: "completed", siteId: "site_pkg" },
        release: { id: "rel_pkg", releaseNumber: 1, siteId: "site_pkg" },
        site: { id: "site_pkg", defaultHostname: "stored.ravi.page" },
        routes: [{ id: "route_pkg", path: "/", artifactVersionId: "cloud_ver_pkg" }],
        url: "https://stored.ravi.page/",
      };
    });
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async (input: Record<string, unknown>) => {
        expect(input.packageManifest).toMatchObject({
          entrypoint: "index.html",
          files: [{ path: "assets/app.js" }, { path: "index.html" }],
        });
        return {
          uploadSession: { id: "upl_pkg" },
          uploadPolicy: { directUpload: false },
        };
      }),
      finalizeArtifactPublish: finalize,
    } as unknown as ConsoleApiClient;

    const result = await publishArtifactToConsole(
      packageArtifact.artifact.id,
      { project: "proj", site: "docs", route: "/" },
      {
        client,
        readCredentials: () => makeCredentials(),
        writeCredentials: () => {},
        deleteCredentials: () => {},
      },
    );

    expect(result.upload).toEqual({ attempted: 0, skipped: 2 });
    expect(result.url).toBe("https://stored.ravi.page/");
    expect(result.localSync).toMatchObject({
      status: "recorded",
      artifactId: packageArtifact.artifact.id,
      versionNumber: 1,
    });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("activates a previously published local artifact version without re-uploading files", async () => {
    stateDir = await createIsolatedRaviState("ravi-publish-artifacts-test-");
    const file = join(stateDir, "index.html");
    await writeFile(file, "<h1>Version one</h1>");

    const artifact = createArtifact({
      title: "Local Page",
    });
    const version = createArtifactVersion(artifact.id, {
      manifest: { entrypoint: "index.html" },
      assets: [{ path: "index.html", filePath: file, mimeType: "text/html; charset=utf-8" }],
    });
    recordArtifactPublishState(artifact.id, {
      eventType: "published",
      source: "ravi artifacts publish",
      message: "Artifact version 1 published",
      payload: {
        consoleUrl: "https://console.example",
        project: { ref: "proj", id: "proj_123" },
        site: { ref: "docs", id: "site_123", hostname: "docs.ravi.page" },
        route: { path: "/", visibility: "public", activate: true },
        local: {
          artifactId: artifact.id,
          versionId: version.id,
          versionNumber: version.versionNumber,
        },
        remote: {
          artifactId: "cloud_art_123",
          artifactVersionId: "cloud_ver_1",
          artifactVersionNumber: 1,
          publishId: "pub_123",
          publishStatus: "completed",
          releaseId: "rel_v1",
          releaseNumber: 1,
          url: "https://docs.ravi.page/",
        },
        syncedAt: "2026-05-10T00:00:00.000Z",
      },
      metadataSummary: {
        consoleUrl: "https://console.example",
        site: { ref: "docs", id: "site_123", hostname: "docs.ravi.page" },
        local: { artifactId: artifact.id, versionId: version.id, versionNumber: version.versionNumber },
        remote: { releaseId: "rel_v1", releaseNumber: 1, url: "https://docs.ravi.page/" },
        syncedAt: "2026-05-10T00:00:00.000Z",
      },
    });

    const activate = mock(async (input: Record<string, unknown>, accessToken: string) => {
      expect(accessToken).toBe("access-secret");
      expect(input).toEqual({ siteRef: "docs", releaseId: "rel_v1" });
      return {
        site: { id: "site_123", defaultHostname: "docs.ravi.page" },
        release: { id: "rel_v1", releaseNumber: 1, siteId: "site_123", projectId: "proj_123" },
        routes: [{ id: "route_1", path: "/", matchType: "spa", artifactVersionId: "cloud_ver_1" }],
        url: "https://docs.ravi.page/",
      };
    });
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async () => {
        throw new Error("unexpected upload session");
      }),
      finalizeArtifactPublish: mock(async () => {
        throw new Error("unexpected finalize");
      }),
      activatePageSiteRelease: activate,
    } as unknown as ConsoleApiClient;

    const result = await activateArtifactReleaseInConsole(
      artifact.id,
      { artifactVersion: 1 },
      {
        client,
        readCredentials: () => makeCredentials(),
        writeCredentials: () => {},
        deleteCredentials: () => {},
      },
    );

    expect(result).toMatchObject({
      success: true,
      url: "https://docs.ravi.page/",
      localSync: {
        status: "recorded",
        artifactId: artifact.id,
        versionId: version.id,
        versionNumber: 1,
        eventType: "release_activated",
      },
    });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(client.createPageUploadSession).not.toHaveBeenCalled();
    expect(client.finalizeArtifactPublish).not.toHaveBeenCalled();
    const events = listArtifactEvents(artifact.id);
    expect(events.at(-1)?.eventType).toBe("release_activated");
    expect(events.at(-1)?.payload).toMatchObject({
      site: { ref: "docs", id: "site_123", hostname: "docs.ravi.page" },
      local: { artifactId: artifact.id, versionId: version.id, versionNumber: 1 },
      remote: { releaseId: "rel_v1", releaseNumber: 1, url: "https://docs.ravi.page/" },
    });
    expect(getArtifactDetails(artifact.id)?.artifact.metadata).toMatchObject({
      cloud: {
        publish: {
          current: {
            source: { tool: "ravi artifacts release activate" },
            remote: { releaseId: "rel_v1" },
          },
        },
      },
    });
  });

  it("publishes a selected local artifact version and honors metadata overrides", async () => {
    stateDir = await createIsolatedRaviState("ravi-publish-artifacts-test-");
    const firstFile = join(stateDir, "index.html");
    const secondFile = join(stateDir, "v2.html");
    await writeFile(firstFile, "<h1>Version one</h1>");
    await writeFile(secondFile, "<h1>Version two</h1>");

    const artifact = createArtifact({
      title: "Local Page",
      summary: "Original summary",
      filePath: firstFile,
    });
    createArtifactVersion(artifact.id, {
      manifest: { entrypoint: "v2.html" },
      assets: [{ path: "v2.html", filePath: secondFile, mimeType: "text/html; charset=utf-8" }],
    });

    const finalize = mock(async (input: Record<string, unknown>) => {
      expect(input.artifact).toMatchObject({
        name: "Override Name",
        slug: "override-slug",
        description: "Override description",
        localArtifactId: artifact.id,
      });
      expect(input.packageManifest).toMatchObject({
        entrypoint: "index.html",
        files: [{ path: "index.html" }],
      });
      expect(input.source).toMatchObject({
        target: "local_artifact",
        artifactId: artifact.id,
        versionNumber: 1,
      });
      return { artifact: { id: "cloud_art_123" } };
    });
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_123" },
        uploadPolicy: { directUpload: false },
      })),
      finalizeArtifactPublish: finalize,
    } as unknown as ConsoleApiClient;

    await publishArtifactToConsole(
      artifact.id,
      {
        project: "proj",
        artifactVersion: 1,
        name: "Override Name",
        slug: "override-slug",
        description: "Override description",
      },
      {
        client,
        readCredentials: () => makeCredentials(),
        writeCredentials: () => {},
        deleteCredentials: () => {},
      },
    );

    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it("rejects local artifact assets without publishable local files before upload or finalize", async () => {
    stateDir = await createIsolatedRaviState("ravi-publish-artifacts-test-");
    const uriOnly = createArtifact({ title: "URI only" });
    createArtifactVersion(uriOnly.id, {
      manifest: { entrypoint: "index.html" },
      assets: [{ path: "index.html", uri: "https://example.test/index.html", mimeType: "text/html" }],
    });
    const missingLocal = createArtifact({ title: "Missing local" });
    createArtifactVersion(missingLocal.id, {
      manifest: { entrypoint: "index.html" },
      assets: [{ path: "index.html", filePath: join(stateDir, "missing.html"), mimeType: "text/html" }],
    });
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_123" },
        uploadPolicy: { directUpload: false },
      })),
      finalizeArtifactPublish: mock(async () => ({ artifact: { id: "cloud_art_123" } })),
    } as unknown as ConsoleApiClient;
    const deps = {
      client,
      fetch: mock(async () => new Response(null, { status: 200 })),
      readCredentials: () => makeCredentials(),
      writeCredentials: () => {},
      deleteCredentials: () => {},
    };

    await expect(publishArtifactToConsole(uriOnly.id, { project: "proj" }, deps)).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });
    await expect(publishArtifactToConsole(missingLocal.id, { project: "proj" }, deps)).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });

    expect(client.createPageUploadSession).not.toHaveBeenCalled();
    expect(client.finalizeArtifactPublish).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("does not finalize when a direct file upload fails", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Hello</h1>");
    const finalize = mock(async () => ({ artifact: { id: "art_123" } }));
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_123" },
        uploadPolicy: {
          files: [
            {
              path: "index.html",
              stagingKey: "uploads/upl_123/index.html",
              url: "https://upload.example/index.html",
              method: "PUT",
            },
          ],
        },
      })),
      finalizeArtifactPublish: finalize,
    } as unknown as ConsoleApiClient;

    await expect(
      publishArtifactToConsole(
        dir,
        { project: "proj", site: "docs", visibility: "public" },
        {
          client,
          fetch: mock(async () => new Response("upload failed", { status: 503 })),
          readCredentials: () => makeCredentials(),
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    ).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 503,
    });

    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not finalize when direct upload policy omits a manifest file", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Hello</h1>");
    const finalize = mock(async () => ({ artifact: { id: "art_123" } }));
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async () => ({
        uploadSession: {
          id: "upl_123",
          stagingPrefix: "staging/upl_123",
          uploadPolicyJson: { files: [{ url: "https://signed.example" }] },
        },
        uploadPolicy: {
          directUpload: true,
          files: [],
        },
      })),
      finalizeArtifactPublish: finalize,
    } as unknown as ConsoleApiClient;

    await expect(
      publishArtifactToConsole(
        dir,
        { project: "proj", site: "docs", visibility: "public" },
        {
          client,
          fetch: mock(async () => new Response(null, { status: 200 })),
          readCredentials: () => makeCredentials(),
          writeCredentials: () => {},
          deleteCredentials: () => {},
        },
      ),
    ).rejects.toMatchObject({
      code: "PAYLOAD_INVALID",
    });

    expect(finalize).not.toHaveBeenCalled();
  });

  it("preserves generic uploads map policies", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Hello</h1>");
    const uploads: string[] = [];
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_123" },
        uploadPolicy: {
          stagingPrefix: "staging/upl_123",
          uploads: {
            "staging/upl_123/index.html": "https://upload.example/index.html",
          },
        },
      })),
      finalizeArtifactPublish: mock(async () => ({ artifact: { id: "art_123" } })),
    } as unknown as ConsoleApiClient;

    const result = await publishArtifactToConsole(
      dir,
      { project: "proj" },
      {
        client,
        fetch: mock(async (url: string) => {
          uploads.push(url);
          return new Response(null, { status: 200 });
        }),
        readCredentials: () => makeCredentials(),
        writeCredentials: () => {},
        deleteCredentials: () => {},
      },
    );

    expect(result.upload).toEqual({ attempted: 1, skipped: 0 });
    expect(uploads).toEqual(["https://upload.example/index.html"]);
  });

  it("finalizes metadata-only development sessions when direct upload is disabled", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<h1>Hello</h1>");
    const fetchImpl = mock(async () => new Response(null, { status: 200 }));
    const finalize = mock(async (input: Record<string, unknown>) => {
      expect(input.uploadSessionId).toBe("upl_123");
      expect(input.packageManifest).toMatchObject({
        entrypoint: "index.html",
        files: [{ path: "index.html" }],
      });
      return { artifact: { id: "art_123" } };
    });
    const client = {
      me: mock(async () => ({ user: { email: "dev@example.test" } })),
      createPageUploadSession: mock(async () => ({
        uploadSession: { id: "upl_123" },
        uploadPolicy: { directUpload: false },
      })),
      finalizeArtifactPublish: finalize,
    } as unknown as ConsoleApiClient;

    const result = await publishArtifactToConsole(
      dir,
      { project: "proj", site: "docs", visibility: "public" },
      {
        client,
        fetch: fetchImpl,
        readCredentials: () => makeCredentials(),
        writeCredentials: () => {},
        deleteCredentials: () => {},
      },
    );

    expect(result.upload).toEqual({ attempted: 0, skipped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledTimes(1);
  });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ravi-publish-"));
  tempDirs.push(dir);
  return dir;
}

function makeCredentials(): CloudCredentials {
  return {
    version: 1,
    consoleUrl: "https://console.example",
    installationId: "ins_123",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    accessTokenExpiresAt: "2026-05-10T00:00:00.000Z",
    refreshTokenExpiresAt: "2026-06-10T00:00:00.000Z",
    scopes: ["artifacts.publish"],
    user: { email: "dev@example.test" },
    organization: { id: "org_123", name: "Acme" },
    createdAt: "2026-05-09T00:00:00.000Z",
    updatedAt: "2026-05-09T00:00:00.000Z",
  };
}

async function requestBodySize(body: RequestInit["body"]): Promise<number> {
  if (!body) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}
