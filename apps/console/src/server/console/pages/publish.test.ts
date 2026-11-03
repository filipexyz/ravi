import { describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { authorizeFixtureProject } from "../authorization/fixture-policy";

import { ConsoleApiError } from "@/server/console/api-error";
import type {
  PagesPasswordAccessRepository,
  PagesPasswordPolicyRecord,
} from "@/server/console/pages/password-access";
import {
  activatePageSiteRelease as activatePageSiteReleaseWithHook,
  comparePageSiteReleases,
  createPageObjectStorageFromEnv,
  createPageSiteRelease as createPageSiteReleaseWithHook,
  createPageUploadSession,
  finalizePageUploadSession as finalizePageUploadSessionWithHook,
  getPageSiteReleaseFileDiff,
  repairActiveSiteEdgeManifest as repairActiveSiteEdgeManifestWithHook,
  routeConfigJsonForInput,
  type PageKnowledgeHook,
  type PageObjectStorage,
  type PagePublishContext,
  type PageReleaseRouteSpec,
  type PagePublishRepository,
} from "./publish";

// Every publish call gets a recording no-op Knowledge hook: the default
// schedules a capture that reads the real database.
const knowledgeHookCalls: Array<Parameters<PageKnowledgeHook>[0]> = [];
const noopKnowledgeHook: PageKnowledgeHook = (input) => {
  knowledgeHookCalls.push(input);
};
function withNoopKnowledgeHook<Args extends { knowledgeHook?: PageKnowledgeHook }, Result>(run: (args: Args) => Promise<Result>) {
  return (args: Args) => run({ knowledgeHook: noopKnowledgeHook, ...args });
}
const finalizePageUploadSession = withNoopKnowledgeHook(finalizePageUploadSessionWithHook);
const createPageSiteRelease = withNoopKnowledgeHook(createPageSiteReleaseWithHook);
const activatePageSiteRelease = withNoopKnowledgeHook(activatePageSiteReleaseWithHook);
const repairActiveSiteEdgeManifest = withNoopKnowledgeHook(repairActiveSiteEdgeManifestWithHook);

describe("Knowledge in the publish service", () => {
  test("routeConfigJsonForInput strips the reserved knowledge key", () => {
    expect(routeConfigJsonForInput({ routeConfigJson: { knowledge: {}, x: 1 } } as unknown as PageReleaseRouteSpec)).toEqual({ x: 1 });
  });
});

describe("Ravi Pages publish service", () => {
  test("revocation during storage promotion denies final persistence even without activation", async () => {
    const repository = createInMemoryPublishRepository(), context = publishContext(), storage = memoryStorage();
    let revoked = false;
    const authorize = repository.authorizeProject!;
    repository.authorizeProject = async (...args) => !revoked && authorize(...args);
    const manifest = packageManifest("revoked-finalize");
    const upload = await createPageUploadSession({ context, input: { projectRef: "proj_1", packageManifest: manifest }, repository,
      requestId: "revoked-upload", storage });
    const promote = storage.promoteObject;
    storage.promoteObject = async input => { const result = await promote(input); revoked = true; return result; };
    await expect(finalizePageUploadSession({ context, input: { uploadSessionId: upload.uploadSession.id,
      idempotencyKey: "revoked-finalize", packageManifest: manifest, artifact: { slug: "revoked", name: "Revoked" },
      publish: { route: { path: "/revoked" }, activate: false } }, repository, requestId: "revoked-finalize", storage,
    })).rejects.toMatchObject({ status: 403 });
    expect(repository.publishes.some(p => p.status === "completed")).toBe(false);
    expect(repository.releases).toHaveLength(0);
  });
  test("publishes to the project default Pages host when siteRef is omitted", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", packageManifest: packageManifest("default-host") },
      repository,
      requestId: "req_upload_default_host",
      storage,
    });

    const result = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "finalize-default-host",
        packageManifest: packageManifest("default-host"),
        artifact: { slug: "default-host", name: "Default Host" },
        publish: {
          route: { path: "/docs", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_default_host",
      storage,
    });

    expect(upload.uploadSession.siteId).toBeNull();
    expect(result.site?.id).toBe("site_1");
    expect(result.url).toBe("https://demo.ravi.page/docs");
    expect(result.publish.siteId).toBe("site_1");
  });

  test("persists route-scoped device motion and includes it in the release manifest hash", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const manifest = packageManifest("device-motion");
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: manifest },
      repository,
      requestId: "req_upload_device_motion",
      storage,
    });

    const optedIn = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "finalize-device-motion",
        packageManifest: manifest,
        artifact: { slug: "device-motion", name: "Device Motion" },
        publish: {
          siteRef: "site_1",
          route: { path: "/motion", matchType: "spa", allowDeviceMotion: true },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_device_motion",
      storage,
    });

    expect(optedIn.routes[0]?.routeConfigJson).toEqual({
      browserPermissions: { deviceMotion: "self" },
    });
    const optedInManifest = storage.siteManifests.get("sites/demo.ravi.page/active.json") as {
      routes?: Array<Record<string, unknown>>;
    };
    expect(optedInManifest.routes?.[0]).toMatchObject({
      browserPermissions: { deviceMotion: "self" },
    });
    expect(optedInManifest.routes?.[0]).not.toHaveProperty("headers");

    const optedOut = await createPageSiteRelease({
      context,
      input: {
        projectRef: "proj_1",
        siteRef: "site_1",
        replaceRelease: true,
        routes: [
          {
            path: "/motion",
            matchType: "spa",
            artifactVersionId: optedIn.artifactVersion.id,
            allowDeviceMotion: false,
          },
        ],
      },
      repository,
      requestId: "req_release_without_device_motion",
      storage,
    });

    expect(optedOut.routes[0]?.routeConfigJson).toEqual({});
    expect(optedOut.release.manifestHash).not.toBe(optedIn.release?.manifestHash);
  });

  test("publishes one route while preserving other active release routes", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const rootUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("home") },
      repository,
      requestId: "req_upload_root",
      storage,
    });
    const root = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: rootUpload.uploadSession.id,
        idempotencyKey: "finalize-root",
        packageManifest: packageManifest("home"),
        artifact: { slug: "home", name: "Home" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_root",
      storage,
    });

    const pitchUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("pitch") },
      repository,
      requestId: "req_upload_pitch",
      storage,
    });
    const pitch = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: pitchUpload.uploadSession.id,
        idempotencyKey: "finalize-pitch",
        packageManifest: packageManifest("pitch"),
        artifact: { slug: "pitch", name: "Pitch" },
        publish: {
          siteRef: "site_1",
          route: { path: "/pitch", matchType: "prefix" },
        },
      },
      repository,
      requestId: "req_finalize_pitch",
      storage,
    });

    expect(root.release?.id).not.toBe(pitch.release?.id);
    expect(root.url).toBe("https://demo.ravi.page/");
    expect(pitch.url).toBe("https://demo.ravi.page/pitch");
    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBe(pitch.release?.id);
    expect(pitch.routes.map((route) => route.path).sort()).toEqual(["/", "/pitch"]);
  });

  test("requires the exact password policy and keeps generic artifact records private", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const publicUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("public-root") },
      repository,
      requestId: "req_upload_public_root",
      storage,
    });
    const publicResult = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: publicUpload.uploadSession.id,
        packageManifest: packageManifest("public-root"),
        artifact: { slug: "public-root", name: "Public Root" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_public_root",
      storage,
    });
    const routeId = publicResult.routes[0]?.routeId;
    expect(routeId).toBeTruthy();

    await expect(createPageSiteRelease({
      context,
      input: {
        projectRef: "proj_1",
        siteRef: "site_1",
        replaceRelease: true,
        routes: [{
          path: "/",
          matchType: "spa",
          artifactVersionId: publicResult.artifactVersion.id,
          visibility: "password",
        }],
      },
      passwordRepository: passwordPolicyRepository(null),
      repository,
      requestId: "req_password_policy_missing",
      storage,
    })).rejects.toMatchObject({ payload: { error: "password_policy_required" } });

    const passwordUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("password-root") },
      repository,
      requestId: "req_upload_password_root",
      storage,
    });
    const passwordResult = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: passwordUpload.uploadSession.id,
        packageManifest: packageManifest("password-root"),
        artifact: { slug: "password-root", name: "Password Root" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa", visibility: "password" },
          replaceRelease: true,
        },
      },
      passwordRepository: passwordPolicyRepository(activePasswordPolicy(routeId!)),
      repository,
      requestId: "req_finalize_password_root",
      storage,
    });

    expect(passwordResult.routes[0]?.visibility).toBe("password");
    expect(passwordResult.artifact.visibility).toBe("private");
    expect(passwordResult.publish.visibility).toBe("private");
  });

  test("blocks active publishes until unread route comments are read", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("comment-gate") },
      repository,
      requestId: "req_upload_comment_gate",
      storage,
    });
    repository.pageComments.push({
      id: "comment_1",
      body: "Ajustar antes de publicar",
      path: "/",
      siteId: "site_1",
      status: "open",
      createdAt: new Date("2026-05-10T12:01:00.000Z"),
      createdByUserId: "user_2",
      createdByDisplayName: "Thiago",
    });

    await expect(
      finalizePageUploadSession({
        context,
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: "comment-gate",
          packageManifest: packageManifest("comment-gate"),
          artifact: { slug: "comment-gate", name: "Comment Gate" },
          publish: {
            siteRef: "site_1",
            route: { path: "/", matchType: "spa" },
            replaceRelease: true,
          },
        },
        repository,
        requestId: "req_finalize_comment_gate_blocked",
        storage,
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_unread_comments" },
    });
    expect(repository.publishes).toHaveLength(0);
    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBeNull();

    repository.pageCommentReadReceipts.push({
      id: "receipt_1",
      path: "/",
      siteId: "site_1",
      userId: "user_1",
      lastReadAt: new Date("2026-05-10T12:02:00.000Z"),
      lastReadCommentCreatedAt: new Date("2026-05-10T12:01:00.000Z"),
    });

    const result = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "comment-gate",
        packageManifest: packageManifest("comment-gate"),
        artifact: { slug: "comment-gate", name: "Comment Gate" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_comment_gate_read",
      storage,
    });

    expect(result.url).toBe("https://demo.ravi.page/");
    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBe(result.release?.id);
  });

  test("bypasses unread comments for CLI route-visibility release reuse", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const home = await finalizeUnpublishedArtifact(repository, context, storage, "cli-visibility");
    repository.pageComments.push({
      id: "comment_cli_visibility",
      body: "Unread comments must not block visibility-only reuse",
      path: "/",
      siteId: "site_1",
      status: "open",
      createdAt: new Date("2026-05-10T12:01:00.000Z"),
      createdByUserId: "user_2",
      createdByDisplayName: "Thiago",
    });

    const result = await createPageSiteRelease({
      context,
      repository,
      requestId: "req_cli_visibility_bypass",
      storage,
      input: {
        projectRef: "proj_1",
        reason: "cli_visibility_update",
        siteRef: "site_1",
        activate: true,
        replaceRelease: true,
        routes: [
          {
            path: "/",
            matchType: "spa",
            artifactVersionId: home.artifactVersion.id,
            visibility: "public",
          },
        ],
      },
    });

    expect(result.release.status).toBe("active");
    expect(result.routes[0]?.visibility).toBe("public");
    expect(result.url).toBe("https://demo.ravi.page/");
    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBe(result.release?.id);
  });

  test("records provider-neutral usage events for each stored asset and release", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("metered") },
      repository,
      requestId: "req_upload_metered",
      storage,
    });

    const result = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "finalize-metered",
        packageManifest: packageManifest("metered"),
        artifact: { slug: "metered", name: "Metered" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_metered",
      storage,
    });

    const assetEvents = repository.usageEvents.filter((event) => event.eventType === "pages.asset_stored");
    expect(assetEvents).toHaveLength(2);
    expect(assetEvents.map((event) => event.quantity)).toEqual(["100", "50"]);
    expect(assetEvents.every((event) => event.publishId === result.publish.id)).toBe(true);
    expect(assetEvents.every((event) => event.siteId === result.site?.id)).toBe(true);
    expect(repository.usageEvents.some((event) => event.eventType === "pages.manifest_stored")).toBe(true);
    expect(repository.usageEvents.some((event) => event.eventType === "pages.release_activated")).toBe(true);
    expect(JSON.stringify(repository.usageEvents)).not.toContain("Cloudflare");
    expect(JSON.stringify(repository.usageEvents)).not.toContain("R2");
  });

  test("activates an existing release without creating a new publish or upload", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const rootUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("home") },
      repository,
      requestId: "req_upload_root_activate",
      storage,
    });
    const root = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: rootUpload.uploadSession.id,
        idempotencyKey: "finalize-root-activate",
        packageManifest: packageManifest("home"),
        artifact: { slug: "home-activate", name: "Home" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_root_activate",
      storage,
    });

    const pitchUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("pitch") },
      repository,
      requestId: "req_upload_pitch_activate",
      storage,
    });
    const pitch = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: pitchUpload.uploadSession.id,
        idempotencyKey: "finalize-pitch-activate",
        packageManifest: packageManifest("pitch"),
        artifact: { slug: "pitch-activate", name: "Pitch" },
        publish: {
          siteRef: "site_1",
          route: { path: "/pitch", matchType: "prefix" },
        },
      },
      repository,
      requestId: "req_finalize_pitch_activate",
      storage,
    });

    const uploadCount = repository.uploadSessions.length;
    const publishCount = repository.publishes.length;
    const releaseCount = repository.releases.length;
    const releaseUsageCount = repository.usageEvents.filter((event) => event.eventType === "pages.release_activated").length;
    const rootReleaseId = root.release?.id;
    const pitchReleaseId = pitch.release?.id;
    if (!rootReleaseId || !pitchReleaseId) throw new Error("Expected test releases to exist.");
    repository.pageComments.push({
      id: "comment_activate",
      body: "Confirm rollback context",
      path: "/",
      siteId: "site_1",
      status: "open",
      createdAt: new Date("2026-05-10T12:10:00.000Z"),
      createdByUserId: "user_2",
      createdByDisplayName: "Thiago",
    });

    await expect(
      activatePageSiteRelease({
        context,
        repository,
        requestId: "req_activate_root_release_blocked",
        storage,
        input: {
          siteRef: "site_1",
          releaseId: rootReleaseId,
        },
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_unread_comments" },
    });
    expect(repository.uploadSessions).toHaveLength(uploadCount);
    expect(repository.publishes).toHaveLength(publishCount);
    expect(repository.releases).toHaveLength(releaseCount);

    repository.pageCommentReadReceipts.push({
      id: "receipt_activate",
      path: "/",
      siteId: "site_1",
      userId: "user_1",
      lastReadAt: new Date("2026-05-10T12:11:00.000Z"),
      lastReadCommentCreatedAt: new Date("2026-05-10T12:10:00.000Z"),
    });

    const activated = await activatePageSiteRelease({
      context,
      repository,
      requestId: "req_activate_root_release",
      storage,
      input: {
        siteRef: "site_1",
        releaseId: rootReleaseId,
      },
    });

    expect(activated.release.id).toBe(rootReleaseId);
    expect(activated.site.activeReleaseId).toBe(rootReleaseId);
    expect(activated.url).toBe("https://demo.ravi.page/");
    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBe(rootReleaseId);
    expect(repository.uploadSessions).toHaveLength(uploadCount);
    expect(repository.publishes).toHaveLength(publishCount);
    expect(repository.releases).toHaveLength(releaseCount);
    expect(repository.usageEvents.filter((event) => event.eventType === "pages.release_activated")).toHaveLength(releaseUsageCount + 1);
    expect(repository.usageEvents.at(-1)).toMatchObject({
      eventType: "pages.release_activated",
      releaseId: rootReleaseId,
      publishId: null,
      requestId: "req_activate_root_release",
    });
    expect(repository.releases.find((release) => release.id === rootReleaseId)?.status).toBe("active");
    expect(repository.releases.find((release) => release.id === pitchReleaseId)?.status).toBe("archived");
    expect(
      repository.auditEvents.find(
        (event) =>
          event.action === "page_site_release.activated" &&
          event.targetId === rootReleaseId &&
          event.requestId === "req_activate_root_release",
      ),
    ).toMatchObject({
      action: "page_site_release.activated",
      targetId: rootReleaseId,
      metadataJson: {
        previousReleaseId: pitchReleaseId,
        activeReleaseChanged: true,
      },
    });
    expect(repository.auditEvents.at(-1)).toMatchObject({
      action: "page_site.edge_manifest_written",
      targetId: "site_1",
      metadataJson: {
        manifestKey: "sites/demo.ravi.page/active.json",
        releaseId: rootReleaseId,
      },
    });
  });

  test("compares releases by route and file, and diffs a text file between them", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const publishRoute = async (label: string, slug: string, route: { path: string; matchType: "spa" | "prefix" }, replaceRelease?: boolean) => {
      const upload = await createPageUploadSession({
        context,
        input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest(label) },
        repository,
        requestId: `req_upload_${label}`,
        storage,
      });
      const result = await finalizePageUploadSession({
        context,
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: `finalize-${label}`,
          packageManifest: packageManifest(label),
          artifact: { slug, name: slug },
          publish: { siteRef: "site_1", route, ...(replaceRelease ? { replaceRelease } : {}) },
        },
        repository,
        requestId: `req_finalize_${label}`,
        storage,
      });
      if (!result.release) throw new Error("Expected a release.");
      return result.release.id;
    };

    const first = await publishRoute("diff-home", "diff-home", { path: "/", matchType: "spa" }, true);
    const second = await publishRoute("diff-pitch", "diff-pitch", { path: "/pitch", matchType: "prefix" });
    const third = await publishRoute("diff-home-2", "diff-home", { path: "/", matchType: "spa" });

    const added = await comparePageSiteReleases({ context, repository, input: { siteRef: "site_1", releaseId: second } });
    expect(added.base?.id).toBe(first);
    expect(added.summary).toMatchObject({ routesAdded: 1, routesUnchanged: 1, filesAdded: 2 });
    expect(added.routes[0]).toMatchObject({ path: "/pitch", status: "added" });

    const changed = await comparePageSiteReleases({ context, repository, input: { siteRef: "site_1", releaseId: third } });
    expect(changed.base?.id).toBe(second);
    expect(changed.routes[0]).toMatchObject({ path: "/", status: "changed", changes: ["content"], unchangedFileCount: 0 });
    expect(changed.routes[0]?.files.map((file) => [file.path, file.status, file.textDiffAvailable])).toEqual([
      ["assets/app.js", "changed", true],
      ["index.html", "changed", true],
    ]);
    expect(changed.summary).toMatchObject({ routesChanged: 1, routesUnchanged: 1, filesChanged: 2 });

    const restorePreview = await comparePageSiteReleases({
      context,
      repository,
      input: { siteRef: "site_1", releaseId: first, baseReleaseId: third },
    });
    expect(restorePreview.activeReleaseId).toBe(third);
    expect(restorePreview.routes.map((route) => [route.path, route.status])).toEqual([
      ["/", "changed"],
      ["/pitch", "removed"],
    ]);

    const readKeys: string[] = [];
    const readable: PageObjectStorage = {
      ...storage,
      async readObjectText({ key }) {
        readKeys.push(key);
        return `<h1>shared</h1>\n<p>${key.includes(changed.routes[0]?.target?.artifactVersionId ?? "?") ? "new" : "old"}</p>\n`;
      },
    };
    const fileDiff = await getPageSiteReleaseFileDiff({
      context,
      repository,
      storage: readable,
      input: { siteRef: "site_1", releaseId: third, routePath: "/", file: "index.html" },
    });
    expect(readKeys).toHaveLength(2);
    expect(fileDiff).toMatchObject({ status: "changed", diff: { kind: "text", added: 1, removed: 1, truncated: false } });
    if (fileDiff.diff.kind !== "text") throw new Error("Expected a text diff.");
    expect(fileDiff.diff.hunks[0]?.lines.map((line) => [line.type, line.text])).toEqual([
      ["context", "<h1>shared</h1>"],
      ["removed", "<p>old</p>"],
      ["added", "<p>new</p>"],
    ]);

    const noBytes = await getPageSiteReleaseFileDiff({
      context,
      repository,
      storage,
      input: { siteRef: "site_1", releaseId: third, routePath: "/", file: "index.html" },
    });
    expect(noBytes.diff).toEqual({ kind: "unavailable" });

    await expect(
      comparePageSiteReleases({
        context: { ...context, actorId: "user_outside", membershipRole: "member" },
        repository,
        input: { siteRef: "site_1", releaseId: third },
      }),
    ).rejects.toMatchObject({ payload: { error: "publish_forbidden" } });
  });

  test("keeps activation authoritative and marks edge manifest failed when ready write fails after commit", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const flakyStorage: PageObjectStorage = {
      ...storage,
      async writeSiteManifest(input) {
        if ((input.manifest as { edgeState?: string }).edgeState === "ready") {
          throw new Error("r2 active manifest write denied");
        }
        return storage.writeSiteManifest(input);
      },
    };

    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("edge-fail") },
      repository,
      requestId: "req_upload_edge_fail",
      storage: flakyStorage,
    });
    const result = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "edge-fail",
        packageManifest: packageManifest("edge-fail"),
        artifact: { slug: "edge-fail", name: "Edge Fail" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_edge_fail",
      storage: flakyStorage,
    });

    const site = repository.sites.find((item) => item.id === "site_1");
    expect(result.release?.id).toBeTruthy();
    expect(site?.activeReleaseId).toBe(result.release?.id);
    expect((site?.metadataJson as { edgeManifest?: { status?: string; releaseId?: string } }).edgeManifest).toMatchObject({
      status: "failed",
      releaseId: result.release?.id,
    });
    expect(repository.auditEvents.some((event) => event.action === "page_site.edge_manifest_pending")).toBe(true);
    expect(repository.auditEvents.some((event) => event.action === "page_site.edge_manifest_failed")).toBe(true);
  });

  test("rewrites a pending barrier when a ready edge manifest write is superseded", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const supersedingReleaseId = "release_superseding";
    const raceStorage: PageObjectStorage = {
      ...storage,
      async writeSiteManifest(input) {
        const result = await storage.writeSiteManifest(input);
        if ((input.manifest as { edgeState?: string }).edgeState === "ready") {
          const site = repository.sites.find((item) => item.id === "site_1");
          const release = repository.releases.find((item) => item.id === (input.manifest as { release?: { id?: string } }).release?.id);
          if (!site || !release) throw new Error("Expected site and release for superseded test.");
          repository.releases.push({
            ...release,
            id: supersedingReleaseId,
            releaseNumber: 999,
            status: "active",
          });
          site.activeReleaseId = supersedingReleaseId;
        }
        return result;
      },
    };

    await finalizeUnpublishedArtifact(repository, context, storage, "superseded-seed");
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("superseded") },
      repository,
      requestId: "req_upload_superseded",
      storage: raceStorage,
    });

    await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "superseded",
        packageManifest: packageManifest("superseded"),
        artifact: { slug: "superseded", name: "Superseded" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_superseded",
      storage: raceStorage,
    });

    const activeManifest = storage.siteManifests.get("sites/demo.ravi.page/active.json") as {
      edgeState?: string;
      release?: { id?: string };
      routes?: unknown[];
    };
    expect(activeManifest.edgeState).toBe("pending");
    expect(activeManifest.release?.id).toBe(supersedingReleaseId);
    expect(activeManifest.routes).toEqual([]);
  });

  test("re-running finalize with the same idempotency key returns the original publish", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", idempotencyKey: "upload-idem", packageManifest: packageManifest("idem") },
      repository,
      requestId: "req_upload",
      storage,
    });

    const input = {
      uploadSessionId: upload.uploadSession.id,
      idempotencyKey: "finalize-idem",
      packageManifest: packageManifest("idem"),
      artifact: { slug: "idem", name: "Idem" },
      publish: {
        siteRef: "site_1",
        route: { path: "/", matchType: "spa" as const },
      },
    };

    const first = await finalizePageUploadSession({ context, input, repository, requestId: "req_first", storage });
    const second = await finalizePageUploadSession({ context, input, repository, requestId: "req_second", storage });

    expect(second.publish.id).toBe(first.publish.id);
    expect(second.url).toBe("https://demo.ravi.page/");
    expect(second.artifactVersion.id).toBe(first.artifactVersion.id);
    expect(repository.artifactVersions).toHaveLength(1);
    expect(repository.publishes).toHaveLength(1);
  });

  test("rejects finalize attempts from a different actor than the upload session owner", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("actor-bound") },
      repository,
      requestId: "req_actor_upload",
      storage,
    });

    await expect(
      finalizePageUploadSession({
        context: {
          ...context,
          actorId: "user_2",
        },
        input: {
          uploadSessionId: upload.uploadSession.id,
          packageManifest: packageManifest("actor-bound"),
          artifact: { slug: "actor-bound", name: "Actor Bound" },
        },
        repository,
        requestId: "req_actor_finalize",
        storage,
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_upload_missing" },
    });
  });

  test("creates a direct per-file upload policy from the package manifest", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const upload = await createPageUploadSession({
      context,
      input: {
        projectRef: "proj_1",
        siteRef: "site_1",
        idempotencyKey: "upload-policy",
        packageManifest: packageManifest("policy"),
      },
      repository,
      requestId: "req_upload_policy",
      storage,
    });

    expect(upload.uploadPolicy).toMatchObject({
      directUpload: true,
      driver: "memory",
      stagingPrefix: upload.uploadSession.stagingPrefix,
    });
    expect(upload.uploadPolicy.files).toEqual([
      expect.objectContaining({
        path: "index.html",
        stagingKey: `${upload.uploadSession.stagingPrefix}/index.html`,
        method: "PUT",
        headers: expect.objectContaining({
          "x-amz-meta-ravi-sha256": shaFor("policy", "html"),
          "x-amz-meta-ravi-size-bytes": "100",
        }),
      }),
      expect.objectContaining({
        path: "assets/app.js",
        stagingKey: `${upload.uploadSession.stagingPrefix}/assets/app.js`,
        method: "PUT",
      }),
    ]);
    expect(upload.uploadSession.fileManifestJson).toMatchObject({
      entrypoint: "index.html",
      files: expect.arrayContaining([expect.objectContaining({ path: "index.html" })]),
    });
    expect(upload.uploadSession).not.toHaveProperty("uploadPolicyJson");
    const storedPolicy = repository.uploadSessions.at(-1)?.uploadPolicyJson as { files?: Array<Record<string, unknown>> };
    expect(storedPolicy).toMatchObject({
      driver: "memory",
    });
    expect(storedPolicy.files?.every((file) => !("url" in file))).toBe(true);
  });

  test("allows CLI publish sessions using publish scope and an authorized role", async () => {
    const repository = createInMemoryPublishRepository();
    const context: PagePublishContext = {
      ...publishContext(),
      actorType: "cli",
      membershipRole: "developer",
      scopes: ["artifacts.publish"],
    };
    const storage = memoryStorage();

    const upload = await createPageUploadSession({
      context,
      input: {
        projectRef: "proj_1",
        siteRef: "site_1",
        packageManifest: packageManifest("cli-scope"),
      },
      repository,
      requestId: "req_cli_scope",
      storage,
    });

    expect(upload.uploadSession.createdByActorType).toBe("cli");
    expect(upload.uploadPolicy.files).toHaveLength(2);
  });

  test("allows CLI project publishes under an explicit developer policy rule", async () => {
    const repository = createInMemoryPublishRepository();
    const context: PagePublishContext = {
      ...publishContext(),
      actorId: "user_without_project",
      actorType: "cli",
      membershipRole: "developer",
      scopes: ["artifacts.publish"],
    };
    const storage = memoryStorage();

    const upload = await createPageUploadSession({
      context,
      input: {
        projectRef: "proj_1",
        siteRef: "site_1",
        packageManifest: packageManifest("cli-org-dev-project"),
      },
      repository,
      requestId: "req_cli_org_dev_project",
      storage,
    });

    expect(upload.uploadSession.createdByActorId).toBe("user_without_project");
    expect(upload.uploadPolicy.files).toHaveLength(2);
  });

  test("rejects stale upload-session idempotency retries instead of reissuing expired policies", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    await createPageUploadSession({
      context,
      input: {
        projectRef: "proj_1",
        siteRef: "site_1",
        idempotencyKey: "stale-upload",
        packageManifest: packageManifest("stale"),
      },
      repository,
      requestId: "req_stale_upload",
      storage,
    });
    Object.assign(repository.uploadSessions.at(-1) ?? {}, { expiresAt: new Date("2000-01-01T00:00:00.000Z") });

    await expect(
      createPageUploadSession({
        context,
        input: {
          projectRef: "proj_1",
          siteRef: "site_1",
          idempotencyKey: "stale-upload",
          packageManifest: packageManifest("stale"),
        },
        repository,
        requestId: "req_stale_retry",
        storage,
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_upload_missing" },
    });
  });

  test("rejects CLI publish sessions when scope exists but no policy grants publishing", async () => {
    const repository = createInMemoryPublishRepository();
    const context: PagePublishContext = {
      ...publishContext(),
      actorType: "cli",
      membershipRole: "member",
      actorId: "user_without_grant",
      scopes: ["artifacts.publish"],
    };
    const storage = memoryStorage();

    await expect(
      createPageUploadSession({
        context,
        input: {
          projectRef: "proj_1",
          siteRef: "site_1",
          packageManifest: packageManifest("cli-role-denied"),
        },
        repository,
        requestId: "req_cli_role_denied",
        storage,
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_forbidden" },
    });
  });

  test("rejects CLI publish sessions without the artifact publish scope", async () => {
    const repository = createInMemoryPublishRepository();
    const context: PagePublishContext = {
      ...publishContext(),
      actorType: "cli",
      membershipRole: "owner",
      scopes: ["console.projects.read"],
    };
    const storage = memoryStorage();

    await expect(
      createPageUploadSession({
        context,
        input: {
          projectRef: "proj_1",
          siteRef: "site_1",
          packageManifest: packageManifest("cli-denied"),
        },
        repository,
        requestId: "req_cli_denied",
        storage,
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_forbidden" },
    });
  });

  test("server-controlled upload policy fields override caller-provided policy hints", async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const previousDriver = process.env.RAVI_PAGES_STORAGE_DRIVER;
    const previousNodeEnv = mutableEnv.NODE_ENV;
    process.env.RAVI_PAGES_STORAGE_DRIVER = "metadata";
    mutableEnv.NODE_ENV = "test";
    try {
      const storage = createPageObjectStorageFromEnv();
      const policy = await storage.createUploadPolicy({
        stagingPrefix: "staging/safe",
        expiresAt: new Date("2026-05-10T12:10:00.000Z"),
        files: [
          {
            path: "index.html",
            sha256: shaFor("policy", "html"),
            sizeBytes: 100,
            contentType: "text/html; charset=utf-8",
            stagingKey: null,
            cache: "entrypoint",
          },
        ],
        uploadPolicy: {
          driver: "client",
          directUpload: true,
          stagingPrefix: "staging/evil",
          files: [{ path: "index.html", stagingKey: "staging/evil/index.html" }],
          trace: "kept",
        },
      });

      expect(policy).toMatchObject({
        driver: "metadata",
        directUpload: false,
        stagingPrefix: "staging/safe",
        trace: "kept",
      });
      expect(policy.files).toEqual([
        expect.objectContaining({
          path: "index.html",
          stagingKey: "staging/safe/index.html",
          method: "metadata",
        }),
      ]);
    } finally {
      if (previousDriver === undefined) {
        delete process.env.RAVI_PAGES_STORAGE_DRIVER;
      } else {
        process.env.RAVI_PAGES_STORAGE_DRIVER = previousDriver;
      }
      if (previousNodeEnv === undefined) {
        delete mutableEnv.NODE_ENV;
      } else {
        mutableEnv.NODE_ENV = previousNodeEnv;
      }
    }
  });

  test("R2 manifest writes include content-length for storage providers that reject chunked PUT", async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const envKeys = [
      "RAVI_PAGES_STORAGE_DRIVER",
      "RAVI_PAGES_ALLOW_METADATA_STORAGE",
      "RAVI_PAGES_R2_BUCKET",
      "RAVI_PAGES_R2_ACCOUNT_ID",
      "RAVI_PAGES_R2_ENDPOINT",
      "RAVI_PAGES_R2_REGION",
      "RAVI_PAGES_R2_ACCESS_KEY_ID",
      "RAVI_PAGES_R2_SECRET_ACCESS_KEY",
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, mutableEnv[key]]));
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    try {
      delete mutableEnv.RAVI_PAGES_STORAGE_DRIVER;
      delete mutableEnv.RAVI_PAGES_ALLOW_METADATA_STORAGE;
      mutableEnv.RAVI_PAGES_R2_BUCKET = "ravi-pages-assets";
      mutableEnv.RAVI_PAGES_R2_ACCOUNT_ID = "account123";
      delete mutableEnv.RAVI_PAGES_R2_ENDPOINT;
      mutableEnv.RAVI_PAGES_R2_REGION = "auto";
      mutableEnv.RAVI_PAGES_R2_ACCESS_KEY_ID = "access";
      mutableEnv.RAVI_PAGES_R2_SECRET_ACCESS_KEY = "secret";

      const storage = createPageObjectStorageFromEnv();
      await storage.writeManifest({
        organizationId: "org_1",
        projectId: "proj_1",
        artifactId: "art_1",
        artifactVersionId: "ver_1",
        manifest: { files: [], entrypoint: "index.html" },
      });
      await storage.writeSiteManifest({
        hostname: "demo.ravi.page",
        manifest: { edgeState: "ready", release: { id: "rel_1" } },
      });

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        const body = await request.clone().text();
        expect(request.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        const previous = previousEnv[key];
        if (previous === undefined) {
          delete mutableEnv[key];
        } else {
          mutableEnv[key] = previous;
        }
      }
    }
  });

  test("R2 staged object verification uses bounded concurrency for multi-file publishes", async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const envKeys = [
      "RAVI_PAGES_STORAGE_CONCURRENCY",
      "RAVI_PAGES_STORAGE_DRIVER",
      "RAVI_PAGES_ALLOW_METADATA_STORAGE",
      "RAVI_PAGES_R2_BUCKET",
      "RAVI_PAGES_R2_ACCOUNT_ID",
      "RAVI_PAGES_R2_ENDPOINT",
      "RAVI_PAGES_R2_REGION",
      "RAVI_PAGES_R2_ACCESS_KEY_ID",
      "RAVI_PAGES_R2_SECRET_ACCESS_KEY",
    ];
    const previousEnv = Object.fromEntries(envKeys.map((key) => [key, mutableEnv[key]]));
    const originalFetch = globalThis.fetch;
    const files = Array.from({ length: 10 }, (_, index) => {
      const body = `file-${index}`;
      return {
        path: `assets/file-${index}.txt`,
        body,
        sha256: createHash("sha256").update(body).digest("hex"),
        sizeBytes: Buffer.byteLength(body),
        contentType: "text/plain",
      };
    });
    let activeFetches = 0;
    let maxActiveFetches = 0;

    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      activeFetches += 1;
      maxActiveFetches = Math.max(maxActiveFetches, activeFetches);
      await delay(2);
      activeFetches -= 1;

      const pathname = decodeURIComponent(new URL(request.url).pathname);
      const file = files.find((candidate) => pathname.endsWith(`/${candidate.path}`));
      if (!file) return new Response("not found", { status: 404 });

      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(file.sizeBytes),
            "x-amz-meta-ravi-sha256": file.sha256,
          },
        });
      }

      return new Response(file.body, { status: 200 });
    }) as unknown as typeof fetch;

    try {
      mutableEnv.RAVI_PAGES_STORAGE_CONCURRENCY = "4";
      delete mutableEnv.RAVI_PAGES_STORAGE_DRIVER;
      delete mutableEnv.RAVI_PAGES_ALLOW_METADATA_STORAGE;
      mutableEnv.RAVI_PAGES_R2_BUCKET = "ravi-pages-assets";
      mutableEnv.RAVI_PAGES_R2_ACCOUNT_ID = "account123";
      delete mutableEnv.RAVI_PAGES_R2_ENDPOINT;
      mutableEnv.RAVI_PAGES_R2_REGION = "auto";
      mutableEnv.RAVI_PAGES_R2_ACCESS_KEY_ID = "access";
      mutableEnv.RAVI_PAGES_R2_SECRET_ACCESS_KEY = "secret";

      const storage = createPageObjectStorageFromEnv();
      await storage.verifyStagedObjects({
        uploadSession: {
          stagingPrefix: "staging/org/org_1/project/proj_1/upload/upl_1",
        } as never,
        files: files.map((file) => ({
          ...file,
          cache: "static",
          stagingKey: `staging/org/org_1/project/proj_1/upload/upl_1/${file.path}`,
        })),
      });

      expect(maxActiveFetches).toBeGreaterThan(1);
      expect(maxActiveFetches).toBeLessThanOrEqual(4);
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of envKeys) {
        const previous = previousEnv[key];
        if (previous === undefined) {
          delete mutableEnv[key];
        } else {
          mutableEnv[key] = previous;
        }
      }
    }
  });

  test("finalize promotes multi-file packages with bounded concurrency", async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const previousConcurrency = mutableEnv.RAVI_PAGES_STORAGE_CONCURRENCY;
    mutableEnv.RAVI_PAGES_STORAGE_CONCURRENCY = "3";
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const baseStorage = memoryStorage();
    let activePromotions = 0;
    let maxActivePromotions = 0;
    const storage: MemoryPageObjectStorage = {
      ...baseStorage,
      async promoteObject(input) {
        activePromotions += 1;
        maxActivePromotions = Math.max(maxActivePromotions, activePromotions);
        await delay(2);
        try {
          return await baseStorage.promoteObject(input);
        } finally {
          activePromotions -= 1;
        }
      },
    };
    const manifest = multiFilePackageManifest("parallel-promote", 9);

    try {
      const upload = await createPageUploadSession({
        context,
        input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: manifest },
        repository,
        requestId: "req_upload_parallel_promote",
        storage,
      });

      await finalizePageUploadSession({
        context,
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: "finalize-parallel-promote",
          packageManifest: manifest,
          artifact: { slug: "parallel-promote", name: "Parallel Promote" },
          publish: {
            siteRef: "site_1",
            route: { path: "/parallel-promote", matchType: "spa" },
          },
        },
        repository,
        requestId: "req_finalize_parallel_promote",
        storage,
      });

      expect(maxActivePromotions).toBeGreaterThan(1);
      expect(maxActivePromotions).toBeLessThanOrEqual(3);
    } finally {
      if (previousConcurrency === undefined) {
        delete mutableEnv.RAVI_PAGES_STORAGE_CONCURRENCY;
      } else {
        mutableEnv.RAVI_PAGES_STORAGE_CONCURRENCY = previousConcurrency;
      }
    }
  });

  test("fails closed when staged object verification fails", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage({ skipStagePaths: ["assets/app.js"] });

    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("missing") },
      repository,
      requestId: "req_upload_missing",
      storage,
    });

    await expect(
      finalizePageUploadSession({
        context,
        repository,
        requestId: "req_missing",
        storage,
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: "missing-staged",
          artifact: { slug: "missing-staged" },
          packageManifest: packageManifest("missing"),
          publish: {
            siteRef: "site_1",
            route: { path: "/", matchType: "spa" },
          },
        },
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_storage_failed" },
    });

    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBeNull();
    expect(repository.uploadSessions.at(-1)?.status).toBe("failed");
  });

  test("repairs the active edge manifest when finalize fails after writing a pending barrier", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();

    const activeUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("active-before-fail") },
      repository,
      requestId: "req_upload_active_before_fail",
      storage,
    });
    const active = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: activeUpload.uploadSession.id,
        idempotencyKey: "active-before-fail",
        packageManifest: packageManifest("active-before-fail"),
        artifact: { slug: "active-before-fail", name: "Active Before Fail" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_active_before_fail",
      storage,
    });
    expect((storage.siteManifests.get("sites/demo.ravi.page/active.json") as { edgeState?: string }).edgeState).toBe("ready");

    const failingStorage: PageObjectStorage = {
      ...storage,
      async verifyStagedObjects() {
        throw new Error("staged object unavailable");
      },
    };
    const failedUpload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("fail-after-pending") },
      repository,
      requestId: "req_upload_fail_after_pending",
      storage,
    });

    await expect(
      finalizePageUploadSession({
        context,
        input: {
          uploadSessionId: failedUpload.uploadSession.id,
          idempotencyKey: "fail-after-pending",
          packageManifest: packageManifest("fail-after-pending"),
          artifact: { slug: "fail-after-pending", name: "Fail After Pending" },
          publish: {
            siteRef: "site_1",
            route: { path: "/", matchType: "spa" },
            replaceRelease: true,
          },
        },
        repository,
        requestId: "req_finalize_fail_after_pending",
        storage: failingStorage,
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_storage_failed" },
    });

    const activeManifest = storage.siteManifests.get("sites/demo.ravi.page/active.json") as {
      edgeState?: string;
      release?: { id?: string };
    };
    expect(activeManifest.edgeState).toBe("ready");
    expect(activeManifest.release?.id).toBe(active.release?.id);
    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBe(active.release?.id);
    expect(repository.uploadSessions.at(-1)?.status).toBe("failed");
  });

  test("publishes a manifest release across two sites in one project without cross-site activation", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const home = await finalizeUnpublishedArtifact(repository, context, storage, "home");
    const docs = await finalizeUnpublishedArtifact(repository, context, storage, "docs");

    const release = await createPageSiteRelease({
      context,
      repository,
      requestId: "req_manifest",
      storage,
      input: {
        projectRef: "proj_1",
        siteRef: "site_2",
        activate: true,
        replaceRelease: true,
        routes: [
          {
            path: "/",
            matchType: "spa",
            artifactVersionId: home.artifactVersion.id,
          },
          {
            path: "/docs",
            matchType: "prefix",
            artifactVersionId: docs.artifactVersion.id,
          },
        ],
      },
    });

    expect(release.routes.map((route) => route.path).sort()).toEqual(["/", "/docs"]);
    expect(repository.sites.find((site) => site.id === "site_2")?.activeReleaseId).toBe(release.release.id);
    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBeNull();
  });

  test("deduplicates artifact version files in active edge manifests", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const home = await finalizeUnpublishedArtifact(repository, context, storage, "shared-home");

    await createPageSiteRelease({
      context,
      repository,
      requestId: "req_dedupe_manifest",
      storage,
      input: {
        projectRef: "proj_1",
        siteRef: "site_1",
        activate: true,
        replaceRelease: true,
        routes: [
          {
            path: "/",
            matchType: "spa",
            artifactVersionId: home.artifactVersion.id,
          },
          {
            path: "/landing",
            matchType: "prefix",
            artifactVersionId: home.artifactVersion.id,
          },
        ],
      },
    });

    const activeManifest = storage.siteManifests.get("sites/demo.ravi.page/active.json") as {
      artifacts?: unknown[];
      routes?: Array<{ files?: unknown[] }>;
    };
    expect(activeManifest.artifacts).toHaveLength(1);
    expect(activeManifest.routes).toHaveLength(2);
    expect(activeManifest.routes?.every((route) => route.files === undefined)).toBe(true);
  });

  test("repairs the active edge manifest after a public fallback miss", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("repair") },
      repository,
      requestId: "req_upload_repair",
      storage,
    });
    const publish = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "repair",
        packageManifest: packageManifest("repair"),
        artifact: { slug: "repair", name: "Repair" },
        publish: {
          siteRef: "site_1",
          route: { path: "/", matchType: "spa" },
          replaceRelease: true,
        },
      },
      repository,
      requestId: "req_finalize_repair",
      storage,
    });

    storage.siteManifests.delete("sites/demo.ravi.page/active.json");
    const hookCallsBeforeRepair = knowledgeHookCalls.length;
    const result = await repairActiveSiteEdgeManifest({
      organizationId: context.organizationId,
      reason: "manifest_missing",
      repository,
      requestId: "req_repair_missing_manifest",
      siteRef: "site_1",
      storage,
    });

    const activeManifest = storage.siteManifests.get("sites/demo.ravi.page/active.json") as {
      edgeState?: string;
      release?: { id?: string };
    };
    expect(result).toMatchObject({
      status: "repaired",
      releaseId: publish.release?.id,
      siteId: "site_1",
    });
    expect(activeManifest.edgeState).toBe("ready");
    expect(activeManifest.release?.id).toBe(publish.release?.id);
    expect(knowledgeHookCalls.slice(hookCallsBeforeRepair)).toEqual([
      { siteId: "site_1", releaseId: publish.release!.id, requestId: "req_repair_missing_manifest" },
    ]);
    expect(repository.auditEvents.at(-1)).toMatchObject({
      action: "page_site.edge_manifest_repair",
      metadataJson: {
        reason: "manifest_missing",
        resultStatus: "repaired",
      },
    });
  });

  test("skips automatic edge manifest repair during recent failure cooldown", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const site = repository.sites.find((item) => item.id === "site_1");
    if (!site) throw new Error("Expected test site.");
    site.activeReleaseId = "release_recent_failure";
    site.metadataJson = {
      edgeManifest: {
        status: "failed",
        releaseId: "release_recent_failure",
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await repairActiveSiteEdgeManifest({
      organizationId: context.organizationId,
      reason: "manifest_invalid",
      repository,
      requestId: "req_repair_cooldown",
      siteRef: "site_1",
      storage,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "cooldown_failed",
      releaseId: "release_recent_failure",
      siteId: "site_1",
    });
    expect(storage.siteManifests.has("sites/demo.ravi.page/active.json")).toBe(false);
  });

  test("rejects invalid package paths with the coarse publish validation error", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("bad-path") },
      repository,
      requestId: "req_upload_invalid",
      storage,
    });

    await expect(
      finalizePageUploadSession({
        context,
        repository,
        requestId: "req_invalid",
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: "invalid-path",
          artifact: { slug: "bad-path" },
          packageManifest: {
            entrypoint: "index.html",
            files: [
              { path: "index.html", sizeBytes: 10 },
              { path: "../secret.txt", sizeBytes: 1 },
            ],
          },
          publish: {
            siteRef: "site_1",
            route: { path: "/", matchType: "spa" },
          },
        },
        storage,
      }),
    ).rejects.toMatchObject({
      payload: { error: "publish_validation_failed" },
    });

    expect(repository.sites.find((site) => site.id === "site_1")?.activeReleaseId).toBeNull();
  });

  test("converts storage failures into a coarse storage error and records failed state", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", siteRef: "site_1", packageManifest: packageManifest("storage-fail") },
      repository,
      requestId: "req_upload_fail",
      storage,
    });

    const failingStorage: PageObjectStorage = {
      ...storage,
      async promoteObject() {
        throw new Error("r2 write denied");
      },
    };

    await expect(
      finalizePageUploadSession({
        context,
        repository,
        storage: failingStorage,
        requestId: "req_storage_fail",
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: "storage-fail",
          artifact: { slug: "storage-fail" },
          packageManifest: packageManifest("storage-fail"),
          publish: {
            siteRef: "site_1",
            route: { path: "/", matchType: "spa" },
          },
        },
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);

    const publish = repository.publishes.at(-1);
    expect(publish?.status).toBe("failed");
    expect(publish?.errorCode).toBe("publish_storage_failed");
    expect(repository.uploadSessions.at(-1)?.status).toBe("failed");
    const failureAudit = repository.auditEvents.find((event) => event.action === "page_publish.failed");
    expect(failureAudit?.metadataJson).toMatchObject({
      phase: "promote_objects",
      reason: "publish_storage_failed",
    });
    expect(typeof (failureAudit?.metadataJson as Record<string, unknown> | undefined)?.durationMs).toBe("number");
  });

  test("rejects unknown manifesto connector uses before creating an upload session", async () => {
    const repository = createInMemoryPublishRepository();

    await expect(
      createPageUploadSession({
        context: publishContext(),
        input: {
          projectRef: "proj_1",
          packageManifest: {
            ...packageManifest("bad-uses"),
            uses: ["not.a.catalog.action"],
          },
        },
        repository,
        requestId: "req_bad_uses",
        storage: memoryStorage(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "connector_capability_unsupported" },
    });
    expect(repository.uploadSessions).toHaveLength(0);
  });

  test("snapshots implemented connector uses onto the public package manifesto", async () => {
    const repository = createInMemoryPublishRepository();
    const upload = await createPageUploadSession({
      context: publishContext(),
      input: {
        projectRef: "proj_1",
        packageManifest: {
          ...packageManifest("good-uses"),
          uses: ["ravi.pages.sites.list", "ravi.pages.sites.list"],
        },
      },
      repository,
      requestId: "req_good_uses",
      storage: memoryStorage(),
    });

    expect(upload.uploadSession.fileManifestJson).toMatchObject({
      uses: ["ravi.pages.sites.list"],
    });
  });

  test("stores the connector allowlist sent on the finalize publish block", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", packageManifest: packageManifest("publish-uses") },
      repository,
      requestId: "req_upload_publish_uses",
      storage,
    });

    const result = await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "finalize-publish-uses",
        packageManifest: packageManifest("publish-uses"),
        artifact: { slug: "publish-uses", name: "Publish uses" },
        publish: {
          route: { path: "/pipeline" },
          uses: ["ravi.bases.views.query", "ravi.bases.views.describe", "ravi.bases.views.query"],
        },
      },
      repository,
      requestId: "req_finalize_publish_uses",
      storage,
    });

    const connectors = {
      catalogSchemaVersion: 1,
      uses: [
        { id: "ravi.bases.views.query", revision: 1 },
        { id: "ravi.bases.views.describe", revision: 1 },
      ],
    };
    expect(result.release).not.toBeNull();
    expect(repository.publishes[0]?.metadataJson).toMatchObject({ connectors });
    expect(repository.artifactVersions[0]?.metadataJson).toMatchObject({
      connectors,
      packageManifest: { uses: ["ravi.bases.views.query", "ravi.bases.views.describe"] },
    });
  });

  test("refuses a finalize whose publish block and manifest name different connector uses", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const manifest = { ...packageManifest("conflicting-uses"), uses: ["ravi.bases.views.query"] };
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", packageManifest: manifest },
      repository,
      requestId: "req_upload_conflicting_uses",
      storage,
    });
    const finalize = (uses: string[]) =>
      finalizePageUploadSession({
        context,
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: `finalize-conflicting-uses-${uses.join(",")}`,
          packageManifest: manifest,
          artifact: { slug: "conflicting-uses", name: "Conflicting uses" },
          publish: { route: { path: "/" }, uses },
        },
        repository,
        requestId: "req_finalize_conflicting_uses",
        storage,
      });

    await expect(finalize(["ravi.bases.views.query", "ravi.bases.views.rows.update"])).rejects.toMatchObject({
      payload: { error: "publish_validation_failed" },
    });
    await expect(finalize(["not.a.catalog.action"])).rejects.toMatchObject({
      payload: { error: "connector_capability_unsupported" },
    });
    expect(repository.publishes).toHaveLength(0);

    await finalize(["ravi.bases.views.query"]);
    expect(repository.publishes[0]?.metadataJson).toMatchObject({
      connectors: { uses: [{ id: "ravi.bases.views.query", revision: 1 }] },
    });
  });

  test("stores the page kit presentation sent on the finalize publish block on the artifact version", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const presentation = {
      v: 1,
      runtime: { version: "1.0.0", sha256: "a".repeat(64) },
      theme: { itemId: "6f1c0c1e-5b7a-4c39-9a51-0d6a3c1f2b10", ref: "org/acme", version: 3, hash: "b".repeat(64) },
      widgets: [{ itemId: "7a2d1d2f-6c8b-4d4a-8b62-1e7b4d2a3c21", ref: "org/pedido-card", version: 2 }],
    };
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", packageManifest: packageManifest("presentation") },
      repository,
      requestId: "req_upload_presentation",
      storage,
    });
    const before = upload.uploadSession.fileManifestJson;

    await finalizePageUploadSession({
      context,
      input: {
        uploadSessionId: upload.uploadSession.id,
        idempotencyKey: "finalize-presentation",
        packageManifest: packageManifest("presentation"),
        artifact: { slug: "presentation", name: "Presentation" },
        publish: { route: { path: "/" }, presentation },
      },
      repository,
      requestId: "req_finalize_presentation",
      storage,
    });

    expect(repository.artifactVersions[0]?.metadataJson).toMatchObject({ presentation });
    // Kept out of the package manifest and its hash.
    expect((repository.artifactVersions[0]?.metadataJson as { packageManifest?: Record<string, unknown> } | undefined)?.packageManifest?.presentation).toBeUndefined();
    expect(before).not.toHaveProperty("presentation");
  });

  test("refuses an invalid or oversized presentation before any publish row exists", async () => {
    const repository = createInMemoryPublishRepository();
    const context = publishContext();
    const storage = memoryStorage();
    const upload = await createPageUploadSession({
      context,
      input: { projectRef: "proj_1", packageManifest: packageManifest("bad-presentation") },
      repository,
      requestId: "req_upload_bad_presentation",
      storage,
    });
    const finalize = (presentation: unknown) =>
      finalizePageUploadSession({
        context,
        input: {
          uploadSessionId: upload.uploadSession.id,
          idempotencyKey: `finalize-bad-presentation-${JSON.stringify(presentation).length}`,
          packageManifest: packageManifest("bad-presentation"),
          artifact: { slug: "bad-presentation", name: "Bad presentation" },
          publish: { route: { path: "/" }, presentation },
        },
        repository,
        requestId: "req_finalize_bad_presentation",
        storage,
      });
    const valid = { v: 1, runtime: null, theme: null, widgets: [] };

    for (const presentation of [
      { ...valid, extra: true },
      { ...valid, v: 2 },
      { ...valid, theme: { itemId: "not-a-uuid", ref: "org/acme", version: 1, hash: "b".repeat(64) } },
      // Schema-valid but over 16 KiB.
      { ...valid, widgets: Array.from({ length: 90 }, () => ({ itemId: "7a2d1d2f-6c8b-4d4a-8b62-1e7b4d2a3c21", ref: `org/${"a".repeat(190)}`, version: 1 })) },
      "presentation",
    ]) {
      await expect(finalize(presentation)).rejects.toMatchObject({ payload: { error: "publish_validation_failed" } });
    }
    expect(repository.publishes).toHaveLength(0);
    expect(repository.artifactVersions).toHaveLength(0);
  });
});

