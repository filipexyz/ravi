import { resolveCredentialSecret } from "../../credentials/broker.js";
import { getCredentialConnection } from "../../credentials/store.js";

export interface YouTubeCredential {
  accessToken: string;
}

export interface YouTubeClientOptions {
  connection?: string;
  fetch?: typeof globalThis.fetch;
  /** In-process credential injection for unit tests and the later read-only proof phase. */
  credential?: YouTubeCredential;
  /** Test seam that avoids reading a real credential backend. */
  credentialResolver?: CredentialResolver;
  /** Read-only metadata seam used by health(); it never resolves a secret. */
  connectionInspector?: ConnectionInspector;
  now?: () => Date;
}

export interface ChannelInfo {
  channelId: string;
  title: string;
  description: string;
  subscriberCount: number;
  videoCount: number;
  viewCount: number;
  thumbnail: string;
  uploadsPlaylistId: string;
  url: string;
}

export interface VideoInfo {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  thumbnail: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  duration: string;
  privacyStatus: string;
  url: string;
  playlistItemId?: string;
}

export interface CommentInfo {
  threadId: string;
  commentId: string;
  author: string;
  authorChannelUrl: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  replyCount: number;
}

export interface PlaylistInfo {
  playlistId: string;
  title: string;
  description: string;
  thumbnail: string;
  itemCount: number;
  publishedAt: string;
  privacyStatus: string;
  url: string;
}

export interface AnalyticsResultTable {
  kind?: string;
  columnHeaders?: Array<{ name?: string; dataType?: string; columnType?: string }>;
  rows?: unknown[][];
}

type CredentialResolver = (connection: string, action: string) => Promise<YouTubeCredential>;
type ConnectionInspector = (connection: string) => { status?: string } | null;
type QueryValue = string | number | boolean | undefined;

const DATA_API = "https://www.googleapis.com/youtube/v3";
const ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2";

export class YouTubeClient {
  readonly #connection: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credential?: YouTubeCredential;
  readonly #credentialResolver: CredentialResolver;
  readonly #connectionInspector: ConnectionInspector;
  readonly #now: () => Date;

  constructor(options: YouTubeClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credential = options.credential;
    this.#credentialResolver =
      options.credentialResolver ??
      (async (connection, action) =>
        parseYouTubeCredential(
          (
            await resolveCredentialSecret({
              provider: "youtube",
              connection,
              action,
            })
          ).secret,
        ));
    this.#connectionInspector =
      options.connectionInspector ?? ((connection) => getCredentialConnection("youtube", connection));
    this.#now = options.now ?? (() => new Date());
  }

  health() {
    const connection = this.#connectionInspector(this.#connection);
    const credentialConfigured = connection !== null;
    const credentialStatus = connection?.status ?? "missing";
    const ready = credentialConfigured && credentialStatus === "active";
    return {
      app: "youtube",
      connection: this.#connection,
      ready,
      credentialConfigured,
      credentialStatus,
      authenticated: false,
      externalCheckPerformed: false,
      message: ready
        ? "Credential metadata is active; authentication was not exercised in Phase 1."
        : 'No active YouTube credential connection. Configure provider "youtube" before a later authenticated proof.',
    };
  }

  async channelInfo(): Promise<ChannelInfo> {
    const channel = await this.currentChannel();
    return normalizeChannel(channel);
  }

  async listVideos(options: { maxResults?: number; pageToken?: string } = {}) {
    const channel = normalizeChannel(await this.currentChannel());
    if (!channel.uploadsPlaylistId) {
      return { videos: [] as VideoInfo[], totalResults: 0, nextPageToken: undefined as string | undefined };
    }
    const playlistItems = await this.dataRequest<ListResponse<PlaylistItemResource>>(
      "/playlistItems",
      {
        part: "contentDetails,snippet",
        playlistId: channel.uploadsPlaylistId,
        maxResults: boundedInteger(options.maxResults, 10, 1, 50),
        pageToken: options.pageToken,
      },
      "videos.list",
    );
    const ids = (playlistItems.items ?? []).map((item) => item.contentDetails?.videoId ?? "").filter(Boolean);
    return {
      videos: await this.videoDetails(ids),
      totalResults: playlistItems.pageInfo?.totalResults ?? ids.length,
      nextPageToken: playlistItems.nextPageToken,
    };
  }

  async searchVideos(query: string, options: { maxResults?: number; pageToken?: string } = {}) {
    const channel = normalizeChannel(await this.currentChannel());
    const response = await this.dataRequest<ListResponse<SearchResource>>(
      "/search",
      {
        part: "snippet",
        channelId: channel.channelId,
        forMine: true,
        q: query,
        type: "video",
        order: "date",
        maxResults: boundedInteger(options.maxResults, 10, 1, 50),
        pageToken: options.pageToken,
      },
      "search.list",
    );
    const ids = (response.items ?? []).map((item) => item.id?.videoId ?? "").filter(Boolean);
    return {
      query,
      videos: await this.videoDetails(ids),
      totalResults: response.pageInfo?.totalResults ?? ids.length,
      nextPageToken: response.nextPageToken,
    };
  }

