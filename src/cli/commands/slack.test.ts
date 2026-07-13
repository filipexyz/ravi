import { describe, expect, it } from "bun:test";
import {
  buildSlackCanvasArtifactPublishMetadata,
  buildSlackCanvasShowcaseMarkdown,
  buildSlackCanvasEditChange,
  extractSlackCanvasArtifactPublishState,
  extractSlackCanvasIdFromConversationInfo,
  hashSlackCanvasMarkdown,
  isSlackCanvasArtifactId,
  parseSlackCanvasAccessTargets,
  redactSlackPrivateMetadata,
  resolveSlackCanvasMarkdownInput,
  slackViewMutationItem,
  validateSlackCanvasAccessLevelTargets,
} from "./slack.js";

describe("Slack CLI Canvas helpers", () => {
  it("builds validated Canvas edit changes", () => {
    expect(
      buildSlackCanvasEditChange({
        operation: "replace",
        sectionId: "temp:C:1",
        markdown: "## Status\nok",
      }),
    ).toEqual({
      operation: "replace",
      sectionId: "temp:C:1",
      markdown: "## Status\nok",
    });

    expect(
      buildSlackCanvasEditChange({
        operation: "rename",
        title: "Ravi Channels",
      }),
    ).toEqual({
      operation: "rename",
      title: "Ravi Channels",
    });
  });

  it("rejects invalid Canvas edit combinations before calling Slack", () => {
    expect(() => buildSlackCanvasEditChange({ operation: "delete" })).toThrow("requires --section-id");
    expect(() =>
      buildSlackCanvasEditChange({
        operation: "insert_after",
        sectionId: "temp:C:1",
      }),
    ).toThrow("requires --markdown, --markdown-file or --artifact");
    expect(() =>
      buildSlackCanvasEditChange({
        operation: "rename",
        title: "Ravi Channels",
        markdown: "content",
      }),
    ).toThrow("does not accept --markdown");
  });

  it("accepts exactly one Canvas access target kind", () => {
    expect(parseSlackCanvasAccessTargets("U1,U2", undefined)).toEqual({ userIds: ["U1", "U2"] });
    expect(parseSlackCanvasAccessTargets(undefined, "C1,C2")).toEqual({ channelIds: ["C1", "C2"] });
    expect(() => parseSlackCanvasAccessTargets("U1", "C1")).toThrow("only one");
    expect(() => parseSlackCanvasAccessTargets(undefined, undefined)).toThrow("one of --users or --channels");
  });

  it("rejects owner access for channel targets", () => {
    expect(() => validateSlackCanvasAccessLevelTargets("owner", { channelIds: ["C1"] })).toThrow("only target users");
    expect(() => validateSlackCanvasAccessLevelTargets("owner", { userIds: ["U1"] })).not.toThrow();
  });

  it("resolves markdown input from one source only", () => {
    expect(resolveSlackCanvasMarkdownInput("hello", undefined)).toBe("hello");
    expect(() => resolveSlackCanvasMarkdownInput("hello", "canvas.md")).toThrow("only one");
    expect(() => resolveSlackCanvasMarkdownInput(undefined, "canvas.md", "art_abc_123")).toThrow("only one");
  });

  it("redacts modal private metadata from CLI-facing payloads", () => {
    expect(
      redactSlackPrivateMetadata({
        view: {
          id: "V123",
          private_metadata: { contextKey: "ctx_secret" },
          blocks: [{ type: "section", private_metadata: ["nested_secret"] }],
        },
      }),
    ).toEqual({
      view: {
        id: "V123",
        private_metadata: "[redacted]",
        blocks: [{ type: "section", private_metadata: "[redacted]" }],
      },
    });

    expect(
      slackViewMutationItem({
        ok: true,
        view: {
          id: "V123",
          hash: "hash-1",
          callback_id: "callback",
          private_metadata: "ctx_secret",
        },
      }),
    ).toEqual({
      viewId: "V123",
      hash: "hash-1",
      callbackId: "callback",
      externalId: null,
      type: null,
    });
  });

  it("extracts Canvas IDs from conversation metadata shapes", () => {
    expect(extractSlackCanvasIdFromConversationInfo({ properties: { canvas: "F123" } })).toBe("F123");
    expect(extractSlackCanvasIdFromConversationInfo({ properties: { canvas: { id: "F456" } } })).toBe("F456");
    expect(extractSlackCanvasIdFromConversationInfo({ canvas: { canvas_id: "F789" } })).toBe("F789");
    expect(
      extractSlackCanvasIdFromConversationInfo(
        {
          properties: {
            tabs: [
              { type: "files", id: "files" },
              { type: "canvas", label: "Runbook", data: { file_id: "F111" } },
              { type: "canvas", label: "Showcase", data: { file_id: "F222" } },
            ],
          },
        },
        "Showcase",
      ),
    ).toBe("F222");
    expect(
      extractSlackCanvasIdFromConversationInfo(
        {
          properties: {
            tabs: [
              { type: "files", id: "files" },
              { type: "canvas", label: "Runbook", data: { file_id: "F111" } },
            ],
          },
        },
        "Missing",
      ),
    ).toBeUndefined();
    expect(extractSlackCanvasIdFromConversationInfo({ canvas: { canvas_id: "F999" } }, "Missing")).toBeUndefined();
  });

  it("renders the Canvas showcase with implemented features and missing product gaps", () => {
    const markdown = buildSlackCanvasShowcaseMarkdown({
      canvasId: "F123",
      channelId: "C123",
      title: "Showcase",
    });

    expect(markdown).toContain("# Showcase");
    expect(markdown).toContain("`conversations.canvases.create`");
    expect(markdown).toContain("`ravi slack canvas-channel-showcase`");
    expect(markdown).toContain("`ravi slack canvas-edit --artifact`");
    expect(markdown).not.toContain("`canvas-artifact-publish`");
    expect(markdown).toContain("Modelo canonico `ChannelCanvas`");
    expect(markdown).toContain("Artifact Markdown como fonte");
    expect(markdown).toContain("<#C123>");
    expect(markdown).toContain("F123");
  });

  it("models Canvas artifact publish metadata without claiming bidirectional sync", () => {
    const markdownSha256 = hashSlackCanvasMarkdown("# Canvas\nok");
    const metadata = buildSlackCanvasArtifactPublishMetadata({
      provider: "slack",
      syncDirection: "artifact_to_slack",
      publishMode: "replace",
      canvasId: "F123",
      channelId: "C123",
      connection: "ravi-rbbt-slack",
      credentialSource: "credentials",
      title: "Canvas",
      artifactId: "art_abc_123",
      artifactVersionId: "artv_abc_123",
      artifactVersionNumber: 2,
      markdownSha256,
      markdownChars: 11,
      publishedAt: "2026-07-05T00:00:00.000Z",
      remoteContentExportSupported: false,
    });

    expect(metadata.slackCanvas).toMatchObject({
      current: {
        syncDirection: "artifact_to_slack",
        publishMode: "replace",
        canvasId: "F123",
        markdownSha256,
        remoteContentExportSupported: false,
      },
    });
    expect(
      extractSlackCanvasArtifactPublishState({
        id: "art_abc_123",
        kind: "slack.canvas.markdown",
        status: "active",
        tags: [],
        createdAt: 1,
        updatedAt: 1,
        metadata,
      }),
    ).toMatchObject({
      canvasId: "F123",
      artifactVersionNumber: 2,
    });
    expect(isSlackCanvasArtifactId("art_abc_123")).toBe(true);
    expect(isSlackCanvasArtifactId("canvas.md")).toBe(false);
  });
});