async function finalizeUnpublishedArtifact(
  repository: ReturnType<typeof createInMemoryPublishRepository>,
  context: PagePublishContext,
  storage: PageObjectStorage,
  slug: string,
) {
  const upload = await createPageUploadSession({
    context,
    input: { projectRef: "proj_1", packageManifest: packageManifest(slug) },
    repository,
    requestId: `req_upload_${slug}`,
    storage,
  });
  return finalizePageUploadSession({
    context,
    repository,
    requestId: `req_finalize_${slug}`,
    input: {
      uploadSessionId: upload.uploadSession.id,
      idempotencyKey: `finalize-${slug}`,
      artifact: { slug, name: slug },
      packageManifest: packageManifest(slug),
    },
    storage,
  });
}

function packageManifest(label: string) {
  return {
    entrypoint: "index.html",
    files: [
      {
        path: "index.html",
        sha256: shaFor(label, "html"),
        sizeBytes: 100,
        contentType: "text/html; charset=utf-8",
      },
      {
        path: "assets/app.js",
        sha256: shaFor(label, "js"),
        sizeBytes: 50,
        contentType: "application/javascript",
      },
    ],
  };
}

function multiFilePackageManifest(label: string, count: number) {
  return {
    entrypoint: "index.html",
    files: Array.from({ length: count }, (_, index) => {
      const path = index === 0 ? "index.html" : `assets/file-${index}.txt`;
      return {
        path,
        sha256: shaFor(label, path),
        sizeBytes: 100 + index,
        contentType: index === 0 ? "text/html; charset=utf-8" : "text/plain",
      };
    }),
  };
}

