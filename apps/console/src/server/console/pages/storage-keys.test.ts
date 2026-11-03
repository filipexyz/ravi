import { describe, expect, it } from "bun:test";

import { isFinalObjectKeyForArtifact } from "./storage-keys";

describe("Pages storage keys", () => {
  it("accepts final object keys for the same artifact/version/path across project transfers", () => {
    expect(
      isFinalObjectKeyForArtifact({
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        key: "org/source/project/old/artifact/artifact_1/version/version_1/index.html",
        path: "index.html",
      }),
    ).toBe(true);
  });

  it("rejects staging or mismatched artifact keys", () => {
    expect(
      isFinalObjectKeyForArtifact({
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        key: "staging/org/source/project/old/upload/session/index.html",
        path: "index.html",
      }),
    ).toBe(false);

    expect(
      isFinalObjectKeyForArtifact({
        artifactId: "artifact_1",
        artifactVersionId: "version_1",
        key: "org/source/project/old/artifact/artifact_2/version/version_1/index.html",
        path: "index.html",
      }),
    ).toBe(false);
  });
});
