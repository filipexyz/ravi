import "reflect-metadata";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { YouTubeClient } from "../../apps/youtube/client.js";
import { ContractError } from "../agent-contract.js";
import { runWithContext } from "../context.js";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getGroupMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { YouTubeCommands } from "./youtube.js";

afterEach(() => mock.restore());

/**
 * Contract helpers throw ContractError (instead of process.exit) only when a
 * tool context is present; runWithContext provides one without env mutation.
 */
async function expectContractError(
  run: () => Promise<unknown> | unknown,
  code: string,
  exitCode: number,
): Promise<InstanceType<typeof ContractError>> {
  let caught: unknown;
  await runWithContext({ sessionKey: "yt-test", sessionName: "yt-test", agentId: "yt-test" }, async () => {
    try {
      await run();
    } catch (error) {
      caught = error;
    }
  });
  expect(caught).toBeInstanceOf(ContractError);
  const contractError = caught as InstanceType<typeof ContractError>;
  expect(contractError.code).toBe(code);
  expect(contractError.exitCode).toBe(exitCode);
  return contractError;
}

describe("YouTubeCommands contract", () => {
  it("registers every finite command with JSON, typed returns and complete help", () => {
    const instance = new YouTubeCommands();
    const commands = getCommandsMetadata(YouTubeCommands);
    const returns = getReturnsMetadata(YouTubeCommands);
    const access = getCommandAccessMetadata(YouTubeCommands);

    expect(getGroupMetadata(YouTubeCommands)).toMatchObject({ name: "yt", scope: "open" });
    expect(commands).toHaveLength(28);
    expect(returns.size).toBe(commands.length);
    expect(access.size).toBe(commands.length);

    for (const command of commands) {
      const options = getOptionsMetadata(instance, command.method);
      expect(options.some((option) => option.flags.includes("--json"))).toBe(true);
      expect(command.helpAfter).toContain("USE");
      expect(command.helpAfter).toContain("NÃO USE");
      expect(command.helpAfter).toContain("EXAMPLES");
      expect(command.helpAfter).toContain("ON ERROR");
      expect(command.helpAfter).toContain("FONTES");
      expect(returns.has(command.method)).toBe(true);
      expect(access.has(command.method)).toBe(true);
    }
  });

  it("classifies writes and destructive commands with confirmation", () => {
    const byMethod = getCommandAccessMetadata(YouTubeCommands);

    for (const method of ["reply", "videoUpdate", "playlistCreate", "playlistAdd"]) {
      expect(byMethod.get(method)).toMatchObject({
        kind: "mutate",
        risk: "high",
        requiresConfirmation: true,
      });
    }
    expect(byMethod.get("videoUpdate")?.redactions).toEqual(["title", "description", "tags"]);
    expect(byMethod.get("playlistCreate")?.redactions).toEqual(["title", "description"]);
    for (const method of ["videoDelete", "playlistDelete", "playlistRemove"]) {
      expect(byMethod.get(method)).toMatchObject({
        kind: "mutate",
        risk: "destructive",
        requiresConfirmation: true,
      });
    }
    for (const method of ["health", "info", "videos", "comments", "captions", "analyticsOverview"]) {
      expect(byMethod.get(method)?.kind).toBe("read");
    }
  });

  it("returns and prints the typed channel envelope with an injected client", async () => {
    const channel = {
      channelId: "UC123",
      title: "Canal",
      description: "Descrição",
      subscriberCount: 3,
      videoCount: 2,
      viewCount: 40,
      thumbnail: "https://example.test/thumb.jpg",
      uploadsPlaylistId: "UU123",
      url: "https://www.youtube.com/channel/UC123",
    };
    const client = { channelInfo: mock(async () => channel) } as unknown as YouTubeClient;
    const factory = mock(() => client);
    const log = spyOn(console, "log").mockImplementation(() => {});
    const commands = new YouTubeCommands(factory);

    const result = await commands.info("brand", true);

    expect(factory).toHaveBeenCalledWith("brand");
    expect(result).toEqual({ success: true, channel });
    expect(log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    expect(getReturnsMetadata(YouTubeCommands).get("info")?.safeParse(result).success).toBe(true);
  });

  it("uses a fake client for mutation tests and never reaches the provider", async () => {
    const replyToComment = mock(async (commentId: string, text: string) => ({
      success: true as const,
      replyId: `${commentId}:${text.length}`,
    }));
    const client = { replyToComment } as unknown as YouTubeClient;
    const commands = new YouTubeCommands(() => client);
    spyOn(console, "log").mockImplementation(() => {});

    // --execute: without it the write brake dry-runs and never reaches the client.
    const result = await commands.reply("comment-1", "Texto aprovado", "brand", true, true);

    expect(replyToComment).toHaveBeenCalledWith("comment-1", "Texto aprovado");
    expect(result).toEqual({ success: true, replyId: "comment-1:14" });
    expect(getReturnsMetadata(YouTubeCommands).get("reply")?.safeParse(result).success).toBe(true);
  });

  it("declares --execute as the LAST option on every braked mutation", () => {
    const instance = new YouTubeCommands();
    for (const method of [
      "reply",
      "videoUpdate",
      "videoDelete",
      "playlistCreate",
      "playlistDelete",
      "playlistAdd",
      "playlistRemove",
    ]) {
      const options = [...getOptionsMetadata(instance, method)].sort((a, b) => a.index - b.index);
      expect(options[options.length - 1]?.flags).toBe("--execute");
    }
  });

  it("declares safe and bounded defaults in command metadata", () => {
    const instance = new YouTubeCommands();
    const optionsFor = (method: string) => getOptionsMetadata(instance, method);

    expect(optionsFor("playlistCreate").find((option) => option.flags.includes("--privacy"))?.defaultValue).toBe(
      "private",
    );
    expect(
      optionsFor("videos")
        .find((option) => option.flags.includes("--limit"))
        ?.schema?.safeParse("50").success,
    ).toBe(true);
    expect(
      optionsFor("videos")
        .find((option) => option.flags.includes("--limit"))
        ?.schema?.safeParse("51").success,
    ).toBe(false);
    expect(
      optionsFor("analyticsSeries")
        .find((option) => option.flags.includes("--metric"))
        ?.schema?.safeParse("estimatedRevenue").success,
    ).toBe(false);
  });
});

describe("yt agent-first contract", () => {
  it("reply without --execute is a dry-run without exposing reply text", async () => {
    const replyToComment = mock(async () => ({ success: true as const, replyId: "r1" }));
    const commands = new YouTubeCommands(() => ({ replyToComment }) as unknown as YouTubeClient);
    spyOn(console, "log").mockImplementation(() => {});

    const error = await expectContractError(
      () => commands.reply("comment-1", "Texto aprovado", "brand", true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );

    expect(error.details.dryRun).toBe(true);
    expect(error.details.plan).toMatchObject({
      commentId: "comment-1",
      textChars: "Texto aprovado".length,
      connection: "brand",
    });
    expect(JSON.stringify(error.details.plan)).not.toContain("Texto aprovado");
    expect(replyToComment).not.toHaveBeenCalled();
  });

  it("video-update and playlist-create dry-runs never expose text or descriptions", async () => {
    const updateVideo = mock(async () => ({ success: true as const, video: {} }));
    const createPlaylist = mock(async () => ({ success: true as const, playlist: {} }));
    const commands = new YouTubeCommands(() => ({ updateVideo, createPlaylist }) as unknown as YouTubeClient);
    const sentinel = "SENTINEL_YT_DESCRIPTION_DO_NOT_LEAK";
    spyOn(console, "log").mockImplementation(() => {});

    const update = await expectContractError(
      () => commands.videoUpdate("v1", sentinel, sentinel, "one,two", undefined, undefined, undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    const playlist = await expectContractError(
      () => commands.playlistCreate(sentinel, sentinel, "private", undefined, true, undefined),
      "WRITE_REQUIRES_EXECUTE",
      3,
    );
    expect(JSON.stringify(update.details.plan)).not.toContain(sentinel);
    expect(JSON.stringify(playlist.details.plan)).not.toContain(sentinel);
    expect(updateVideo).not.toHaveBeenCalled();
    expect(createPlaylist).not.toHaveBeenCalled();
  });

  it("video-delete and playlist mutations are braked before any provider call", async () => {
    const deleteVideo = mock(async () => ({ success: true as const, deleted: "v1" }));
    const deletePlaylist = mock(async () => ({ success: true as const, deleted: "p1" }));
    const addToPlaylist = mock(async () => ({ success: true as const, item: {} }));
    const removeFromPlaylist = mock(async () => ({ success: true as const, removed: "pi1" }));
    const createPlaylist = mock(async () => ({ success: true as const, playlist: {} }));
    const updateVideo = mock(async () => ({ success: true as const, video: {} }));
    const client = {
      deleteVideo,
      deletePlaylist,
      addToPlaylist,
      removeFromPlaylist,
      createPlaylist,
      updateVideo,
    } as unknown as YouTubeClient;
    const commands = new YouTubeCommands(() => client);
    spyOn(console, "log").mockImplementation(() => {});

    const cases: Array<() => Promise<unknown>> = [
      () => commands.videoDelete("v1", undefined, true, undefined),
      () => commands.playlistDelete("p1", undefined, true, undefined),
      () => commands.playlistAdd("p1", "v1", undefined, true, undefined),
      () => commands.playlistRemove("pi1", undefined, true, undefined),
      () => commands.playlistCreate("Nova", undefined, "private", undefined, true, undefined),
      () =>
        commands.videoUpdate(
          "v1",
          "Novo título",
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
        ),
    ];
    for (const run of cases) {
      await expectContractError(run, "WRITE_REQUIRES_EXECUTE", 3);
    }
    for (const spy of [deleteVideo, deletePlaylist, addToPlaylist, removeFromPlaylist, createPlaylist, updateVideo]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("video-delete with --execute reaches the provider", async () => {
    const deleteVideo = mock(async (id: string) => ({ success: true as const, deleted: id }));
    const commands = new YouTubeCommands(() => ({ deleteVideo }) as unknown as YouTubeClient);
    spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.videoDelete("v1", undefined, true, true);

    expect(deleteVideo).toHaveBeenCalledWith("v1");
    expect(result).toEqual({ success: true, deleted: "v1" });
  });

  it("video on an unknown ID exits 1 with the VIDEO_NOT_FOUND envelope", async () => {
    const getVideo = mock(async () => null);
    const commands = new YouTubeCommands(() => ({ getVideo }) as unknown as YouTubeClient);
    spyOn(console, "log").mockImplementation(() => {});

    const error = await expectContractError(() => commands.video("nope", undefined, true), "VIDEO_NOT_FOUND", 1);

    expect(error.op).toBe("yt video");
    expect(error.details.suggestedAction).toContain("ravi yt videos");
  });

  it("videos --fields narrows each video to the requested fields", async () => {
    const video = {
      videoId: "v1",
      title: "Título",
      description: "Desc",
      publishedAt: "2026-01-01T00:00:00Z",
      thumbnail: "https://example.test/t.jpg",
      viewCount: 10,
      likeCount: 1,
      commentCount: 0,
      duration: "PT1M",
      privacyStatus: "public",
      url: "https://youtu.be/v1",
    };
    const listVideos = mock(async () => ({ videos: [video], totalResults: 1, nextPageToken: undefined }));
    const commands = new YouTubeCommands(() => ({ listVideos }) as unknown as YouTubeClient);
    spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.videos("10", undefined, undefined, true, "videoId,title");

    expect(result.videos).toHaveLength(1);
    expect(Object.keys(result.videos[0] as unknown as Record<string, unknown>).sort()).toEqual(["title", "videoId"]);
  });
});