describe("single-installation origin grant boundaries", () => {
  async function inMode(mode: string, run: () => Promise<void>) {
    const prior = process.env.RAVI_AUTH_MODE;
    process.env.RAVI_AUTH_MODE = mode;
    try { await run(); }
    finally { if (prior === undefined) delete process.env.RAVI_AUTH_MODE; else process.env.RAVI_AUTH_MODE = prior; }
  }
  async function publish(
    repository: ReturnType<typeof createInMemoryPublishRepository>, storage: MemoryPageObjectStorage,
    label: string, uses: string[] | undefined, siteRef = "site_1",
  ) {
    const manifest = { ...packageManifest(label), ...(uses === undefined ? {} : { uses }) };
    const upload = await createPageUploadSession({ context: publishContext(), input: { projectRef: "proj_1", siteRef, packageManifest: manifest }, repository, requestId: `upload-${label}`, storage });
    return finalizePageUploadSession({ context: publishContext(), input: {
      uploadSessionId: upload.uploadSession.id, idempotencyKey: `publish-${label}`, packageManifest: manifest,
      artifact: { slug: label, name: label }, publish: { siteRef, route: { path: `/${label}`, matchType: "prefix" } },
    }, repository, requestId: `publish-${label}`, storage });
  }

  test("publish refuses incompatible sibling code, preserves active release, permits separate host", async () => {
    await inMode("oidc", async () => {
      const repository = createInMemoryPublishRepository();
      const storage = memoryStorage();
      const first = await publish(repository, storage, "same-origin-a", []);
      await expect(publish(repository, storage, "same-origin-b", ["ravi.projects.list"]))
        .rejects.toMatchObject({ status: 409, payload: { error: "publish_origin_grants_conflict" } });
      expect(repository.sites[0]?.activeReleaseId).toBe(first.release?.id);
      expect(repository.releases).toHaveLength(1);
      const second = await publish(repository, storage, "separate-origin", ["ravi.projects.list"], "site_2");
      expect(second.site?.defaultHostname).not.toBe(first.site?.defaultHostname);
      expect(second.release?.status).toBe("active");
    });
  });

  test("same-grant multi-route works and absent-vs-empty differs by effective grant", async () => {
    await inMode("oidc", async () => {
      const repository = createInMemoryPublishRepository();
      const storage = memoryStorage();
      await publish(repository, storage, "equal-a", []);
      const second = await publish(repository, storage, "equal-b", []);
      expect(second.routes).toHaveLength(2);
      await expect(publish(repository, storage, "absent-grants", undefined))
        .rejects.toMatchObject({ payload: { error: "publish_origin_grants_conflict" } });
      expect(repository.sites[0]?.activeReleaseId).toBe(second.release?.id);
    });
  });

  test("rollback to legacy incompatible release and incompatible drafts are refused", async () => {
    const repository = createInMemoryPublishRepository();
    const storage = memoryStorage();
    let firstVersion = "";
    let legacyRelease = "";
    await inMode("workos", async () => {
      const first = await publish(repository, storage, "legacy-a", []);
      firstVersion = first.artifactVersion.id;
      const second = await publish(repository, storage, "legacy-b", ["ravi.projects.list"]);
      legacyRelease = second.release!.id;
    });
    await inMode("oidc", async () => {
      const context = publishContext();
      const replacement = await createPageSiteRelease({ context, input: { projectRef: "proj_1", siteRef: "site_1", replaceRelease: true,
        routes: [{ path: "/safe", artifactVersionId: firstVersion }] }, repository, requestId: "safe-release", storage });
      await expect(activatePageSiteRelease({ context, input: { siteRef: "site_1", releaseId: legacyRelease }, repository, requestId: "unsafe-rollback", storage }))
        .rejects.toMatchObject({ status: 409, payload: { error: "publish_origin_grants_conflict" } });
      expect(repository.sites[0]?.activeReleaseId).toBe(replacement.release.id);
      const legacy = await repository.listReleaseRoutes(legacyRelease);
      await expect(createPageSiteRelease({ context, input: { projectRef: "proj_1", siteRef: "site_1", activate: false, replaceRelease: true,
        routes: legacy.map(({ path, artifactVersionId }) => ({ path, artifactVersionId })) }, repository, requestId: "unsafe-draft", storage }))
        .rejects.toMatchObject({ payload: { error: "publish_origin_grants_conflict" } });
      expect(repository.sites[0]?.activeReleaseId).toBe(replacement.release.id);
    });
  });

  test("release assembly obtains the site lock before reading active routes", async () => {
    const repository = createInMemoryPublishRepository();
    const calls: string[] = [];
    const originalRead = repository.getActiveRelease;
    repository.lockSiteReleaseSequence = async () => { calls.push("lock"); };
    repository.getActiveRelease = async (id) => { calls.push("read"); return originalRead(id); };
    await inMode("oidc", async () => { await publish(repository, memoryStorage(), "serialized", []); });
    expect(calls.lastIndexOf("lock")).toBeLessThan(calls.lastIndexOf("read"));
  });
});

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shaFor(label: string, suffix: string) {
  return createHash("sha256").update(`${label}:${suffix}`).digest("hex");
}

