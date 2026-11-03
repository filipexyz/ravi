import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  knowledgeRawSourceObjectKey,
  knowledgeRawSourceSafeMetadata,
  pendingKnowledgeRawSourceRef,
  putKnowledgeRawSourceObject,
  readKnowledgeRawSourceObject,
  type KnowledgeRawSourceObjectStore,
} from "./raw-source-storage";

describe("Knowledge raw source storage", () => {
  test("stores raw content behind a private object ref and exposes only safe metadata", async () => {
    const store = createInMemoryObjectStore();
    const privateRef = await putKnowledgeRawSourceObject({
      body: "private source body",
      contentType: "text/markdown",
      documentId: "doc_1",
      filename: "../notes.md",
      organizationId: "org_1",
      projectId: "proj_1",
      sourceId: "source_1",
      store,
    });

    const sha256 = createHash("sha256").update("private source body").digest("hex");
    expect(privateRef).toMatchObject({
      schemaVersion: 1,
      status: "stored",
      visibility: "private",
      storageBackend: "object_storage",
      provider: "cloudflare_r2",
      sha256,
      sizeBytes: 19,
      contentType: "text/markdown",
    });
    expect(privateRef.key).toBe("knowledge/raw/org/org_1/project/proj_1/source/source_1/document/doc_1/notes.md");

    const safe = knowledgeRawSourceSafeMetadata(privateRef);
    expect(safe).toMatchObject({
      status: "stored",
      storageBackend: "object_storage",
      sha256,
      sizeBytes: 19,
      contentType: "text/markdown",
    });
    expect(JSON.stringify(safe)).not.toContain("knowledge/raw/");
    expect(JSON.stringify(safe)).not.toContain("cloudflare_r2");

    const body = await readKnowledgeRawSourceObject(store, privateRef);
    expect(await new Response(body).text()).toBe("private source body");
  });

  test("normalizes missing or invalid raw refs to pending safe metadata", () => {
    expect(knowledgeRawSourceSafeMetadata(null)).toEqual({
      status: "pending",
      storageBackend: "none",
      sha256: null,
      sizeBytes: null,
      contentType: null,
      storedAt: null,
    });
    expect(knowledgeRawSourceSafeMetadata(pendingKnowledgeRawSourceRef())).toMatchObject({
      status: "pending",
      storageBackend: "none",
    });
  });

  test("builds scoped object keys without trusting path separators in filenames", () => {
    expect(
      knowledgeRawSourceObjectKey({
        documentId: "doc/unsafe",
        filename: "../../q&a.md",
        organizationId: "org/unsafe",
        projectId: "proj unsafe",
        sha256: "abc",
        sourceId: "source unsafe",
      }),
    ).toBe("knowledge/raw/org/org%2Funsafe/project/proj%20unsafe/source/source%20unsafe/document/doc%2Funsafe/q-a.md");
  });
});

function createInMemoryObjectStore(): KnowledgeRawSourceObjectStore {
  const objects = new Map<string, ArrayBuffer>();
  return {
    async getObject(key) {
      return objects.get(key) ?? null;
    },
    async putObject(input) {
      objects.set(input.key, input.body);
    },
  };
}
