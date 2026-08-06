import "reflect-metadata";
import { z } from "zod";
import { YouTubeClient } from "../../apps/youtube/client.js";
import { ContractError, contractDryRun, contractFail, pickFields } from "../agent-contract.js";
import { fail } from "../context.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { jsonPrimitiveSchema } from "../return-schemas.js";

/**
 * VIDEO_NOT_FOUND envelope (Manual v2): there is no cheap local cache of the
 * channel's videos (listing is an external Data API call), so the envelope
 * carries a `suggestedAction` pointing at the listing/search ops instead of
 * `suggestions`.
 */
function failYouTubeVideoNotFound(op: string, videoId: string, asJson?: boolean): never {
  contractFail(op, "VIDEO_NOT_FOUND", `YouTube video not found: ${videoId}`, {
    asJson,
    details: {
      suggestedAction:
        "List channel uploads with `ravi yt videos --json` or search with `ravi yt search <query> --json` to find the correct video ID",
    },
  });
}

const successSchema = z.literal(true);
const pageTokenSchema = z.string().optional();
const integerString = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/)
    .refine((value) => {
      const parsed = Number(value);
      return Number.isInteger(parsed) && parsed >= min && parsed <= max;
    }, `Expected an integer from ${min} to ${max}.`);

const channelSchema = z
  .object({
    channelId: z.string(),
    title: z.string(),
    description: z.string(),
    subscriberCount: z.number(),
    videoCount: z.number(),
    viewCount: z.number(),
    thumbnail: z.string(),
    uploadsPlaylistId: z.string(),
    url: z.string(),
  })
  .strict();

const videoSchema = z
  .object({
    videoId: z.string(),
    title: z.string(),
    description: z.string(),
    publishedAt: z.string(),
    thumbnail: z.string(),
    viewCount: z.number(),
    likeCount: z.number(),
    commentCount: z.number(),
    duration: z.string(),
    privacyStatus: z.string(),
    url: z.string(),
    playlistItemId: z.string().optional(),
  })
  .strict();

const commentSchema = z
  .object({
    threadId: z.string(),
    commentId: z.string(),
    author: z.string(),
    authorChannelUrl: z.string(),
    text: z.string(),
    likeCount: z.number(),
    publishedAt: z.string(),
    replyCount: z.number(),
  })
  .strict();

const playlistSchema = z
  .object({
    playlistId: z.string(),
    title: z.string(),
    description: z.string(),
    thumbnail: z.string(),
    itemCount: z.number(),
    publishedAt: z.string(),
    privacyStatus: z.string(),
    url: z.string(),
  })
  .strict();

const healthReturnSchema = z
  .object({
    success: successSchema,
    app: z.literal("youtube"),
    connection: z.string(),
    ready: z.boolean(),
    credentialConfigured: z.boolean(),
    credentialStatus: z.string(),
    authenticated: z.literal(false),
    externalCheckPerformed: z.literal(false),
    message: z.string(),
  })
  .strict();

const infoReturnSchema = z.object({ success: successSchema, channel: channelSchema }).strict();
const videosReturnSchema = z
  .object({
    success: successSchema,
    videos: z.array(videoSchema),
    totalResults: z.number(),
    nextPageToken: pageTokenSchema,
  })
  .strict();
const searchReturnSchema = videosReturnSchema.extend({ query: z.string() }).strict();
const videoReturnSchema = z.object({ success: successSchema, video: videoSchema }).strict();
const statsReturnSchema = z
  .object({
    success: successSchema,
    stats: z
      .object({
        videoId: z.string(),
        title: z.string(),
        viewCount: z.number(),
        likeCount: z.number(),
        commentCount: z.number(),
        publishedAt: z.string(),
        daysSincePublish: z.number(),
        viewsPerDay: z.number(),
      })
      .strict(),
  })
  .strict();
const commentsReturnSchema = z
  .object({
    success: successSchema,
    videoId: z.string(),
    comments: z.array(commentSchema),
    totalResults: z.number(),
    nextPageToken: pageTokenSchema,
  })
  .strict();
const unansweredReturnSchema = z
  .object({
    success: successSchema,
    videoId: z.string(),
    comments: z.array(commentSchema),
    totalUnanswered: z.number(),
    nextPageToken: pageTokenSchema,
  })
  .strict();
const replyReturnSchema = z.object({ success: successSchema, replyId: z.string() }).strict();
const playlistsReturnSchema = z
  .object({
    success: successSchema,
    playlists: z.array(playlistSchema),
    totalResults: z.number(),
    nextPageToken: pageTokenSchema,
  })
  .strict();
const playlistReturnSchema = z
  .object({
    success: successSchema,
    playlistId: z.string(),
    videos: z.array(videoSchema),
    totalResults: z.number(),
    nextPageToken: pageTokenSchema,
  })
  .strict();
const subscriptionsReturnSchema = z
  .object({
    success: successSchema,
    subscriptions: z.array(
      z
        .object({
          subscriptionId: z.string(),
          channelId: z.string(),
          title: z.string(),
          description: z.string(),
          thumbnail: z.string(),
          publishedAt: z.string(),
          totalItemCount: z.number(),
          url: z.string(),
        })
        .strict(),
    ),
    totalResults: z.number(),
    nextPageToken: pageTokenSchema,
  })
  .strict();