function publishContext(): PagePublishContext {
  return {
    actorId: "user_1",
    actorType: "user",
    membershipRole: "owner",
    organizationId: "org_1",
    authorization: { installationId: "fixture-installation", sessionId: "fixture-session", bindingId: "fixture-binding", accessTokenJti: "fixture-jti" },
  };
}

function activePasswordPolicy(routeId: string): PagesPasswordPolicyRecord {
  return {
    id: "password_policy_1",
    organizationId: "org_1",
    projectId: "proj_1",
    siteId: "site_1",
    routeId,
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$test$test",
    version: 1,
    status: "active",
    configuredByUserId: "user_1",
    rotatedAt: new Date("2026-05-10T12:00:00.000Z"),
    disabledAt: null,
    createdAt: new Date("2026-05-10T12:00:00.000Z"),
    updatedAt: new Date("2026-05-10T12:00:00.000Z"),
  };
}

function passwordPolicyRepository(
  policy: PagesPasswordPolicyRecord | null,
): PagesPasswordAccessRepository {
  return {
    async findPolicyForScope(input) {
      return policy?.siteId === input.siteId && policy.routeId === input.routeId ? policy : null;
    },
  } as PagesPasswordAccessRepository;
}

type MemoryPageObjectStorage = PageObjectStorage & {
  siteManifests: Map<string, Record<string, unknown>>;
};