  async getVideo(videoId: string): Promise<VideoInfo | null> {
    const videos = await this.videoDetails([videoId]);
    return videos[0] ?? null;
  }

  async getVideoStats(videoId: string) {
    const video = await this.getVideo(videoId);
    if (!video) throw new Error(`YouTube video not found: ${videoId}`);
    const publishedAt = new Date(video.publishedAt);
    const elapsed = this.#now().getTime() - publishedAt.getTime();
    const daysSincePublish = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / 86_400_000)) : 0;
    return {
      videoId: video.videoId,
      title: video.title,
      viewCount: video.viewCount,
      likeCount: video.likeCount,
      commentCount: video.commentCount,
      publishedAt: video.publishedAt,
      daysSincePublish,
      viewsPerDay: daysSincePublish > 0 ? Math.round(video.viewCount / daysSincePublish) : video.viewCount,
    };
  }

  async listComments(videoId: string, options: { maxResults?: number; pageToken?: string; order?: string } = {}) {
    const response = await this.dataRequest<ListResponse<CommentThreadResource>>(
      "/commentThreads",
      {
        part: "snippet,replies",
        videoId,
        maxResults: boundedInteger(options.maxResults, 20, 1, 100),
        pageToken: options.pageToken,
        order: options.order ?? "relevance",
      },
      "comments.list",
    );
    const comments = (response.items ?? []).map(normalizeComment);
    return {
      videoId,
      comments,
      totalResults: response.pageInfo?.totalResults ?? comments.length,
      nextPageToken: response.nextPageToken,
    };
  }

  async listUnansweredComments(videoId: string, options: { maxResults?: number; pageToken?: string } = {}) {
    const response = await this.listComments(videoId, { ...options, order: "time" });
    const comments = response.comments.filter((comment) => comment.replyCount === 0);
    return {
      videoId,
      comments,
      totalUnanswered: comments.length,
      nextPageToken: response.nextPageToken,
    };
  }

  async replyToComment(commentId: string, text: string) {
    const response = await this.dataRequest<CommentResource>("/comments", { part: "snippet" }, "comments.reply", {
      method: "POST",
      body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: text } }),
    });
    return { success: true, replyId: response.id ?? "" };
  }

  async listPlaylists(options: { maxResults?: number; pageToken?: string } = {}) {
    const response = await this.dataRequest<ListResponse<PlaylistResource>>(
      "/playlists",
      {
        part: "snippet,contentDetails,status",
        mine: true,
        maxResults: boundedInteger(options.maxResults, 25, 1, 50),
        pageToken: options.pageToken,
      },
      "playlists.list",
    );
    const playlists = (response.items ?? []).map(normalizePlaylist);
    return {
      playlists,
      totalResults: response.pageInfo?.totalResults ?? playlists.length,
      nextPageToken: response.nextPageToken,
    };
  }

  async getPlaylistVideos(playlistId: string, options: { maxResults?: number; pageToken?: string } = {}) {
    const response = await this.dataRequest<ListResponse<PlaylistItemResource>>(
      "/playlistItems",
      {
        part: "snippet,contentDetails,status",
        playlistId,
        maxResults: boundedInteger(options.maxResults, 25, 1, 50),
        pageToken: options.pageToken,
      },
      "playlistItems.list",
    );
    const items = response.items ?? [];
    const videoIds = items.map((item) => item.contentDetails?.videoId ?? "").filter(Boolean);
    const details = await this.videoDetails([...new Set(videoIds)]);
    const detailsById = new Map(details.map((video) => [video.videoId, video]));
    const videos = items.map((item) => {
      const videoId = item.contentDetails?.videoId ?? "";
      const video = detailsById.get(videoId) ?? unavailableVideo(videoId, item.snippet?.title);
      return { ...video, playlistItemId: item.id || undefined };
    });
    return {
      playlistId,
      videos,
      totalResults: response.pageInfo?.totalResults ?? videos.length,
      nextPageToken: response.nextPageToken,
    };
  }

  async listSubscriptions(options: { maxResults?: number; pageToken?: string } = {}) {
    const response = await this.dataRequest<ListResponse<SubscriptionResource>>(
      "/subscriptions",
      {
        part: "snippet,contentDetails",
        mine: true,
        order: "alphabetical",
        maxResults: boundedInteger(options.maxResults, 25, 1, 50),
        pageToken: options.pageToken,
      },
      "subscriptions.list",
    );
    const subscriptions = (response.items ?? []).map((item) => {
      const channelId = item.snippet?.resourceId?.channelId ?? "";
      return {
        subscriptionId: item.id ?? "",
        channelId,
        title: item.snippet?.title ?? "",
        description: item.snippet?.description ?? "",
        thumbnail: thumbnail(item.snippet?.thumbnails),
        publishedAt: item.snippet?.publishedAt ?? "",
        totalItemCount: numeric(item.contentDetails?.totalItemCount),
        url: channelId ? `https://www.youtube.com/channel/${channelId}` : "",
      };
    });
    return {
      subscriptions,
      totalResults: response.pageInfo?.totalResults ?? subscriptions.length,
      nextPageToken: response.nextPageToken,
    };
  }

  async listCaptions(videoId: string) {
    const response = await this.dataRequest<ListResponse<CaptionResource>>(
      "/captions",
      { part: "snippet", videoId },
      "captions.list",
    );
    const captions = (response.items ?? []).map((item) => ({
      captionId: item.id ?? "",
      language: item.snippet?.language ?? "",
      name: item.snippet?.name ?? "",
      trackKind: item.snippet?.trackKind ?? "",
      isAutoSynced: item.snippet?.isAutoSynced ?? false,
      isDraft: item.snippet?.isDraft ?? false,
      status: item.snippet?.status ?? "",
      lastUpdated: item.snippet?.lastUpdated ?? "",
    }));
    return { videoId, captions, totalResults: captions.length };
  }

  async downloadCaption(captionId: string, options: { format?: string; language?: string } = {}) {
    const format = options.format ?? "srt";
    const content = await this.dataTextRequest(
      `/captions/${encodeURIComponent(captionId)}`,
      { tfmt: format, tlang: options.language },
      "captions.download",
    );
    return { success: true, captionId, format, content };
  }

  async listVideoCategories(options: { region?: string } = {}) {
    const region = options.region ?? "BR";
    const response = await this.dataRequest<ListResponse<VideoCategoryResource>>(
      "/videoCategories",
      { part: "snippet", regionCode: region },
      "videoCategories.list",
    );
    const categories = (response.items ?? []).map((item) => ({
      categoryId: item.id ?? "",
      title: item.snippet?.title ?? "",
      assignable: item.snippet?.assignable ?? false,
    }));
    return { region, categories, totalResults: categories.length };
  }

  async analyticsOverview(options: { days?: number } = {}) {
    const days = boundedInteger(options.days, 28, 1, 365);
    const data = await this.analyticsQuery(days, {
      metrics:
        "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,dislikes,comments,shares",
    });
    const row = data.rows?.[0] ?? [];
    return {
      period: `${days} days`,
      overview: {
        views: numeric(row[0]),
        watchTimeMinutes: numeric(row[1]),
        avgViewDurationSec: numeric(row[2]),
        subscribersGained: numeric(row[3]),
        subscribersLost: numeric(row[4]),
        netSubscribers: numeric(row[3]) - numeric(row[4]),
        likes: numeric(row[5]),
        dislikes: numeric(row[6]),
        comments: numeric(row[7]),
        shares: numeric(row[8]),
      },
    };
  }

  async analyticsSeries(options: { days?: number; metric?: string } = {}) {
    const days = boundedInteger(options.days, 28, 1, 365);
    const metric = options.metric ?? "views";
    const allowed = [
      "views",
      "estimatedMinutesWatched",
      "averageViewDuration",
      "subscribersGained",
      "likes",
      "comments",
      "shares",
    ];
    if (!allowed.includes(metric)) throw new Error(`Invalid YouTube Analytics metric. Use: ${allowed.join(", ")}.`);
    const data = await this.analyticsQuery(days, { metrics: metric, dimensions: "day", sort: "day" });
    return { period: `${days} days`, metric, data: analyticsRows(data) };
  }

  async analyticsTopVideos(options: { days?: number; maxResults?: number } = {}) {
    const days = boundedInteger(options.days, 28, 1, 365);
    const maxResults = boundedInteger(options.maxResults, 10, 1, 200);
    const data = await this.analyticsQuery(days, {
      metrics: "views,estimatedMinutesWatched,averageViewDuration,likes,comments",
      dimensions: "video",
      sort: "-views",
      maxResults,
    });
    const rows = data.rows ?? [];
    const details = await this.videoDetails(rows.map((row) => String(row[0] ?? "")).filter(Boolean));
    const titles = new Map(details.map((video) => [video.videoId, video.title]));
    return {
      period: `${days} days`,
      videos: rows.map((row) => ({
        videoId: String(row[0] ?? ""),
        title: titles.get(String(row[0] ?? "")) ?? "",
        views: numeric(row[1]),
        watchTimeMinutes: numeric(row[2]),
        avgViewDurationSec: numeric(row[3]),
        likes: numeric(row[4]),
        comments: numeric(row[5]),
      })),
    };
  }

  async analyticsTraffic(options: { days?: number } = {}) {
    const days = boundedInteger(options.days, 28, 1, 365);
    const data = await this.analyticsQuery(days, {
      metrics: "views,estimatedMinutesWatched",
      dimensions: "insightTrafficSourceType",
      sort: "-views",
    });
    return {
      period: `${days} days`,
      sources: (data.rows ?? []).map((row) => ({
        source: String(row[0] ?? ""),
        views: numeric(row[1]),
        watchTimeMinutes: numeric(row[2]),
      })),
    };
  }

  async analyticsDemographics(options: { days?: number } = {}) {
    const days = boundedInteger(options.days, 28, 1, 365);
    const data = await this.analyticsQuery(days, {
      metrics: "viewerPercentage",
      dimensions: "ageGroup,gender",
    });
    return {
      period: `${days} days`,
      demographics: (data.rows ?? []).map((row) => ({
        ageGroup: String(row[0] ?? ""),
        gender: String(row[1] ?? ""),
        viewerPercentage: numeric(row[2]),
      })),
    };
  }

  async analyticsCountries(options: { days?: number; maxResults?: number } = {}) {
    const days = boundedInteger(options.days, 28, 1, 365);
    const maxResults = boundedInteger(options.maxResults, 10, 1, 200);
    const data = await this.analyticsQuery(days, {
      metrics: "views,estimatedMinutesWatched,subscribersGained",
      dimensions: "country",
      sort: "-views",
      maxResults,
    });
    return {
      period: `${days} days`,
      countries: (data.rows ?? []).map((row) => ({
        country: String(row[0] ?? ""),
        views: numeric(row[1]),
        watchTimeMinutes: numeric(row[2]),
        subscribersGained: numeric(row[3]),
      })),
    };
  }

  async analyticsDevices(options: { days?: number } = {}) {
    const days = boundedInteger(options.days, 28, 1, 365);
    const data = await this.analyticsQuery(days, {
      metrics: "views,estimatedMinutesWatched",
      dimensions: "deviceType",
      sort: "-views",
    });
    return {
      period: `${days} days`,
      devices: (data.rows ?? []).map((row) => ({
        device: String(row[0] ?? ""),
        views: numeric(row[1]),
        watchTimeMinutes: numeric(row[2]),
      })),
    };
  }

  async updateVideo(
    videoId: string,
    changes: {
      title?: string;
      description?: string;
      tags?: string[];
      categoryId?: string;
      privacyStatus?: "public" | "private" | "unlisted";
    },
  ) {
    const current = await this.dataRequest<ListResponse<VideoResource>>(
      "/videos",
      { part: "snippet,status", id: videoId },
      "videos.get-for-update",
    );
    const video = current.items?.[0];
    if (!video) throw new Error(`YouTube video not found: ${videoId}`);
    const updatesSnippet =
      changes.title !== undefined ||
      changes.description !== undefined ||
      changes.tags !== undefined ||
      changes.categoryId !== undefined;
    const updatesStatus = changes.privacyStatus !== undefined;
    if (!updatesSnippet && !updatesStatus) throw new Error("Provide at least one video field to update.");
    const parts = [updatesSnippet ? "snippet" : "", updatesStatus ? "status" : ""].filter(Boolean).join(",");
    const body: Record<string, unknown> = { id: videoId };
    if (updatesSnippet) {
      body.snippet = {
        title: changes.title ?? video.snippet?.title ?? "",
        description: changes.description ?? video.snippet?.description ?? "",
        tags: changes.tags ?? video.snippet?.tags ?? [],
        categoryId: changes.categoryId ?? video.snippet?.categoryId ?? "",
        defaultLanguage: video.snippet?.defaultLanguage,
      };
    }
    if (updatesStatus) {
      const privacyStatus = changes.privacyStatus ?? video.status?.privacyStatus;
      body.status = {
        privacyStatus,
        embeddable: video.status?.embeddable,
        license: video.status?.license,
        publicStatsViewable: video.status?.publicStatsViewable,
        publishAt: privacyStatus === "private" ? video.status?.publishAt : undefined,
        selfDeclaredMadeForKids: video.status?.selfDeclaredMadeForKids,
        containsSyntheticMedia: video.status?.containsSyntheticMedia,
      };
    }
    await this.dataRequest<VideoResource>("/videos", { part: parts }, "videos.update", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const updated = await this.getVideo(videoId);
    if (!updated) throw new Error(`YouTube video not found after update: ${videoId}`);
    return { success: true, video: updated };
  }

  async deleteVideo(videoId: string) {
    await this.dataRequest<Record<string, never>>("/videos", { id: videoId }, "videos.delete", { method: "DELETE" });
    return { success: true, deleted: videoId };
  }

  async createPlaylist(
    title: string,
    options: { description?: string; privacyStatus?: "public" | "private" | "unlisted" } = {},
  ) {
    const playlist = await this.dataRequest<PlaylistResource>(
      "/playlists",
      { part: "snippet,status" },
      "playlists.create",
      {
        method: "POST",
        body: JSON.stringify({
          snippet: { title, description: options.description ?? "" },
          status: { privacyStatus: options.privacyStatus ?? "private" },
        }),
      },
    );
    return { success: true, playlist: normalizePlaylist(playlist) };
  }

  async deletePlaylist(playlistId: string) {
    await this.dataRequest<Record<string, never>>("/playlists", { id: playlistId }, "playlists.delete", {
      method: "DELETE",
    });
    return { success: true, deleted: playlistId };
  }

  async addToPlaylist(playlistId: string, videoId: string) {
    const item = await this.dataRequest<PlaylistItemResource>(
      "/playlistItems",
      { part: "snippet" },
      "playlistItems.create",
      {
        method: "POST",
        body: JSON.stringify({
          snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
        }),
      },
    );
    return {
      success: true,
      item: { playlistItemId: item.id ?? "", playlistId, videoId, title: item.snippet?.title ?? "" },
    };
  }

  async removeFromPlaylist(playlistItemId: string) {
    await this.dataRequest<Record<string, never>>("/playlistItems", { id: playlistItemId }, "playlistItems.delete", {
      method: "DELETE",
    });
    return { success: true, removed: playlistItemId };
  }

  async listActivities(options: { maxResults?: number; pageToken?: string } = {}) {
    const response = await this.dataRequest<ListResponse<ActivityResource>>(
      "/activities",
      {
        part: "snippet,contentDetails",
        mine: true,
        maxResults: options.maxResults ?? 25,
        pageToken: options.pageToken,
      },
      "activities.list",
    );
    const activities = (response.items ?? []).map(normalizeActivity);
    return {
      activities,
      totalResults: response.pageInfo?.totalResults ?? activities.length,
      nextPageToken: response.nextPageToken,
    };
  }

  async listI18nLanguages(options: { hl?: string } = {}) {
    const response = await this.dataRequest<ListResponse<I18nLanguageResource>>(
      "/i18nLanguages",
      { part: "snippet", hl: options.hl ?? "pt-BR" },
      "i18nLanguages.list",
    );
    const languages = (response.items ?? []).map((item) => ({
      code: item.snippet?.hl ?? item.id ?? "",
      name: item.snippet?.name ?? "",
    }));
    return { languages, totalResults: languages.length };
  }

  async listI18nRegions(options: { hl?: string } = {}) {
    const response = await this.dataRequest<ListResponse<I18nRegionResource>>(
      "/i18nRegions",
      { part: "snippet", hl: options.hl ?? "pt-BR" },
      "i18nRegions.list",
    );
    const regions = (response.items ?? []).map((item) => ({
      code: item.snippet?.gl ?? "",
      name: item.snippet?.name ?? "",
    }));
    return { regions, totalResults: regions.length };
  }

  async getVideoRating(videoIds: string[]) {
    const response = await this.dataRequest<ListResponse<VideoRatingResource>>(
      "/videos/getRating",
      { id: videoIds.join(",") },
      "videos.getRating",
    );
    const ratings = (response.items ?? []).map((item) => ({
      videoId: item.videoId ?? "",
      rating: item.rating ?? "none",
    }));
    return { ratings, totalResults: ratings.length };
  }

  async updateChannel(changes: {
    description?: string;
    keywords?: string;
    country?: string;
    defaultLanguage?: string;
  }) {
    if (
      changes.description === undefined &&
      changes.keywords === undefined &&
      changes.country === undefined &&
      changes.defaultLanguage === undefined
    ) {
      throw new Error("Provide at least one channel branding field to update.");
    }
    const current = await this.dataRequest<ListResponse<ChannelResource>>(
      "/channels",
      { part: "brandingSettings", mine: true },
      "channels.get-for-update",
    );
    const channel = current.items?.[0];
    if (!channel?.id) throw new Error("No YouTube channel is available to this credential.");
    const branding = channel.brandingSettings?.channel ?? {};
    const body = {
      id: channel.id,
      brandingSettings: {
        channel: {
          ...branding,
          description: changes.description ?? branding.description,
          keywords: changes.keywords ?? branding.keywords,
          country: changes.country ?? branding.country,
          defaultLanguage: changes.defaultLanguage ?? branding.defaultLanguage,
        },
      },
    };
    await this.dataRequest("/channels", { part: "brandingSettings" }, "channels.update", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    return { success: true, channel: await this.channelInfo() };
  }

  async updatePlaylist(
    playlistId: string,
    changes: { title?: string; description?: string; privacyStatus?: "public" | "private" | "unlisted" },
  ) {
    if (changes.title === undefined && changes.description === undefined && changes.privacyStatus === undefined) {
      throw new Error("Provide at least one playlist field to update.");
    }
    const current = await this.dataRequest<ListResponse<PlaylistResource>>(
      "/playlists",
      { part: "snippet,status", id: playlistId },
      "playlists.get-for-update",
    );
    const playlist = current.items?.[0];
    if (!playlist) throw new Error(`YouTube playlist not found: ${playlistId}`);
    const body = {
      id: playlistId,
      snippet: {
        title: changes.title ?? playlist.snippet?.title ?? "",
        description: changes.description ?? playlist.snippet?.description ?? "",
      },
      status: { privacyStatus: changes.privacyStatus ?? playlist.status?.privacyStatus ?? "private" },
    };
    const updated = await this.dataRequest<PlaylistResource>(
      "/playlists",
      { part: "snippet,status" },
      "playlists.update",
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    return { success: true, playlist: normalizePlaylist(updated) };
  }

  async movePlaylistItem(playlistItemId: string, position: number) {
    const current = await this.dataRequest<ListResponse<PlaylistItemResource>>(
      "/playlistItems",
      { part: "snippet", id: playlistItemId },
      "playlistItems.get-for-move",
    );
    const item = current.items?.[0];
    if (!item?.snippet?.playlistId || !item.snippet.resourceId) {
      throw new Error(`YouTube playlist item not found: ${playlistItemId}`);
    }
    const body = {
      id: playlistItemId,
      snippet: { playlistId: item.snippet.playlistId, resourceId: item.snippet.resourceId, position },
    };
    const updated = await this.dataRequest<PlaylistItemResource>(
      "/playlistItems",
      { part: "snippet" },
      "playlistItems.update",
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    return {
      success: true,
      item: {
        playlistItemId: updated.id ?? playlistItemId,
        playlistId: updated.snippet?.playlistId ?? item.snippet.playlistId,
        videoId: updated.snippet?.resourceId?.videoId ?? item.snippet.resourceId.videoId ?? "",
        position: updated.snippet?.position ?? position,
      },
    };
  }

  async insertComment(videoId: string, text: string) {
    const thread = await this.dataRequest<CommentThreadResource>(
      "/commentThreads",
      { part: "snippet" },
      "commentThreads.insert",
      {
        method: "POST",
        body: JSON.stringify({ snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } }),
      },
    );
    return { success: true, threadId: thread.id ?? "", commentId: thread.snippet?.topLevelComment?.id ?? "" };
  }

  async setCommentModeration(
    commentId: string,
    moderationStatus: "heldForReview" | "published" | "rejected",
    banAuthor?: boolean,
  ) {
    await this.dataRequest(
      "/comments/setModerationStatus",
      { id: commentId, moderationStatus, banAuthor: banAuthor ? "true" : undefined },
      "comments.setModerationStatus",
      { method: "POST" },
    );
    return { success: true, commentId, moderationStatus };
  }

  async deleteComment(commentId: string) {
    await this.dataRequest("/comments", { id: commentId }, "comments.delete", { method: "DELETE" });
    return { success: true, deleted: commentId };
  }

  async updateComment(commentId: string, text: string) {
    const updated = await this.dataRequest<CommentResource>("/comments", { part: "snippet" }, "comments.update", {
      method: "PUT",
      body: JSON.stringify({ id: commentId, snippet: { textOriginal: text } }),
    });
    return { success: true, commentId: updated.id ?? commentId, text: updated.snippet?.textDisplay ?? text };
  }

  async subscribe(channelId: string) {
    const subscription = await this.dataRequest<SubscriptionResource>(
      "/subscriptions",
      { part: "snippet" },
      "subscriptions.insert",
      {
        method: "POST",
        body: JSON.stringify({ snippet: { resourceId: { kind: "youtube#channel", channelId } } }),
      },
    );
    return { success: true, subscriptionId: subscription.id ?? "", channelId };
  }

  async unsubscribe(subscriptionId: string) {
    await this.dataRequest("/subscriptions", { id: subscriptionId }, "subscriptions.delete", { method: "DELETE" });
    return { success: true, deleted: subscriptionId };
  }

  async deleteCaption(captionId: string) {
    await this.dataRequest("/captions", { id: captionId }, "captions.delete", { method: "DELETE" });
    return { success: true, deleted: captionId };
  }

  async setThumbnail(videoId: string, image: { data: Uint8Array; contentType: string }) {
    const result = await this.uploadRequest<ListResponse<ThumbnailSetResource>>(
      "https://www.googleapis.com/upload/youtube/v3/thumbnails/set",
      { videoId, uploadType: "media" },
      "thumbnails.set",
      image.data,
      image.contentType,
    );
    const item = result.items?.[0];
    return {
      success: true,
      videoId,
      thumbnail: item?.high?.url ?? item?.medium?.url ?? item?.default?.url ?? "",
    };
  }

  private async currentChannel(): Promise<ChannelResource> {
    const response = await this.dataRequest<ListResponse<ChannelResource>>(
      "/channels",
      { part: "snippet,statistics,contentDetails", mine: true },
      "channels.info",
    );
    const channel = response.items?.[0];
    if (!channel) throw new Error("No YouTube channel is available to this credential.");
    return channel;
  }

  private async videoDetails(ids: string[]): Promise<VideoInfo[]> {
    if (ids.length === 0) return [];
    const response = await this.dataRequest<ListResponse<VideoResource>>(
      "/videos",
      { part: "snippet,statistics,contentDetails,status", id: ids.join(",") },
      "videos.list",
    );
    const byId = new Map((response.items ?? []).map((video) => [video.id ?? "", normalizeVideo(video)]));
    return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  }

  private async analyticsQuery(days: number, params: Record<string, QueryValue>): Promise<AnalyticsResultTable> {
    const { startDate, endDate } = dateRange(days, this.#now());
    return this.requestJson<AnalyticsResultTable>(
      `${ANALYTICS_API}/reports`,
      { ids: "channel==MINE", startDate, endDate, ...params },
      "analytics.query",
    );
  }

  private dataRequest<T>(path: string, query: Record<string, QueryValue>, action: string, init?: RequestInit) {
    return this.requestJson<T>(`${DATA_API}${path}`, query, action, init);
  }

  private dataTextRequest(path: string, query: Record<string, QueryValue>, action: string) {
    return this.requestText(`${DATA_API}${path}`, query, action);
  }

  private async requestJson<T>(
    baseUrl: string,
    query: Record<string, QueryValue>,
    action: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.request(baseUrl, query, action, init);
    const text = await response.text();
    if (!response.ok) throw requestError(response.status, text);
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`YouTube API returned invalid JSON (${response.status}).`);
    }
  }

  private async uploadRequest<T>(
    uploadUrl: string,
    query: Record<string, QueryValue>,
    action: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<T> {
    const credential = await this.resolveCredential(action);
    const url = new URL(uploadUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.#fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.accessToken}`, "content-type": contentType },
      body: body as unknown as RequestInit["body"],
    });
    const text = await response.text();
    if (!response.ok) throw requestError(response.status, text);
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`YouTube API returned invalid JSON (${response.status}).`);
    }
  }

  private async requestText(baseUrl: string, query: Record<string, QueryValue>, action: string): Promise<string> {
    const response = await this.request(baseUrl, query, action, {});
    const text = await response.text();
    if (!response.ok) throw requestError(response.status, text);
    return text;
  }

  private async request(
    baseUrl: string,
    query: Record<string, QueryValue>,
    action: string,
    init: RequestInit,
  ): Promise<Response> {
    const credential = await this.resolveCredential(action);
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return this.#fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  }

  private async resolveCredential(action: string): Promise<YouTubeCredential> {
    if (this.#credential) return this.#credential;
    try {
      return await this.#credentialResolver(this.#connection, action);
    } catch {
      throw new Error(
        `YouTube credential unavailable for connection "${this.#connection}". ` +
          'Configure provider "youtube" in the Ravi credential broker; OAuth onboarding is outside Phase 1.',
      );
    }
  }
}

export function parseYouTubeCredential(value: string): YouTubeCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("YouTube credential must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("YouTube credential must be a JSON object.");
  }
  const accessToken = (parsed as Record<string, unknown>).accessToken;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error('YouTube credential is missing the "accessToken" field.');
  }
  return { accessToken: accessToken.trim() };
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
  pageInfo?: { totalResults?: number; resultsPerPage?: number };
}