const captionsReturnSchema = z
  .object({
    success: successSchema,
    videoId: z.string(),
    captions: z.array(
      z
        .object({
          captionId: z.string(),
          language: z.string(),
          name: z.string(),
          trackKind: z.string(),
          isAutoSynced: z.boolean(),
          isDraft: z.boolean(),
          status: z.string(),
          lastUpdated: z.string(),
        })
        .strict(),
    ),
    totalResults: z.number(),
  })
  .strict();
const captionDownloadReturnSchema = z
  .object({
    success: successSchema,
    captionId: z.string(),
    format: z.string(),
    content: z.string(),
  })
  .strict();
const videoCategoriesReturnSchema = z
  .object({
    success: successSchema,
    region: z.string(),
    categories: z.array(z.object({ categoryId: z.string(), title: z.string(), assignable: z.boolean() }).strict()),
    totalResults: z.number(),
  })
  .strict();
const analyticsOverviewReturnSchema = z
  .object({
    success: successSchema,
    period: z.string(),
    overview: z
      .object({
        views: z.number(),
        watchTimeMinutes: z.number(),
        avgViewDurationSec: z.number(),
        subscribersGained: z.number(),
        subscribersLost: z.number(),
        netSubscribers: z.number(),
        likes: z.number(),
        dislikes: z.number(),
        comments: z.number(),
        shares: z.number(),
      })
      .strict(),
  })
  .strict();
const analyticsSeriesReturnSchema = z
  .object({
    success: successSchema,
    period: z.string(),
    metric: z.string(),
    data: z.array(z.record(z.string(), jsonPrimitiveSchema)),
  })
  .strict();
const analyticsTopReturnSchema = z
  .object({
    success: successSchema,
    period: z.string(),
    videos: z.array(
      z
        .object({
          videoId: z.string(),
          title: z.string(),
          views: z.number(),
          watchTimeMinutes: z.number(),
          avgViewDurationSec: z.number(),
          likes: z.number(),
          comments: z.number(),
        })
        .strict(),
    ),
  })
  .strict();
const analyticsTrafficReturnSchema = z
  .object({
    success: successSchema,
    period: z.string(),
    sources: z.array(z.object({ source: z.string(), views: z.number(), watchTimeMinutes: z.number() }).strict()),
  })
  .strict();
const analyticsDemographicsReturnSchema = z
  .object({
    success: successSchema,
    period: z.string(),
    demographics: z.array(
      z.object({ ageGroup: z.string(), gender: z.string(), viewerPercentage: z.number() }).strict(),
    ),
  })
  .strict();
const analyticsCountriesReturnSchema = z
  .object({
    success: successSchema,
    period: z.string(),
    countries: z.array(
      z
        .object({
          country: z.string(),
          views: z.number(),
          watchTimeMinutes: z.number(),
          subscribersGained: z.number(),
        })
        .strict(),
    ),
  })
  .strict();
const analyticsDevicesReturnSchema = z
  .object({
    success: successSchema,
    period: z.string(),
    devices: z.array(z.object({ device: z.string(), views: z.number(), watchTimeMinutes: z.number() }).strict()),
  })
  .strict();
const videoUpdateReturnSchema = z.object({ success: successSchema, video: videoSchema }).strict();
const deleteReturnSchema = z.object({ success: successSchema, deleted: z.string() }).strict();
const playlistCreateReturnSchema = z.object({ success: successSchema, playlist: playlistSchema }).strict();
const playlistAddReturnSchema = z
  .object({
    success: successSchema,
    item: z
      .object({ playlistItemId: z.string(), playlistId: z.string(), videoId: z.string(), title: z.string() })
      .strict(),
  })
  .strict();
const playlistRemoveReturnSchema = z.object({ success: successSchema, removed: z.string() }).strict();

type YouTubeClientFactory = (connection?: string) => YouTubeClient;

@Group({
  name: "yt",
  description: "Operate YouTube Data API v3 and YouTube Analytics API v2 through Ravi credentials",
  scope: "open",
})
export class YouTubeCommands {
  constructor(
    private readonly clientFactory: YouTubeClientFactory = (connection) => new YouTubeClient({ connection }),
  ) {}

  @Command({
    name: "health",
    description: "Inspect YouTube credential metadata without resolving a secret or calling Google",
    helpAfter: readHelp(
      "Check whether a Ravi credential connection is configured before an authenticated proof.",
      "Do not use as proof that Google accepted the token; no external request is made.",
      ["ravi yt health --json", "ravi yt health --connection production --json"],
      "Ravi credential broker metadata; no provider endpoint.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.credentials", action: "health", risk: "low" })
  @Returns(healthReturnSchema)
  async health(
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({ success: true as const, ...this.client(connection).health() }));
  }