function memoryStorage(options: { skipStagePaths?: string[] } = {}): MemoryPageObjectStorage {
  const objects = new Map<string, { sha256: string; sizeBytes: number }>();
  const siteManifests = new Map<string, Record<string, unknown>>();
  const skipStagePaths = new Set(options.skipStagePaths ?? []);

  return {
    siteManifests,
    stagingPrefix(input) {
      return `staging/${input.uploadSessionId}`;
    },
    async createUploadPolicy(input) {
      const files = input.files.map((file) => {
        const stagingKey = `${input.stagingPrefix}/${file.path}`;
        if (!skipStagePaths.has(file.path)) {
          objects.set(stagingKey, { sha256: file.sha256, sizeBytes: file.sizeBytes });
        }
        return {
          path: file.path,
          stagingKey,
          method: "PUT",
          url: `memory://${stagingKey}`,
          headers: {
            "content-type": file.contentType,
            "x-amz-meta-ravi-path": file.path,
            "x-amz-meta-ravi-sha256": file.sha256,
            "x-amz-meta-ravi-size-bytes": String(file.sizeBytes),
          },
        };
      });
      return {
        driver: "memory",
        directUpload: true,
        stagingPrefix: input.stagingPrefix,
        expiresAt: input.expiresAt.toISOString(),
        files,
      };
    },
    async verifyStagedObjects(input) {
      for (const file of input.files) {
        const staged = objects.get(`${input.uploadSession.stagingPrefix}/${file.path}`);
        if (!staged || staged.sizeBytes !== file.sizeBytes || staged.sha256 !== file.sha256) {
          throw new Error(`missing staged object: ${file.path}`);
        }
      }
    },
    async promoteObject(input) {
      const stagingKey = `${input.stagingPrefix}/${input.path}`;
      if (!objects.has(stagingKey)) throw new Error(`missing staged object: ${input.path}`);
      const finalKey = `org/${input.organizationId}/project/${input.projectId}/artifact/${input.artifactId}/version/${input.artifactVersionId}/${input.path}`;
      objects.set(finalKey, { sha256: input.sha256, sizeBytes: input.sizeBytes });
      return {
        r2Key: finalKey,
      };
    },
    async writeManifest(input) {
      const key = `org/${input.organizationId}/project/${input.projectId}/artifact/${input.artifactId}/version/${input.artifactVersionId}/manifest.json`;
      objects.set(key, { sha256: "manifest", sizeBytes: JSON.stringify(input.manifest).length });
      return {
        r2Key: key,
      };
    },
    async writeSiteManifest(input) {
      const key = `sites/${input.hostname.toLowerCase()}/active.json`;
      siteManifests.set(key, input.manifest);
      objects.set(key, { sha256: "site-manifest", sizeBytes: JSON.stringify(input.manifest).length });
      return {
        r2Key: key,
      };
    },
  };
}

