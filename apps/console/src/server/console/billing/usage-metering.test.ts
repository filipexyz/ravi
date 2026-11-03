import { describe, expect, test } from "bun:test";

import {
  buildPagesAssetStoredUsageEvent,
  buildPagesManifestStoredUsageEvent,
  buildPagesReleaseActivatedUsageEvent,
  usageDimensionHash,
  usageEventTypes,
  usageMetricKeys,
} from "./usage-metering";

describe("usage metering", () => {
  test("builds provider-neutral usage for stored page assets", () => {
    const event = buildPagesAssetStoredUsageEvent({
      organizationId: "org_1",
      projectId: "proj_1",
      siteId: "site_1",
      releaseId: "release_1",
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      assetId: "asset_1",
      publishId: "publish_1",
      assetPath: "assets/app.js",
      cache: "immutable",
      contentType: "application/javascript",
      requestId: "req_1",
      sha256: "abc",
      sizeBytes: 1234,
      storageKey: "provider/private/key",
      visibility: "public",
    });

    expect(event.metricKey).toBe("pages.asset.bytes_stored");
    expect(event.quantity).toBe("1234");
    expect(event.unit).toBe("bytes");
    expect(event.evidenceJson).toMatchObject({ storageBackend: "object_storage" });
    expect(JSON.stringify(event)).not.toContain("Cloudflare");
    expect(JSON.stringify(event)).not.toContain("R2");
    expect(JSON.stringify(event)).not.toContain("provider/private/key");
  });

  test("builds manifest and release events with stable identities", () => {
    const manifest = buildPagesManifestStoredUsageEvent({
      organizationId: "org_1",
      projectId: "proj_1",
      siteId: "site_1",
      releaseId: "release_1",
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      publishId: "publish_1",
      byteLength: 200,
      manifestHash: "hash_1",
      manifestKind: "artifact_version",
      requestId: "req_1",
      storageKey: "provider/private/manifest.json",
    });
    const release = buildPagesReleaseActivatedUsageEvent({
      organizationId: "org_1",
      projectId: "proj_1",
      siteId: "site_1",
      releaseId: "release_1",
      artifactId: "artifact_1",
      artifactVersionId: "version_1",
      publishId: "publish_1",
      releaseNumber: 2,
      requestId: "req_1",
      routeCount: 3,
      visibility: "private",
    });

    expect(manifest.metricKey).toBe("pages.manifest.bytes_stored");
    expect(release.metricKey).toBe("pages.release.activations");
    expect(usageDimensionHash({ ...release, metricKey: release.metricKey })).toHaveLength(64);
  });

  test("declares the meter-only Knowledge keys", () => {
    expect(usageMetricKeys.knowledgeSearches).toBe("knowledge.searches");
    expect(usageMetricKeys.knowledgeChunksStored).toBe("knowledge.chunks_stored");
    expect(usageMetricKeys.knowledgePageChatSearches).toBe("knowledge.page_chat_searches");
    expect(usageEventTypes.knowledgeSearchCompleted).toBe("knowledge.search_completed");
    expect(usageEventTypes.knowledgeDocumentIngested).toBe("knowledge.document_ingested");
    expect(usageEventTypes.knowledgePageChatSearch).toBe("knowledge.page_chat_search");
  });
});
