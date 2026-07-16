import "reflect-metadata";
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { YouTubeClient } from "../../apps/youtube/client.js";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getGroupMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { YouTubeCommands } from "./youtube.js";

afterEach(() => mock.restore());

describe("YouTubeCommands contract", () => {
  it("registers every finite command with JSON, typed returns and complete help", () => {
    const instance = new YouTubeCommands();
    const commands = getCommandsMetadata(YouTubeCommands);
    const returns = getReturnsMetadata(YouTubeCommands);
    const access = getCommandAccessMetadata(YouTubeCommands);

    expect(getGroupMetadata(YouTubeCommands)).toMatchObject({ name: "yt", scope: "open" });
    expect(commands).toHaveLength(43);
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

    for (const method of [
      "reply",
      "videoUpdate",
      "playlistCreate",
      "playlistAdd",
      "channelUpdate",
      "playlistUpdate",
      "playlistMove",
      "comment",
      "commentModerate",
      "commentUpdate",
      "subscribe",
      "thumbnailSet",
    ]) {
      expect(byMethod.get(method)).toMatchObject({
        kind: "mutate",
        risk: "high",
        requiresConfirmation: true,
      });
    }
    for (const method of [
      "videoDelete",
      "playlistDelete",
      "playlistRemove",
      "commentDelete",
      "unsubscribe",
      "captionDelete",
    ]) {
      expect(byMethod.get(method)).toMatchObject({
        kind: "mutate",
        risk: "destructive",
        requiresConfirmation: true,
      });
    }
    for (const method of [
      "health",
      "info",
      "videos",
      "comments",
      "captions",
      "analyticsOverview",
      "activities",
      "i18nLanguages",
      "i18nRegions",
      "videoRating",
    ]) {
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

    const result = await commands.reply("comment-1", "Texto aprovado", "brand", true);

    expect(replyToComment).toHaveBeenCalledWith("comment-1", "Texto aprovado");
    expect(result).toEqual({ success: true, replyId: "comment-1:14" });
    expect(getReturnsMetadata(YouTubeCommands).get("reply")?.safeParse(result).success).toBe(true);
  });

  it("rejects --ban-author unless the target status is rejected", async () => {
    const setCommentModeration = mock(async () => ({ success: true as const, commentId: "c1", status: "rejected" }));
    const client = { setCommentModeration } as unknown as YouTubeClient;
    const commands = new YouTubeCommands(() => client);
    spyOn(console, "log").mockImplementation(() => {});

    await expect(commands.commentModerate("c1", "published", true, "brand", true)).rejects.toThrow(
      "--ban-author is only valid with --status rejected",
    );
    expect(setCommentModeration).not.toHaveBeenCalled();

    await commands.commentModerate("c1", "rejected", true, "brand", true);
    expect(setCommentModeration).toHaveBeenCalledWith("c1", "rejected", true);
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