function createInMemoryPublishRepository() {
  const now = () => new Date("2026-05-10T12:00:00.000Z");
  const projects = [
    {
      id: "proj_1",
      organizationId: "org_1",
      slug: "demo",
      defaultVisibility: "public",
    },
  ];
  const projectMemberships = [
    {
      projectId: "proj_1",
      userId: "user_1",
      role: "developer",
      status: "active",
    },
  ];
  const sites = [
    {
      id: "site_1",
      organizationId: "org_1",
      projectId: "proj_1",
      slug: "demo",
      defaultHostname: "demo.ravi.page",
      defaultVisibility: "public",
      activeReleaseId: null,
      isDefault: true,
      status: "active",
      createdByActorType: "user",
      createdByActorId: "user_1",
      metadataJson: {},
      createdAt: now(),
      updatedAt: now(),
    },
    {
      id: "site_2",
      organizationId: "org_1",
      projectId: "proj_1",
      slug: "docs",
      defaultHostname: "docs.ravi.page",
      defaultVisibility: "public",
      activeReleaseId: null,
      isDefault: false,
      status: "active",
      createdByActorType: "user",
      createdByActorId: "user_1",
      metadataJson: {},
      createdAt: now(),
      updatedAt: now(),
    },
  ];
  const uploadSessions: Array<Record<string, unknown>> = [];
  const publishes: Array<Record<string, unknown>> = [];
  const artifacts: Array<Record<string, unknown>> = [];
  const artifactVersions: Array<Record<string, unknown>> = [];
  const assets: Array<Record<string, unknown>> = [];
  const usageEvents: Array<Record<string, unknown>> = [];
  const routes: Array<Record<string, unknown>> = [];
  const releases: Array<Record<string, unknown>> = [];
  const releaseRoutes: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];
  const pageComments: Array<Record<string, unknown>> = [];
  const pageCommentReadReceipts: Array<Record<string, unknown>> = [];

  const repository: PagePublishRepository & {
    auditEvents: Array<Record<string, unknown>>;
    artifactVersions: Array<Record<string, unknown>>;
    pageCommentReadReceipts: Array<Record<string, unknown>>;
    pageComments: Array<Record<string, unknown>>;
    publishes: Array<Record<string, unknown>>;
    releases: Array<Record<string, unknown>>;
    sites: Array<Record<string, unknown>>;
    uploadSessions: Array<Record<string, unknown>>;
    usageEvents: Array<Record<string, unknown>>;
  } = {
    auditEvents,
    artifactVersions,
    pageCommentReadReceipts,
    pageComments,
    publishes,
    releases,
    sites,
    uploadSessions,
    usageEvents,

    async authorizeProject(context, projectId, action) {
      const membership = await repository.findProjectMembership(projectId, context.actorId);
      return authorizeFixtureProject({ user: { id: context.actorId }, organization: { id: context.organizationId }, membership: { role: context.membershipRole } }, projectId, action, {
        projects, projectRole: membership?.status === "active" ? membership.role : null,
      });
    },

    async withTransaction(fn) {
      return fn(repository);
    },

    async findProjectByRef(organizationId, projectRef) {
      return (projects.find((project) => project.organizationId === organizationId && (project.id === projectRef || project.slug === projectRef)) ?? null) as never;
    },

    async findSiteByRef(organizationId, siteRef) {
      return (sites.find((site) => site.organizationId === organizationId && (site.id === siteRef || site.slug === siteRef)) ?? null) as never;
    },

    async findDefaultSite(projectId) {
      return (sites.find((site) => site.projectId === projectId && site.isDefault) ?? null) as never;
    },

    async findSiteByHost(organizationId, host) {
      return (
        sites.find(
          (site) =>
            site.organizationId === organizationId &&
            (site.defaultHostname === host || `${site.slug}.ravi.page` === host),
        ) ?? null
      ) as never;
    },

    async updateSiteEdgeManifestState(input) {
      const site = requireRecord(sites, input.siteId);
      Object.assign(site, {
        metadataJson: {
          ...(site.metadataJson as Record<string, unknown>),
          edgeManifest: input.edgeManifest,
        },
        updatedAt: input.now,
      });
    },

    async findProjectMembership(projectId, userId) {
      return (
        projectMemberships.find(
          (membership) => membership.projectId === projectId && membership.userId === userId && membership.status === "active",
        ) ?? null
      ) as never;
    },

    async findUploadSession(input) {
      return (
        uploadSessions.find(
          (session) =>
            session.organizationId === input.organizationId &&
            session.id === input.uploadSessionId &&
            session.createdByActorType === input.actorType &&
            session.createdByActorId === input.actorId,
        ) ?? null
      ) as never;
    },

    async findUploadSessionByIdempotencyKey(input) {
      return (uploadSessions.find((session) => matchesIdempotency(session, input)) ?? null) as never;
    },

    async createUploadSession(input) {
      const session = {
        ...input,
        status: "created",
        errorCode: null,
        finalizedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      uploadSessions.push(session);
      return session as never;
    },

    async updateUploadSession(input) {
      Object.assign(requireRecord(uploadSessions, input.id), input, { updatedAt: now() });
    },

    async findPublishByIdempotencyKey(input) {
      return (publishes.find((publish) => matchesIdempotency(publish, input)) ?? null) as never;
    },

    async findPublish(id) {
      return (publishes.find((publish) => publish.id === id) ?? null) as never;
    },

    async createPublish(input) {
      const publish = {
        id: `publish_${publishes.length + 1}`,
        ...input,
        errorCode: input.errorCode ?? null,
        completedAt: input.completedAt ?? null,
        createdAt: now(),
        updatedAt: now(),
      };
      publishes.push(publish);
      return publish as never;
    },

    async updatePublish(input) {
      const publish = requireRecord(publishes, input.id);
      Object.assign(publish, input, { updatedAt: now() });
      return publish as never;
    },

    async findArtifactByRef(projectId, artifactRef) {
      return (artifacts.find(
        (artifact) =>
          artifact.projectId === projectId &&
          (artifact.id === artifactRef || artifact.slug === artifactRef || artifact.localArtifactId === artifactRef),
      ) ?? null) as never;
    },

    async createArtifact(input) {
      const artifact = {
        id: `artifact_${artifacts.length + 1}`,
        ...input,
        status: "active",
        lastLocalVersion: null,
        lastCloudVersion: null,
        syncStatus: "cloud_synced",
        syncMetadataJson: {},
        createdAt: now(),
        updatedAt: now(),
      };
      artifacts.push(artifact);
      return artifact as never;
    },

    async updateArtifactVersionState(input) {
      Object.assign(requireRecord(artifacts, input.artifactId), {
        lastCloudVersion: input.lastCloudVersion,
        syncMetadataJson: input.syncMetadataJson,
        updatedAt: now(),
      });
    },

    async lockArtifactVersionSequence() {
      return undefined;
    },

    async nextArtifactVersionNumber(artifactId) {
      const versions = artifactVersions.filter((version) => version.artifactId === artifactId);
      return Math.max(0, ...versions.map((version) => Number(version.versionNumber))) + 1;
    },

    async createArtifactVersion(input) {
      const version = {
        id: `version_${artifactVersions.length + 1}`,
        ...input,
        status: input.status ?? "created",
        createdAt: now(),
      };
      artifactVersions.push(version);
      return version as never;
    },

    async updateArtifactVersionMetadata(input) {
      Object.assign(requireRecord(artifactVersions, input.artifactVersionId), {
        metadataJson: input.metadataJson,
        ...(input.status ? { status: input.status } : {}),
      });
    },

    async createAsset(input) {
      const asset = { id: `asset_${assets.length + 1}`, ...input, createdAt: now(), updatedAt: now() };
      assets.push(asset);
      return asset as never;
    },

    async createUsageEvent(input) {
      if (input.idempotencyKey && usageEvents.some((event) => event.organizationId === input.organizationId && event.eventType === input.eventType && event.idempotencyKey === input.idempotencyKey)) {
        return;
      }
      usageEvents.push({ id: `usage_${usageEvents.length + 1}`, ...input, createdAt: now() });
    },

    async findArtifactVersion(input) {
      const artifactVersion = artifactVersions.find((version) => version.id === input.artifactVersionId);
      const artifact = artifactVersion ? artifacts.find((item) => item.id === artifactVersion.artifactId) : null;
      const project = artifact ? projects.find((item) => item.id === artifact.projectId) : null;
      if (!artifactVersion || !artifact || !project || project.id !== input.projectId || project.organizationId !== input.organizationId) {
        return null;
      }
      return { artifact, artifactVersion } as never;
    },

    async listArtifactVersionFiles(input) {
      const artifact = artifacts.find((item) => item.id === input.artifactId);
      const artifactVersion = artifactVersions.find((version) => version.id === input.artifactVersionId);
      if (!artifact || !artifactVersion) return [];
      return assets
        .filter((asset) => asset.artifactId === input.artifactId && asset.artifactVersionId === input.artifactVersionId)
        .map((asset) => ({
          artifactStatus: artifact.status,
          versionStatus: artifactVersion.status,
          versionNumber: artifactVersion.versionNumber,
          versionSha256: artifactVersion.sha256,
          path: asset.path,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
          storageJson: asset.storageJson,
          metadataJson: asset.metadataJson,
        })) as never;
    },

    async findRoute(input) {
      return (routes.find((route) => route.siteId === input.siteId && route.path === input.path && route.matchType === input.matchType) ?? null) as never;
    },

    async createRoute(input) {
      const route = {
        id: `route_${routes.length + 1}`,
        ...input,
        status: "active",
        createdAt: now(),
        updatedAt: now(),
      };
      routes.push(route);
      return route as never;
    },

    async getActiveRelease(siteId) {
      const site = sites.find((item) => item.id === siteId);
      return (site?.activeReleaseId ? releases.find((release) => release.id === site.activeReleaseId) : null) as never;
    },

    async listReleaseRoutes(releaseId) {
      return releaseRoutes.filter((route) => route.releaseId === releaseId) as never;
    },

    async listUnreadPageCommentsForRoutes(input) {
      const receiptsByPath = new Map(
        pageCommentReadReceipts
          .filter((receipt) => receipt.siteId === input.siteId && receipt.userId === input.userId)
          .map((receipt) => [receipt.path, receipt]),
      );
      return pageComments
        .filter((comment) => {
          if (comment.siteId !== input.siteId) return false;
          if (!input.paths.includes(String(comment.path))) return false;
          if (comment.status !== "open") return false;
          if (comment.createdByUserId === input.userId) return false;
          const receipt = receiptsByPath.get(comment.path);
          const lastRead = receipt?.lastReadCommentCreatedAt;
          return !lastRead || (comment.createdAt as Date) > (lastRead as Date);
        })
        .sort((left, right) => Number(right.createdAt) - Number(left.createdAt))
        .slice(0, input.limit) as never;
    },

    async getRelease(input) {
      return (releases.find((release) => release.organizationId === input.organizationId && release.siteId === input.siteId && release.id === input.releaseId) ?? null) as never;
    },

    async lockSiteReleaseSequence() {
      return undefined;
    },

    async nextReleaseNumber(siteId) {
      const siteReleases = releases.filter((release) => release.siteId === siteId);
      return Math.max(0, ...siteReleases.map((release) => Number(release.releaseNumber))) + 1;
    },

    async createRelease(input) {
      const release = {
        id: `release_${releases.length + 1}`,
        ...input,
        createdAt: now(),
      };
      releases.push(release);
      return release as never;
    },

    async createReleaseRoute(input) {
      const route = {
        id: `release_route_${releaseRoutes.length + 1}`,
        ...input,
        createdAt: now(),
      };
      releaseRoutes.push(route);
      return route as never;
    },

    async activateRelease(input) {
      for (const release of releases) {
        if (release.siteId === input.siteId && release.status === "active") {
          Object.assign(release, { status: "archived" });
        }
      }
      Object.assign(requireRecord(sites, input.siteId), { activeReleaseId: input.releaseId, updatedAt: input.now });
      Object.assign(requireRecord(releases, input.releaseId), { status: "active", activatedAt: input.now });
    },

    async insertAudit(input) {
      auditEvents.push({ id: `audit_${auditEvents.length + 1}`, ...input, createdAt: now() });
    },
  };

  return repository;
}

function matchesIdempotency(record: Record<string, unknown>, input: Parameters<PagePublishRepository["findPublishByIdempotencyKey"]>[0]) {
  return (
    record.organizationId === input.organizationId &&
    record.projectId === input.projectId &&
    record.createdByActorType === input.actorType &&
    record.createdByActorId === input.actorId &&
    record.idempotencyKey === input.idempotencyKey
  );
}

function requireRecord(records: Array<Record<string, unknown>>, id: string) {
  const record = records.find((item) => item.id === id);
  if (!record) throw new Error(`Missing test record: ${id}`);
  return record;
}