  @Command({
    name: "info",
    description: "Return metadata and lifetime counters for the authenticated channel",
    helpAfter: readHelp(
      "Confirm which channel the selected credential owns before any write.",
      "For period metrics, use `ravi yt analytics-overview`.",
      ["ravi yt info --json", "ravi yt info --connection brand --json"],
      "YouTube Data API v3 channels.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.channels", action: "info", risk: "low" })
  @Returns(infoReturnSchema)
  async info(
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      channel: await this.client(connection).channelInfo(),
    }));
  }

  @Command({
    name: "videos",
    description: "List videos from the authenticated channel uploads playlist",
    helpAfter: readHelp(
      "List recent channel uploads with stable video IDs and a provider page token.",
      "For text search, use `ravi yt search <query>`.",
      ["ravi yt videos --limit 10 --json", "ravi yt videos --page <nextPageToken> --json"],
      "YouTube Data API v3 channels.list, playlistItems.list and videos.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.videos", action: "list", risk: "low" })
  @Returns(videosReturnSchema)
  async videos(
    @Option({
      flags: "-l, --limit <n>",
      description: "Page size, 1-50 (default: 10)",
      defaultValue: "10",
      schema: integerString(1, 50),
    })
    limit?: string,
    @Option({ flags: "-p, --page <token>", description: "Provider page token from nextPageToken" }) page?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each video" })
    fields?: string,
  ) {
    return this.execute(asJson, async () => {
      const result = await this.client(connection).listVideos({
        maxResults: integer(limit, 10, 1, 50),
        pageToken: page,
      });
      return { success: true as const, ...result, videos: pickFields(result.videos, fields) };
    });
  }

  @Command({
    name: "video",
    description: "Get one video by YouTube video ID",
    helpAfter: readHelp(
      "Inspect current metadata and lifetime counters before an update or delete decision.",
      "To discover IDs, use `ravi yt videos` or `ravi yt search`.",
      ["ravi yt video dQw4w9WgXcQ --json", "ravi yt video <videoId> --connection brand --json"],
      "YouTube Data API v3 videos.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.videos", action: "get", risk: "low" })
  @Returns(videoReturnSchema)
  async video(
    @Arg("id", { description: "YouTube video ID", schema: z.string().min(1) }) id: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => {
      const video = await this.client(connection).getVideo(id);
      if (!video) failYouTubeVideoNotFound("yt video", id, asJson);
      return { success: true as const, video };
    });
  }

  @Command({
    name: "search",
    description: "Search videos in the authenticated channel",
    helpAfter: readHelp(
      "Find channel videos by text when the video ID is unknown.",
      "To list uploads without a query, use `ravi yt videos`.",
      ["ravi yt search embalagem --limit 10 --json", 'ravi yt search "caixa correio" --json'],
      "YouTube Data API v3 search.list and videos.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.videos", action: "search", risk: "low" })
  @Returns(searchReturnSchema)
  async search(
    @Arg("query", { description: "Search text", schema: z.string().min(1) }) query: string,
    @Option({
      flags: "-l, --limit <n>",
      description: "Page size, 1-50 (default: 10)",
      defaultValue: "10",
      schema: integerString(1, 50),
    })
    limit?: string,
    @Option({ flags: "-p, --page <token>", description: "Provider page token from nextPageToken" }) page?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each video" })
    fields?: string,
  ) {
    return this.execute(asJson, async () => {
      const result = await this.client(connection).searchVideos(query, {
        maxResults: integer(limit, 10, 1, 50),
        pageToken: page,
      });
      return { success: true as const, ...result, videos: pickFields(result.videos, fields) };
    });
  }

  @Command({
    name: "stats",
    description: "Calculate lifetime video counters, age and average views per day",
    helpAfter: readHelp(
      "Assess the lifetime pace of one known video.",
      "For true period metrics, use an `analytics-*` command.",
      ["ravi yt stats dQw4w9WgXcQ --json", "ravi yt stats <videoId> --connection brand --json"],
      "YouTube Data API v3 videos.list; age and views/day are local calculations.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.videos", action: "stats", risk: "low" })
  @Returns(statsReturnSchema)
  async stats(
    @Arg("id", { description: "YouTube video ID", schema: z.string().min(1) }) id: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      stats: await this.client(connection).getVideoStats(id),
    }));
  }

  @Command({
    name: "comments",
    description: "List top-level comment threads for a video",
    helpAfter: readHelp(
      "Read comment threads and obtain the top-level commentId used by `reply`.",
      "For only unanswered threads, use `ravi yt unanswered`.",
      ["ravi yt comments <videoId> --limit 20 --json", "ravi yt comments <videoId> --page <nextPageToken> --json"],
      "YouTube Data API v3 commentThreads.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.comments", action: "list", risk: "low" })
  @Returns(commentsReturnSchema)
  async comments(
    @Arg("videoId", { description: "YouTube video ID", schema: z.string().min(1) }) videoId: string,
    @Option({
      flags: "-l, --limit <n>",
      description: "Page size, 1-100 (default: 20)",
      defaultValue: "20",
      schema: integerString(1, 100),
    })
    limit?: string,
    @Option({ flags: "-p, --page <token>", description: "Provider page token from nextPageToken" }) page?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each comment" })
    fields?: string,
  ) {
    return this.execute(asJson, async () => {
      const result = await this.client(connection).listComments(videoId, {
        maxResults: integer(limit, 20, 1, 100),
        pageToken: page,
      });
      return { success: true as const, ...result, comments: pickFields(result.comments, fields) };
    });
  }

  @Command({
    name: "unanswered",
    description: "List recent comment threads with zero replies",
    helpAfter: readHelp(
      "Build a review queue before drafting replies.",
      "Do not reply automatically; `ravi yt reply` requires explicit confirmation.",
      ["ravi yt unanswered <videoId> --limit 50 --json", "ravi yt unanswered <videoId> --page <nextPageToken> --json"],
      "YouTube Data API v3 commentThreads.list; zero-reply filtering is local.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.comments", action: "unanswered", risk: "low" })
  @Returns(unansweredReturnSchema)
  async unanswered(
    @Arg("videoId", { description: "YouTube video ID", schema: z.string().min(1) }) videoId: string,
    @Option({
      flags: "-l, --limit <n>",
      description: "Threads inspected, 1-100 (default: 50)",
      defaultValue: "50",
      schema: integerString(1, 100),
    })
    limit?: string,
    @Option({ flags: "-p, --page <token>", description: "Provider page token from nextPageToken" }) page?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each comment" })
    fields?: string,
  ) {
    return this.execute(asJson, async () => {
      const result = await this.client(connection).listUnansweredComments(videoId, {
        maxResults: integer(limit, 50, 1, 100),
        pageToken: page,
      });
      return { success: true as const, ...result, comments: pickFields(result.comments, fields) };
    });
  }

  @Command({
    name: "reply",
    description: "Publish a reply to a top-level YouTube comment",
    helpAfter: mutationHelp(
      "Publish one externally visible reply after a human approves the exact text.",
      "Never use for testing or bulk replies; blind retries duplicate public replies.",
      [
        'ravi yt reply <commentId> "Texto aprovado" --json',
        'ravi yt reply <commentId> "Texto aprovado" --execute --json',
      ],
      "YouTube Data API v3 comments.insert; requires youtube.force-ssl.",
      "PUBLIC WRITE: show commentId and the exact reply text, then obtain explicit confirmation.",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "youtube.comments",
    action: "reply",
    risk: "high",
    requiresConfirmation: true,
    input: ["commentId", "text", "connection"],
    redactions: ["text"],
  })
  @Returns(replyReturnSchema)
  async reply(
    @Arg("commentId", { description: "Top-level comment ID from `ravi yt comments`", schema: z.string().min(1) })
    commentId: string,
    @Arg("text", { description: "Exact approved reply text", schema: z.string().min(1) }) text: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually publish the reply; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (execute !== true) {
      // Write brake (Manual v2 7.8): a comment reply is a REAL, externally
      // visible write on YouTube, so dry-run by default and exit 3 before any
      // provider call.
      contractDryRun("yt reply", { commentId, text, connection: connection ?? "default" }, { asJson });
    }
    return this.execute(asJson, () => this.client(connection).replyToComment(commentId, text));
  }

  @Command({
    name: "playlists",
    description: "List playlists owned by the authenticated channel",
    helpAfter: readHelp(
      "Discover playlist IDs and avoid duplicate creation.",
      "For playlist contents, use `ravi yt playlist <playlistId>`.",
      ["ravi yt playlists --limit 25 --json", "ravi yt playlists --page <nextPageToken> --json"],
      "YouTube Data API v3 playlists.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.playlists", action: "list", risk: "low" })
  @Returns(playlistsReturnSchema)
  async playlists(
    @Option({
      flags: "-l, --limit <n>",
      description: "Page size, 1-50 (default: 25)",
      defaultValue: "25",
      schema: integerString(1, 50),
    })
    limit?: string,
    @Option({ flags: "-p, --page <token>", description: "Provider page token from nextPageToken" }) page?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each playlist" })
    fields?: string,
  ) {
    return this.execute(asJson, async () => {
      const result = await this.client(connection).listPlaylists({
        maxResults: integer(limit, 25, 1, 50),
        pageToken: page,
      });
      return { success: true as const, ...result, playlists: pickFields(result.playlists, fields) };
    });
  }

  @Command({
    name: "playlist",
    description: "List videos and playlist-item IDs from one playlist",
    helpAfter: readHelp(
      "Inspect playlist contents and obtain playlistItemId for safe removal decisions.",
      "Do not pass a videoId to `playlist-remove`; it requires playlistItemId.",
      [
        "ravi yt playlist <playlistId> --limit 25 --json",
        "ravi yt playlist <playlistId> --page <nextPageToken> --json",
      ],
      "YouTube Data API v3 playlistItems.list and videos.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.playlists", action: "get", risk: "low" })
  @Returns(playlistReturnSchema)
  async playlist(
    @Arg("playlistId", { description: "YouTube playlist ID", schema: z.string().min(1) }) playlistId: string,
    @Option({
      flags: "-l, --limit <n>",
      description: "Page size, 1-50 (default: 25)",
      defaultValue: "25",
      schema: integerString(1, 50),
    })
    limit?: string,
    @Option({ flags: "-p, --page <token>", description: "Provider page token from nextPageToken" }) page?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each video" })
    fields?: string,
  ) {
    return this.execute(asJson, async () => {
      const result = await this.client(connection).getPlaylistVideos(playlistId, {
        maxResults: integer(limit, 25, 1, 50),
        pageToken: page,
      });
      return { success: true as const, ...result, videos: pickFields(result.videos, fields) };
    });
  }

  @Command({
    name: "subscriptions",
    description: "List channels followed by the authenticated channel",
    helpAfter: readHelp(
      "Audit which channels the authenticated channel follows.",
      "This does not list the channel's subscribers; that data is not exposed here.",
      ["ravi yt subscriptions --limit 25 --json", "ravi yt subscriptions --page <nextPageToken> --json"],
      "YouTube Data API v3 subscriptions.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.subscriptions", action: "list", risk: "low" })
  @Returns(subscriptionsReturnSchema)
  async subscriptions(
    @Option({
      flags: "-l, --limit <n>",
      description: "Page size, 1-50 (default: 25)",
      defaultValue: "25",
      schema: integerString(1, 50),
    })
    limit?: string,
    @Option({ flags: "-p, --page <token>", description: "Provider page token from nextPageToken" }) page?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({ flags: "--fields <a,b,c>", description: "Compact mode: keep only these fields of each subscription" })
    fields?: string,
  ) {
    return this.execute(asJson, async () => {
      const result = await this.client(connection).listSubscriptions({
        maxResults: integer(limit, 25, 1, 50),
        pageToken: page,
      });
      return { success: true as const, ...result, subscriptions: pickFields(result.subscriptions, fields) };
    });
  }

  @Command({
    name: "captions",
    description: "List caption tracks for one video",
    helpAfter: readHelp(
      "Discover caption track IDs, languages and status.",
      "To retrieve track content, use `ravi yt caption-download <captionId>`.",
      ["ravi yt captions <videoId> --json", "ravi yt captions <videoId> --connection brand --json"],
      "YouTube Data API v3 captions.list; requires OAuth authorization.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.captions", action: "list", risk: "low" })
  @Returns(captionsReturnSchema)
  async captions(
    @Arg("videoId", { description: "YouTube video ID", schema: z.string().min(1) }) videoId: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).listCaptions(videoId)),
    }));
  }

  @Command({
    name: "caption-download",
    description: "Download one caption track as text",
    helpAfter: readHelp(
      "Retrieve an owned/downloadable caption for content reuse.",
      "Do not use before listing tracks; caption IDs are distinct from video IDs.",
      [
        "ravi yt caption-download <captionId> --format srt --json",
        "ravi yt caption-download <captionId> --format vtt --language en --json",
      ],
      "YouTube Data API v3 captions.download; requires youtube.force-ssl or youtubepartner.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.captions", action: "download", risk: "low" })
  @Returns(captionDownloadReturnSchema)
  async captionDownload(
    @Arg("captionId", { description: "Caption track ID from `ravi yt captions`", schema: z.string().min(1) })
    captionId: string,
    @Option({
      flags: "--format <fmt>",
      description: "srt|vtt|ttml (default: srt)",
      defaultValue: "srt",
      schema: z.enum(["srt", "vtt", "ttml"]),
    })
    format?: string,
    @Option({ flags: "--language <code>", description: "Optional ISO 639-1 translation language" }) language?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, () => this.client(connection).downloadCaption(captionId, { format, language }));
  }

  @Command({
    name: "video-categories",
    description: "List assignable YouTube video categories for a region",
    helpAfter: readHelp(
      "Discover a valid categoryId before updating video metadata.",
      "Do not assume categories are identical across regions.",
      ["ravi yt video-categories --region BR --json", "ravi yt video-categories --region US --json"],
      "YouTube Data API v3 videoCategories.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.video-categories", action: "list", risk: "low" })
  @Returns(videoCategoriesReturnSchema)
  async videoCategories(
    @Option({
      flags: "-r, --region <code>",
      description: "ISO 3166-1 alpha-2 region (default: BR)",
      defaultValue: "BR",
      schema: z.string().regex(/^[A-Za-z]{2}$/),
    })
    region?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).listVideoCategories({ region: region?.toUpperCase() })),
    }));
  }

  @Command({
    name: "analytics-overview",
    description: "Return aggregate channel engagement metrics for a recent period",
    helpAfter: analyticsHelp(
      "Review aggregate channel KPIs without monetary metrics.",
      ["ravi yt analytics-overview --days 28 --json", "ravi yt analytics-overview --days 90 --connection brand --json"],
      "YouTube Analytics API v2 reports.query, channel basic stats.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.analytics", action: "overview", risk: "low" })
  @Returns(analyticsOverviewReturnSchema)
  async analyticsOverview(
    @Option({
      flags: "-d, --days <n>",
      description: "Recent days, 1-365 (default: 28)",
      defaultValue: "28",
      schema: integerString(1, 365),
    })
    days?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).analyticsOverview({ days: integer(days, 28, 1, 365) })),
    }));
  }

  @Command({
    name: "analytics-series",
    description: "Return a daily time series for one approved YouTube Analytics metric",
    helpAfter: analyticsHelp(
      "Inspect one KPI trend over time.",
      [
        "ravi yt analytics-series --metric views --days 28 --json",
        "ravi yt analytics-series --metric likes --days 90 --json",
      ],
      "YouTube Analytics API v2 reports.query with dimension=day.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.analytics", action: "series", risk: "low" })
  @Returns(analyticsSeriesReturnSchema)
  async analyticsSeries(
    @Option({
      flags: "-m, --metric <name>",
      description:
        "views|estimatedMinutesWatched|averageViewDuration|subscribersGained|likes|comments|shares (default: views)",
      defaultValue: "views",
      schema: z.enum([
        "views",
        "estimatedMinutesWatched",
        "averageViewDuration",
        "subscribersGained",
        "likes",
        "comments",
        "shares",
      ]),
    })
    metric?: string,
    @Option({
      flags: "-d, --days <n>",
      description: "Recent days, 1-365 (default: 28)",
      defaultValue: "28",
      schema: integerString(1, 365),
    })
    days?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).analyticsSeries({ days: integer(days, 28, 1, 365), metric })),
    }));
  }

  @Command({
    name: "analytics-top",
    description: "Rank channel videos by views for a recent period",
    helpAfter: analyticsHelp(
      "Identify top videos using true period metrics.",
      ["ravi yt analytics-top --days 28 --limit 10 --json", "ravi yt analytics-top --days 90 --limit 20 --json"],
      "YouTube Analytics API v2 reports.query with dimension=video plus Data API videos.list.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.analytics", action: "top-videos", risk: "low" })
  @Returns(analyticsTopReturnSchema)
  async analyticsTop(
    @Option({
      flags: "-d, --days <n>",
      description: "Recent days, 1-365 (default: 28)",
      defaultValue: "28",
      schema: integerString(1, 365),
    })
    days?: string,
    @Option({
      flags: "-l, --limit <n>",
      description: "Rows, 1-200 (default: 10)",
      defaultValue: "10",
      schema: integerString(1, 200),
    })
    limit?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).analyticsTopVideos({
        days: integer(days, 28, 1, 365),
        maxResults: integer(limit, 10, 1, 200),
      })),
    }));
  }

  @Command({
    name: "analytics-traffic",
    description: "Break down recent views and watch time by traffic-source type",
    helpAfter: analyticsHelp(
      "Understand where viewers discovered channel videos.",
      ["ravi yt analytics-traffic --days 28 --json", "ravi yt analytics-traffic --days 90 --json"],
      "YouTube Analytics API v2 reports.query with insightTrafficSourceType.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.analytics", action: "traffic", risk: "low" })
  @Returns(analyticsTrafficReturnSchema)
  async analyticsTraffic(
    @Option({
      flags: "-d, --days <n>",
      description: "Recent days, 1-365 (default: 28)",
      defaultValue: "28",
      schema: integerString(1, 365),
    })
    days?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).analyticsTraffic({ days: integer(days, 28, 1, 365) })),
    }));
  }

  @Command({
    name: "analytics-demographics",
    description: "Break down viewer percentage by age group and gender",
    helpAfter: analyticsHelp(
      "Inspect the available audience-demographic distribution.",
      ["ravi yt analytics-demographics --days 28 --json", "ravi yt analytics-demographics --days 90 --json"],
      "YouTube Analytics API v2 reports.query with ageGroup,gender.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.analytics", action: "demographics", risk: "low" })
  @Returns(analyticsDemographicsReturnSchema)
  async analyticsDemographics(
    @Option({
      flags: "-d, --days <n>",
      description: "Recent days, 1-365 (default: 28)",
      defaultValue: "28",
      schema: integerString(1, 365),
    })
    days?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).analyticsDemographics({ days: integer(days, 28, 1, 365) })),
    }));
  }

  @Command({
    name: "analytics-countries",
    description: "Break down recent views and watch time by country",
    helpAfter: analyticsHelp(
      "Identify the geographic distribution of the audience.",
      [
        "ravi yt analytics-countries --days 28 --limit 10 --json",
        "ravi yt analytics-countries --days 90 --limit 20 --json",
      ],
      "YouTube Analytics API v2 reports.query with dimension=country.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.analytics", action: "countries", risk: "low" })
  @Returns(analyticsCountriesReturnSchema)
  async analyticsCountries(
    @Option({
      flags: "-d, --days <n>",
      description: "Recent days, 1-365 (default: 28)",
      defaultValue: "28",
      schema: integerString(1, 365),
    })
    days?: string,
    @Option({
      flags: "-l, --limit <n>",
      description: "Rows, 1-200 (default: 10)",
      defaultValue: "10",
      schema: integerString(1, 200),
    })
    limit?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).analyticsCountries({
        days: integer(days, 28, 1, 365),
        maxResults: integer(limit, 10, 1, 200),
      })),
    }));
  }

  @Command({
    name: "analytics-devices",
    description: "Break down recent views and watch time by device type",
    helpAfter: analyticsHelp(
      "Understand which device classes viewers use.",
      ["ravi yt analytics-devices --days 28 --json", "ravi yt analytics-devices --days 90 --json"],
      "YouTube Analytics API v2 reports.query with dimension=deviceType.",
    ),
  })
  @CommandAccess({ kind: "read", resource: "youtube.analytics", action: "devices", risk: "low" })
  @Returns(analyticsDevicesReturnSchema)
  async analyticsDevices(
    @Option({
      flags: "-d, --days <n>",
      description: "Recent days, 1-365 (default: 28)",
      defaultValue: "28",
      schema: integerString(1, 365),
    })
    days?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
  ) {
    return this.execute(asJson, async () => ({
      success: true as const,
      ...(await this.client(connection).analyticsDevices({ days: integer(days, 28, 1, 365) })),
    }));
  }

  @Command({
    name: "video-update",
    description: "Update selected metadata on an owned YouTube video",
    helpAfter: mutationHelp(
      "Update only explicitly supplied fields after reviewing the current video.",
      "Never run with --execute as a test; this changes public provider state.",
      [
        'ravi yt video-update <videoId> --title "Approved title" --json',
        "ravi yt video-update <videoId> --privacy private --execute --json",
      ],
      "YouTube Data API v3 videos.list then videos.update.",
      "EXTERNAL WRITE: show video ID, current metadata and every proposed field, then obtain explicit confirmation.",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "youtube.videos",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
    input: ["id", "title", "description", "tags", "category", "privacy", "connection"],
  })
  @Returns(videoUpdateReturnSchema)
  async videoUpdate(
    @Arg("id", { description: "Owned YouTube video ID", schema: z.string().min(1) }) id: string,
    @Option({ flags: "--title <text>", description: "Replacement title" }) title?: string,
    @Option({ flags: "--description <text>", description: "Replacement description" }) description?: string,
    @Option({ flags: "--tags <csv>", description: "Replacement comma-separated tag list" }) tags?: string,
    @Option({ flags: "--category <id>", description: "Replacement category ID" }) categoryId?: string,
    @Option({
      flags: "--privacy <status>",
      description: "public|private|unlisted",
      schema: z.enum(["public", "private", "unlisted"]),
    })
    privacyStatus?: "public" | "private" | "unlisted",
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually update the video metadata; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (execute !== true) {
      // Write brake (Manual v2 7.8): metadata changes are immediately visible
      // on the public video, so dry-run by default and exit 3 before any
      // provider call.
      contractDryRun(
        "yt video-update",
        {
          id,
          title: title ?? null,
          description: description ?? null,
          tags: csv(tags) ?? null,
          categoryId: categoryId ?? null,
          privacyStatus: privacyStatus ?? null,
          connection: connection ?? "default",
        },
        { asJson },
      );
    }
    return this.execute(asJson, () =>
      this.client(connection).updateVideo(id, {
        title,
        description,
        tags: csv(tags),
        categoryId,
        privacyStatus,
      }),
    );
  }

  @Command({
    name: "video-delete",
    description: "Permanently delete an owned YouTube video",
    helpAfter: mutationHelp(
      "Delete only after independently reading the video title and obtaining literal approval.",
      "To hide a video reversibly, use `video-update --privacy private` instead.",
      ["ravi yt video <videoId> --json", "ravi yt video-delete <videoId> --execute --json"],
      "YouTube Data API v3 videos.delete.",
      "IRREVERSIBLE: show video ID and title, then obtain explicit confirmation that permanent deletion is intended.",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "youtube.videos",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
    input: ["id", "connection"],
  })
  @Returns(deleteReturnSchema)
  async videoDelete(
    @Arg("id", { description: "Owned YouTube video ID", schema: z.string().min(1) }) id: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually delete the video permanently; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (execute !== true) {
      // Write brake (Manual v2 7.8): deletion is IRREVERSIBLE on the provider,
      // so dry-run by default and exit 3 before any provider call.
      contractDryRun("yt video-delete", { id, connection: connection ?? "default", irreversible: true }, { asJson });
    }
    return this.execute(asJson, () => this.client(connection).deleteVideo(id));
  }

  @Command({
    name: "playlist-create",
    description: "Create a YouTube playlist",
    helpAfter: mutationHelp(
      "Create one playlist after checking existing names and approving title/privacy.",
      "Never retry blindly; duplicate calls create duplicate playlists.",
      [
        'ravi yt playlist-create "Approved playlist" --privacy private --json',
        'ravi yt playlist-create "Approved playlist" --privacy private --execute --json',
      ],
      "YouTube Data API v3 playlists.insert.",
      "EXTERNAL WRITE: show title, description and privacy, then obtain explicit confirmation.",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "youtube.playlists",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
    input: ["title", "description", "privacy", "connection"],
  })
  @Returns(playlistCreateReturnSchema)
  async playlistCreate(
    @Arg("title", { description: "Playlist title", schema: z.string().min(1) }) title: string,
    @Option({ flags: "--description <text>", description: "Playlist description" }) description?: string,
    @Option({
      flags: "--privacy <status>",
      description: "public|private|unlisted (default: private)",
      defaultValue: "private",
      schema: z.enum(["public", "private", "unlisted"]),
    })
    privacyStatus?: "public" | "private" | "unlisted",
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually create the playlist; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (execute !== true) {
      // Write brake (Manual v2 7.8): braked by principle — an external,
      // non-idempotent provider write (blind retries create duplicate
      // playlists, possibly public), so dry-run by default and exit 3 before
      // any provider call.
      contractDryRun(
        "yt playlist-create",
        {
          title,
          description: description ?? null,
          privacyStatus: privacyStatus ?? "private",
          connection: connection ?? "default",
        },
        { asJson },
      );
    }
    return this.execute(asJson, () => this.client(connection).createPlaylist(title, { description, privacyStatus }));
  }

  @Command({
    name: "playlist-delete",
    description: "Permanently delete a YouTube playlist without deleting its videos",
    helpAfter: mutationHelp(
      "Delete only after independently listing the playlist and obtaining literal approval.",
      "To remove one item, use `playlist-remove`; this command deletes the whole playlist.",
      ["ravi yt playlists --json", "ravi yt playlist-delete <playlistId> --execute --json"],
      "YouTube Data API v3 playlists.delete.",
      "IRREVERSIBLE: show playlist ID and title, then obtain explicit confirmation.",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "youtube.playlists",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
    input: ["playlistId", "connection"],
  })
  @Returns(deleteReturnSchema)
  async playlistDelete(
    @Arg("playlistId", { description: "Owned YouTube playlist ID", schema: z.string().min(1) }) playlistId: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually delete the playlist permanently; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (execute !== true) {
      // Write brake (Manual v2 7.8): playlist deletion is IRREVERSIBLE on the
      // provider, so dry-run by default and exit 3 before any provider call.
      contractDryRun(
        "yt playlist-delete",
        { playlistId, connection: connection ?? "default", irreversible: true },
        { asJson },
      );
    }
    return this.execute(asJson, () => this.client(connection).deletePlaylist(playlistId));
  }

  @Command({
    name: "playlist-add",
    description: "Add one video to a YouTube playlist",
    helpAfter: mutationHelp(
      "Add one reviewed video to one reviewed playlist.",
      "Never retry blindly; duplicate calls can create duplicate playlist items.",
      [
        "ravi yt playlist-add <playlistId> <videoId> --json",
        "ravi yt playlist-add <playlistId> <videoId> --execute --json",
      ],
      "YouTube Data API v3 playlistItems.insert.",
      "EXTERNAL WRITE: show playlist ID and video ID/title, then obtain explicit confirmation.",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "youtube.playlists",
    action: "add",
    risk: "high",
    requiresConfirmation: true,
    input: ["playlistId", "videoId", "connection"],
  })
  @Returns(playlistAddReturnSchema)
  async playlistAdd(
    @Arg("playlistId", { description: "Target YouTube playlist ID", schema: z.string().min(1) }) playlistId: string,
    @Arg("videoId", { description: "YouTube video ID", schema: z.string().min(1) }) videoId: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually add the video to the playlist; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (execute !== true) {
      // Write brake (Manual v2 7.8): braked by principle — an external,
      // non-idempotent provider write (blind retries duplicate playlist items
      // and the change is visible on shared/public playlists), so dry-run by
      // default and exit 3 before any provider call.
      contractDryRun("yt playlist-add", { playlistId, videoId, connection: connection ?? "default" }, { asJson });
    }
    return this.execute(asJson, () => this.client(connection).addToPlaylist(playlistId, videoId));
  }

  @Command({
    name: "playlist-remove",
    description: "Remove one playlist item without deleting the video",
    helpAfter: mutationHelp(
      "Remove one reviewed playlist item using playlistItemId from `ravi yt playlist`.",
      "Never pass videoId; a video can appear more than once with distinct item IDs.",
      ["ravi yt playlist <playlistId> --json", "ravi yt playlist-remove <playlistItemId> --execute --json"],
      "YouTube Data API v3 playlistItems.delete.",
      "DESTRUCTIVE CURATION CHANGE: show playlistItemId and video title, then obtain explicit confirmation.",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "youtube.playlists",
    action: "remove",
    risk: "destructive",
    requiresConfirmation: true,
    input: ["playlistItemId", "connection"],
  })
  @Returns(playlistRemoveReturnSchema)
  async playlistRemove(
    @Arg("playlistItemId", { description: "Playlist item ID, not video ID", schema: z.string().min(1) })
    playlistItemId: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
    @Option({ flags: "--json", description: "Print the stable JSON response" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually remove the playlist item; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    if (execute !== true) {
      // Write brake (Manual v2 7.8): destructive curation change on the
      // provider, so dry-run by default and exit 3 before any provider call.
      contractDryRun("yt playlist-remove", { playlistItemId, connection: connection ?? "default" }, { asJson });
    }
    return this.execute(asJson, () => this.client(connection).removeFromPlaylist(playlistItemId));
  }

  private client(connection?: string) {
    return this.clientFactory(connection);
  }

  private async execute<T>(asJson: boolean | undefined, operation: () => Promise<T>): Promise<T> {
    try {
      const payload = await operation();
      void asJson;
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    } catch (error) {
      // Manual v2 contract: contractFail already emitted its envelope and
      // carries the exit taxonomy — never let the legacy provider-error funnel
      // swallow it into a generic exit-1 message.
      if (error instanceof ContractError) throw error;
      return fail(youtubeError(error));
    }
  }
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    fail(`Expected an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function csv(value?: string): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function youtubeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${message} Next: run \`ravi yt health --json\` and verify the command arguments; OAuth onboarding is outside Phase 1.`;
}

function readHelp(use: string, doNotUse: string, examples: string[], source: string): string {
  return `
USE
  ${use}

NÃO USE
  ${doNotUse}

EXAMPLES
${examples.map((example) => `  ${example}`).join("\n")}

ON ERROR
  Credential unavailable -> configure provider "youtube" in the Ravi credential broker.
  API 4xx/5xx -> inspect the redacted provider message; do not retry writes blindly.

FORMATO
  --json prints the stable typed response. Provider pagination uses nextPageToken/--page.

FONTES (consultadas em 2026-07-13)
  ${source}
  https://developers.google.com/youtube/v3/docs
`;
}

function analyticsHelp(use: string, examples: string[], source: string): string {
  return `${readHelp(
    use,
    "Do not request revenue/ad metrics; financial analytics are outside this app and no monetary scope is declared.",
    examples,
    source,
  )}
REGRAS HARD
  Read-only analytics only. Requires yt-analytics.readonly and youtube.readonly; never use a monetary scope here.

FONTES ADICIONAIS (consultadas em 2026-07-13)
  https://developers.google.com/youtube/analytics/reference/reports/query
  https://developers.google.com/youtube/analytics/channel_reports
`;
}

function mutationHelp(use: string, doNotUse: string, examples: string[], source: string, confirmation: string): string {
  return `${readHelp(use, doNotUse, examples, source)}
REGRAS HARD
  Write brake (Manual v2): without --execute this is a dry-run — exit 3, the plan is printed and NOTHING reaches the provider. Review the plan, then re-run with --execute. Never retry writes blindly and always re-read state before mutation.

HITL OBRIGATÓRIO
  ${confirmation}
`;
}