interface ThumbnailSet {
  default?: { url?: string };
  medium?: { url?: string };
  high?: { url?: string };
}

interface ChannelResource {
  id?: string;
  snippet?: { title?: string; description?: string; thumbnails?: ThumbnailSet };
  statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  brandingSettings?: {
    channel?: {
      title?: string;
      description?: string;
      keywords?: string;
      country?: string;
      defaultLanguage?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

interface PlaylistItemSnippet {
  title?: string;
  playlistId?: string;
  position?: number;
  resourceId?: { kind?: string; videoId?: string };
}

interface ThumbnailSetResource {
  default?: { url?: string };
  medium?: { url?: string };
  high?: { url?: string };
}

interface VideoResource {
  id?: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    thumbnails?: ThumbnailSet;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
  contentDetails?: { duration?: string };
  status?: {
    privacyStatus?: string;
    embeddable?: boolean;
    license?: string;
    publicStatsViewable?: boolean;
    publishAt?: string;
    selfDeclaredMadeForKids?: boolean;
    containsSyntheticMedia?: boolean;
  };
}

interface SearchResource {
  id?: { videoId?: string };
}

interface CommentResource {
  id?: string;
  snippet?: {
    authorDisplayName?: string;
    authorChannelUrl?: string;
    textDisplay?: string;
    likeCount?: number;
    publishedAt?: string;
  };
}

interface CommentThreadResource {
  id?: string;
  snippet?: { topLevelComment?: CommentResource; totalReplyCount?: number };
}

interface PlaylistResource {
  id?: string;
  snippet?: { title?: string; description?: string; thumbnails?: ThumbnailSet; publishedAt?: string };
  contentDetails?: { itemCount?: number };
  status?: { privacyStatus?: string };
}

interface PlaylistItemResource {
  id?: string;
  snippet?: PlaylistItemSnippet;
  contentDetails?: { videoId?: string };
}

interface SubscriptionResource {
  id?: string;
  snippet?: {
    resourceId?: { channelId?: string };
    title?: string;
    description?: string;
    thumbnails?: ThumbnailSet;
    publishedAt?: string;
  };
  contentDetails?: { totalItemCount?: number };
}

interface CaptionResource {
  id?: string;
  snippet?: {
    language?: string;
    name?: string;
    trackKind?: string;
    isAutoSynced?: boolean;
    isDraft?: boolean;
    status?: string;
    lastUpdated?: string;
  };
}

interface ActivityResource {
  id?: string;
  snippet?: { type?: string; title?: string; description?: string; publishedAt?: string; thumbnails?: ThumbnailSet };
  contentDetails?: {
    upload?: { videoId?: string };
    playlistItem?: { resourceId?: { videoId?: string } };
    like?: { resourceId?: { videoId?: string } };
  };
}

interface I18nLanguageResource {
  id?: string;
  snippet?: { hl?: string; name?: string };
}

interface I18nRegionResource {
  id?: string;
  snippet?: { gl?: string; name?: string };
}

interface VideoRatingResource {
  videoId?: string;
  rating?: string;
}

function normalizeActivity(item: ActivityResource) {
  const snippet = item.snippet;
  const details = item.contentDetails;
  return {
    activityId: item.id ?? "",
    type: snippet?.type ?? "",
    title: snippet?.title ?? "",
    description: snippet?.description ?? "",
    publishedAt: snippet?.publishedAt ?? "",
    thumbnail: snippet?.thumbnails?.medium?.url ?? snippet?.thumbnails?.default?.url ?? "",
    videoId:
      details?.upload?.videoId ??
      details?.playlistItem?.resourceId?.videoId ??
      details?.like?.resourceId?.videoId ??
      "",
  };
}

interface VideoCategoryResource {
  id?: string;
  snippet?: { title?: string; assignable?: boolean };
}

function normalizeChannel(channel: ChannelResource): ChannelInfo {
  const channelId = channel.id ?? "";
  return {
    channelId,
    title: channel.snippet?.title ?? "",
    description: channel.snippet?.description ?? "",
    subscriberCount: numeric(channel.statistics?.subscriberCount),
    videoCount: numeric(channel.statistics?.videoCount),
    viewCount: numeric(channel.statistics?.viewCount),
    thumbnail: thumbnail(channel.snippet?.thumbnails),
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads ?? "",
    url: channelId ? `https://www.youtube.com/channel/${channelId}` : "",
  };
}

function normalizeVideo(video: VideoResource): VideoInfo {
  const videoId = video.id ?? "";
  return {
    videoId,
    title: video.snippet?.title ?? "",
    description: video.snippet?.description ?? "",
    publishedAt: video.snippet?.publishedAt ?? "",
    thumbnail: thumbnail(video.snippet?.thumbnails),
    viewCount: numeric(video.statistics?.viewCount),
    likeCount: numeric(video.statistics?.likeCount),
    commentCount: numeric(video.statistics?.commentCount),
    duration: video.contentDetails?.duration ?? "",
    privacyStatus: video.status?.privacyStatus ?? "",
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
  };
}

function unavailableVideo(videoId: string, title = ""): VideoInfo {
  return {
    videoId,
    title,
    description: "",
    publishedAt: "",
    thumbnail: "",
    viewCount: 0,
    likeCount: 0,
    commentCount: 0,
    duration: "",
    privacyStatus: "",
    url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
  };
}

function normalizeComment(thread: CommentThreadResource): CommentInfo {
  const comment = thread.snippet?.topLevelComment;
  return {
    threadId: thread.id ?? "",
    commentId: comment?.id ?? "",
    author: comment?.snippet?.authorDisplayName ?? "",
    authorChannelUrl: comment?.snippet?.authorChannelUrl ?? "",
    text: comment?.snippet?.textDisplay ?? "",
    likeCount: numeric(comment?.snippet?.likeCount),
    publishedAt: comment?.snippet?.publishedAt ?? "",
    replyCount: numeric(thread.snippet?.totalReplyCount),
  };
}

function normalizePlaylist(playlist: PlaylistResource): PlaylistInfo {
  const playlistId = playlist.id ?? "";
  return {
    playlistId,
    title: playlist.snippet?.title ?? "",
    description: playlist.snippet?.description ?? "",
    thumbnail: thumbnail(playlist.snippet?.thumbnails),
    itemCount: numeric(playlist.contentDetails?.itemCount),
    publishedAt: playlist.snippet?.publishedAt ?? "",
    privacyStatus: playlist.status?.privacyStatus ?? "",
    url: playlistId ? `https://www.youtube.com/playlist?list=${playlistId}` : "",
  };
}

function analyticsRows(data: AnalyticsResultTable): Array<Record<string, string | number | boolean | null>> {
  const headers = (data.columnHeaders ?? []).map((header) => header.name ?? "");
  return (data.rows ?? []).map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, jsonScalar(row[index])])),
  );
}

function jsonScalar(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null;
}

function dateRange(days: number, now: Date): { startDate: string; endDate: string } {
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { startDate: isoDate(start), endDate: isoDate(end) };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = value ?? fallback;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function thumbnail(thumbnails?: ThumbnailSet): string {
  return thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url ?? "";
}

function numeric(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function requestError(status: number, body: string): Error {
  return new Error(`YouTube API request failed (${status}): ${redact(body) || "empty response"}`);
}

function redact(value: string): string {
  return value
    .replace(/("?(?:access_token|accessToken|refresh_token|client_secret)"?\s*[:=]\s*"?)[^"\s,}]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}
