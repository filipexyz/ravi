import { describe, expect, it } from "bun:test";
import { GoogleBusinessProfileClient, parseCredential } from "./client.js";

const fakeCredential = { clientId: "test-client", clientSecret: "test-secret", refreshToken: "test-refresh" };

interface Call {
  url: string;
  method: string;
  body: string | null;
  authorization: string | null;
}

function recordingFetch(calls: Call[]) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "test-access-token" });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
}

describe("GoogleBusinessProfileClient", () => {
  it("accepts only the portable credential envelope", () => {
    expect(parseCredential('{"clientId":"id","clientSecret":"secret","refreshToken":"refresh"}')).toEqual({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
    expect(() => parseCredential('{"clientId":"id"}')).toThrow("clientSecret");
    expect(() => parseCredential("not-json")).toThrow("must be JSON");
  });

  it("fails closed before network access when credential resolution fails", async () => {
    let fetchCalls = 0;
    const client = new GoogleBusinessProfileClient({
      fetch: (async () => {
        fetchCalls += 1;
        return Response.json({});
      }) as unknown as typeof fetch,
      credentialResolver: async () => {
        throw new Error("Google Business Profile credential is not configured");
      },
    });

    await expect(client.listAccounts()).rejects.toThrow("credential is not configured");
    expect(fetchCalls).toBe(0);
  });

  it("uses official federated read endpoints with fake transport only", async () => {
    const calls: Call[] = [];
    const client = new GoogleBusinessProfileClient({ credential: fakeCredential, fetch: recordingFetch(calls) });

    await client.listAccounts(25, "next");
    await client.getAccount("123");
    await client.listLocations("123", "name,title", 25, "next");
    await client.getLocation("456", "name,title");
    await client.listReviews("123", "456", 25, "next");
    await client.getReview("123", "456", "review-1");
    await client.listPosts("123", "456", 25, "next");
    await client.getPost("123", "456", "post-1");
    await client.listMedia("123", "456", 25, "next");
    await client.getMedia("123", "456", "media-1");
    await client.performance("456", ["WEBSITE_CLICKS", "CALL_CLICKS"], "2026-06-01", "2026-06-30");
    await client.searchKeywords("456", "2026-01", "2026-06", 25, "next");
    await client.listCategories("BR", "pt-BR", "embalagem", 25, "next");
    await client.getAttributes("456");
    await client.listVerifications("456");
    await client.fetchVerificationOptions("456", "pt-BR");
    await client.listAdmins("accounts/123");

    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls.slice(1).every((call) => call.authorization === "Bearer test-access-token")).toBe(true);
    expect(calls.slice(1).map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: "https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=25&pageToken=next",
        method: "GET",
      },
      { url: "https://mybusinessaccountmanagement.googleapis.com/v1/accounts/123", method: "GET" },
      {
        url: "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/123/locations?readMask=name%2Ctitle&pageSize=25&pageToken=next",
        method: "GET",
      },
      {
        url: "https://mybusinessbusinessinformation.googleapis.com/v1/locations/456?readMask=name%2Ctitle",
        method: "GET",
      },
      {
        url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews?pageSize=25&pageToken=next&orderBy=updateTime+desc",
        method: "GET",
      },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews/review-1", method: "GET" },
      {
        url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts?pageSize=25&pageToken=next",
        method: "GET",
      },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts/post-1", method: "GET" },
      {
        url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/media?pageSize=25&pageToken=next",
        method: "GET",
      },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/media/media-1", method: "GET" },
      {
        url: "https://businessprofileperformance.googleapis.com/v1/locations/456:fetchMultiDailyMetricsTimeSeries?dailyMetrics=WEBSITE_CLICKS&dailyMetrics=CALL_CLICKS&dailyRange.startDate.year=2026&dailyRange.startDate.month=6&dailyRange.startDate.day=1&dailyRange.endDate.year=2026&dailyRange.endDate.month=6&dailyRange.endDate.day=30",
        method: "GET",
      },
      {
        url: "https://businessprofileperformance.googleapis.com/v1/locations/456/searchkeywords/impressions/monthly?monthlyRange.startMonth.year=2026&monthlyRange.startMonth.month=1&monthlyRange.endMonth.year=2026&monthlyRange.endMonth.month=6&pageSize=25&pageToken=next",
        method: "GET",
      },
      {
        url: "https://mybusinessbusinessinformation.googleapis.com/v1/categories?regionCode=BR&languageCode=pt-BR&filter=displayName%3Dembalagem&view=FULL&pageSize=25&pageToken=next",
        method: "GET",
      },
      { url: "https://mybusinessbusinessinformation.googleapis.com/v1/locations/456/attributes", method: "GET" },
      { url: "https://mybusinessverifications.googleapis.com/v1/locations/456/verifications", method: "GET" },
      {
        url: "https://mybusinessverifications.googleapis.com/v1/locations/456:fetchVerificationOptions",
        method: "POST",
      },
      { url: "https://mybusinessaccountmanagement.googleapis.com/v1/accounts/123/admins", method: "GET" },
    ]);
    expect(JSON.parse(calls.at(-2)?.body ?? "null")).toEqual({ languageCode: "pt-BR" });
  });

  it("uses official methods for writes without making live calls", async () => {
    const calls: Call[] = [];
    const client = new GoogleBusinessProfileClient({ credential: fakeCredential, fetch: recordingFetch(calls) });

    await client.updateLocation("456", { websiteUri: "https://example.test" }, "websiteUri");
    await client.deleteLocation("456");
    await client.updateReviewReply("123", "456", "review-1", "Obrigado");
    await client.deleteReviewReply("123", "456", "review-1");
    await client.createPost("123", "456", { topicType: "STANDARD", summary: "Novidade" });
    await client.updatePost("123", "456", "post-1", { summary: "Novo" }, "summary");
    await client.deletePost("123", "456", "post-1");
    await client.createMedia("123", "456", { mediaFormat: "PHOTO", sourceUrl: "https://example.test/a.jpg" });
    await client.updateMedia(
      "123",
      "456",
      "media-1",
      { locationAssociation: { category: "COVER" } },
      "locationAssociation",
    );
    await client.deleteMedia("123", "456", "media-1");
    await client.verify("456", "SMS", { phoneNumber: "+551100000000" }, "pt-BR");
    await client.completeVerification("locations/456/verifications/789", "123456");
    await client.createAdmin("accounts/123", "person@example.test", "MANAGER");
    await client.updateAdmin("accounts/123/admins/789", "OWNER");
    await client.deleteAdmin("accounts/123/admins/789");

    expect(calls.slice(1).map(({ url, method }) => ({ url, method }))).toEqual([
      {
        url: "https://mybusinessbusinessinformation.googleapis.com/v1/locations/456?updateMask=websiteUri",
        method: "PATCH",
      },
      { url: "https://mybusinessbusinessinformation.googleapis.com/v1/locations/456", method: "DELETE" },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews/review-1/reply", method: "PUT" },
      {
        url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/reviews/review-1/reply",
        method: "DELETE",
      },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts", method: "POST" },
      {
        url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts/post-1?updateMask=summary",
        method: "PATCH",
      },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/localPosts/post-1", method: "DELETE" },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/media", method: "POST" },
      {
        url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/media/media-1?updateMask=locationAssociation",
        method: "PATCH",
      },
      { url: "https://mybusiness.googleapis.com/v4/accounts/123/locations/456/media/media-1", method: "DELETE" },
      { url: "https://mybusinessverifications.googleapis.com/v1/locations/456:verify", method: "POST" },
      {
        url: "https://mybusinessverifications.googleapis.com/v1/locations/456/verifications/789:complete",
        method: "POST",
      },
      { url: "https://mybusinessaccountmanagement.googleapis.com/v1/accounts/123/admins", method: "POST" },
      {
        url: "https://mybusinessaccountmanagement.googleapis.com/v1/accounts/123/admins/789?updateMask=role",
        method: "PATCH",
      },
      { url: "https://mybusinessaccountmanagement.googleapis.com/v1/accounts/123/admins/789", method: "DELETE" },
    ]);
    expect(JSON.parse(calls[11]?.body ?? "null")).toEqual({
      method: "SMS",
      languageCode: "pt-BR",
      phoneNumber: "+551100000000",
    });
  });

  it("redacts OAuth fields from provider errors", async () => {
    const client = new GoogleBusinessProfileClient({
      credential: fakeCredential,
      fetch: (async (input: string | URL | Request) => {
        if (String(input) === "https://oauth2.googleapis.com/token")
          return Response.json({ access_token: "test-access-token" });
        return Response.json(
          { access_token: "do-not-leak", refresh_token: "do-not-leak", client_secret: "do-not-leak" },
          { status: 401 },
        );
      }) as unknown as typeof fetch,
    });

    await expect(client.listAccounts()).rejects.toThrow("[redacted]");
    await expect(client.listAccounts()).rejects.not.toThrow("do-not-leak");
  });
});
