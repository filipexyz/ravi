import "reflect-metadata";
import { z } from "zod";
import { GoogleBusinessProfileClient, type GbpJson } from "../../apps/google-business-profile/client.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";
import { jsonValueSchema } from "../return-schemas.js";

const resourceSchema = z.string().min(1);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/, "Expected YYYY-MM");
const wrappedSchema = z.object({ result: jsonValueSchema }).strict();
const defaultLocationReadMask =
  "name,title,storeCode,websiteUri,phoneNumbers,regularHours,categories,metadata,profile,serviceArea";

@Group({
  name: "gbp",
  description: "Operate Google Business Profile through credentials stored in Ravi",
  scope: "open",
})
export class GoogleBusinessProfileCommands {
  private client(connection?: string) {
    return new GoogleBusinessProfileClient({ connection });
  }

  @Command({
    name: "accounts",
    description: "List Google Business Profile accounts available to the credential",
    helpAfter: readHelp("ravi gbp accounts", "ravi gbp accounts --limit 25 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.accounts", action: "list", risk: "low" })
  @Returns(wrappedSchema)
  async accounts(
    @Option({ flags: "--limit <n>", description: "Page size from 1 to 100 (default: 50)" }) limit?: string,
    @Option({ flags: "--cursor <token>", description: "Provider page token from the previous response" })
    cursor?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(await this.client(connection).listAccounts(integer(limit, 50, 1, 100), cursor));
  }

  @Command({
    name: "account-get",
    description: "Get one Google Business Profile account",
    helpAfter: readHelp("ravi gbp account-get accounts/123", "ravi gbp account-get 123 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.accounts", action: "get", risk: "low" })
  @Returns(wrappedSchema)
  async accountGet(
    @Arg("account", { description: "Account id or accounts/{id} resource name", schema: resourceSchema })
    account: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(await this.client(connection).getAccount(account));
  }

  @Command({
    name: "locations",
    description: "List locations owned by a Google Business Profile account",
    helpAfter: readHelp(
      "ravi gbp locations accounts/123",
      "ravi gbp locations 123 --limit 25 --mask name,title,metadata --json",
    ),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.locations", action: "list", risk: "low" })
  @Returns(wrappedSchema)
  async locations(
    @Arg("account", { description: "Account id or accounts/{id} resource name", schema: resourceSchema })
    account: string,
    @Option({ flags: "--mask <fields>", description: "Business Information read mask" }) mask?: string,
    @Option({ flags: "--limit <n>", description: "Page size from 1 to 100 (default: 50)" }) limit?: string,
    @Option({ flags: "--cursor <token>", description: "Provider page token from the previous response" })
    cursor?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(
      await this.client(connection).listLocations(
        account,
        mask ?? defaultLocationReadMask,
        integer(limit, 50, 1, 100),
        cursor,
      ),
    );
  }

  @Command({
    name: "location-get",
    description: "Get one Google Business Profile location",
    helpAfter: readHelp(
      "ravi gbp location-get locations/456",
      "ravi gbp location-get 456 --mask name,title,regularHours --json",
    ),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.locations", action: "get", risk: "low" })
  @Returns(wrappedSchema)
  async locationGet(
    @Arg("location", { description: "Location id or locations/{id} resource name", schema: resourceSchema })
    location: string,
    @Option({ flags: "--mask <fields>", description: "Business Information read mask" }) mask?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(await this.client(connection).getLocation(location, mask ?? defaultLocationReadMask));
  }

  @Command({
    name: "location-update",
    description: "Update selected fields on a Google Business Profile location",
    helpAfter: mutateHelp(
      'ravi gbp location-update locations/456 --mask websiteUri --payload \'{"websiteUri":"https://example.com"}\'',
      'ravi gbp location-update 456 --mask regularHours --payload \'{"regularHours":{"periods":[]}}\' --json',
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.locations",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
    input: ["location", "mask", "payload"],
    redactions: ["payload"],
  })
  @Returns(wrappedSchema)
  async locationUpdate(
    @Arg("location", { description: "Location id or locations/{id} resource name", schema: resourceSchema })
    location: string,
    @Option({ flags: "--mask <fields>", description: "Required update mask" }) mask?: string,
    @Option({ flags: "--payload <json>", description: "Location JSON object" }) payload?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(await this.client(connection).updateLocation(location, jsonObject(payload), required(mask, "--mask")));
  }

  @Command({
    name: "location-delete",
    description: "Delete a Google Business Profile location",
    helpAfter: destructiveHelp("ravi gbp location-delete locations/456", "ravi gbp location-delete 456 --json"),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.locations",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(wrappedSchema)
  async locationDelete(
    @Arg("location", { description: "Location id or locations/{id} resource name", schema: resourceSchema })
    location: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(await this.client(connection).deleteLocation(location));
  }

  @Command({
    name: "reviews",
    description: "List reviews for a Google Business Profile location",
    helpAfter: readHelp("ravi gbp reviews accounts/123 locations/456", "ravi gbp reviews 123 456 --limit 25 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.reviews", action: "list", risk: "low" })
  @Returns(wrappedSchema)
  async reviews(
    @Arg("account", { description: "Account id or accounts/{id}", schema: resourceSchema }) account: string,
    @Arg("location", { description: "Location id or locations/{id}", schema: resourceSchema }) location: string,
    @Option({ flags: "--limit <n>", description: "Page size from 1 to 50 (default: 50)" }) limit?: string,
    @Option({ flags: "--cursor <token>", description: "Provider page token from the previous response" })
    cursor?: string,
    @Option({ flags: "--connection <id>", description: "Credential connection (default: default)" })
    connection?: string,
  ) {
    return wrap(await this.client(connection).listReviews(account, location, integer(limit, 50, 1, 50), cursor));
  }

  @Command({
    name: "review-get",
    description: "Get one Google Business Profile review",
    helpAfter: readHelp(
      "ravi gbp review-get 123 456 REVIEW_ID",
      "ravi gbp review-get accounts/123 locations/456 REVIEW_ID --json",
    ),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.reviews", action: "get", risk: "low" })
  @Returns(wrappedSchema)
  async reviewGet(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("review", { schema: resourceSchema }) review: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getReview(account, location, review));
  }

  @Command({
    name: "review-reply",
    description: "Publish or replace the public reply to a review",
    helpAfter: mutateHelp(
      "ravi gbp review-reply 123 456 REVIEW_ID --comment 'Obrigado pelo feedback.'",
      "ravi gbp review-reply accounts/123 locations/456 REVIEW_ID --comment 'Vamos resolver pelo canal privado.' --json",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.reviews",
    action: "reply",
    risk: "high",
    requiresConfirmation: true,
    input: ["account", "location", "review", "comment"],
    redactions: ["comment"],
  })
  @Returns(wrappedSchema)
  async reviewReply(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("review", { schema: resourceSchema }) review: string,
    @Option({ flags: "--comment <text>", description: "Public reply text" }) comment?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).updateReviewReply(account, location, review, required(comment, "--comment")),
    );
  }

  @Command({
    name: "review-reply-delete",
    description: "Delete the public reply from a review",
    helpAfter: destructiveHelp(
      "ravi gbp review-reply-delete 123 456 REVIEW_ID",
      "ravi gbp review-reply-delete accounts/123 locations/456 REVIEW_ID --json",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.reviews",
    action: "delete-reply",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(wrappedSchema)
  async reviewReplyDelete(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("review", { schema: resourceSchema }) review: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).deleteReviewReply(account, location, review));
  }

  @Command({
    name: "posts",
    description: "List local posts for a Google Business Profile location",
    helpAfter: readHelp("ravi gbp posts 123 456", "ravi gbp posts 123 456 --limit 25 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.posts", action: "list", risk: "low" })
  @Returns(wrappedSchema)
  async posts(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--limit <n>", description: "Page size from 1 to 100 (default: 50)" }) limit?: string,
    @Option({ flags: "--cursor <token>" }) cursor?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).listPosts(account, location, integer(limit, 50, 1, 100), cursor));
  }

  @Command({
    name: "post-get",
    description: "Get one local post",
    helpAfter: readHelp("ravi gbp post-get 123 456 POST_ID", "ravi gbp post-get 123 456 POST_ID --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.posts", action: "get", risk: "low" })
  @Returns(wrappedSchema)
  async postGet(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("post", { schema: resourceSchema }) post: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getPost(account, location, post));
  }

  @Command({
    name: "post-create",
    description: "Publish a local post",
    helpAfter: mutateHelp(
      'ravi gbp post-create 123 456 --payload \'{"topicType":"STANDARD","summary":"Novidade"}\'',
      'ravi gbp post-create 123 456 --payload \'{"topicType":"STANDARD","summary":"Novidade"}\' --json',
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.posts",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
    input: ["account", "location", "payload"],
    redactions: ["payload"],
  })
  @Returns(wrappedSchema)
  async postCreate(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--payload <json>", description: "LocalPost JSON object" }) payload?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).createPost(account, location, jsonObject(payload)));
  }

  @Command({
    name: "post-update",
    description: "Update selected fields on a local post",
    helpAfter: mutateHelp(
      'ravi gbp post-update 123 456 POST_ID --mask summary --payload \'{"summary":"Texto novo"}\'',
      'ravi gbp post-update 123 456 POST_ID --mask callToAction --payload \'{"callToAction":{"actionType":"LEARN_MORE","url":"https://example.com"}}\' --json',
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.posts",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
    input: ["account", "location", "post", "mask", "payload"],
    redactions: ["payload"],
  })
  @Returns(wrappedSchema)
  async postUpdate(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("post", { schema: resourceSchema }) post: string,
    @Option({ flags: "--mask <fields>", description: "Required update mask" }) mask?: string,
    @Option({ flags: "--payload <json>", description: "LocalPost JSON object" }) payload?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).updatePost(account, location, post, jsonObject(payload), required(mask, "--mask")),
    );
  }

  @Command({
    name: "post-delete",
    description: "Delete a local post",
    helpAfter: destructiveHelp("ravi gbp post-delete 123 456 POST_ID", "ravi gbp post-delete 123 456 POST_ID --json"),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.posts",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(wrappedSchema)
  async postDelete(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("post", { schema: resourceSchema }) post: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).deletePost(account, location, post));
  }

  @Command({
    name: "media",
    description: "List media for a Google Business Profile location",
    helpAfter: readHelp("ravi gbp media 123 456", "ravi gbp media 123 456 --limit 25 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.media", action: "list", risk: "low" })
  @Returns(wrappedSchema)
  async media(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--limit <n>", description: "Page size from 1 to 2500 (default: 50)" }) limit?: string,
    @Option({ flags: "--cursor <token>" }) cursor?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).listMedia(account, location, integer(limit, 50, 1, 2500), cursor));
  }

  @Command({
    name: "media-get",
    description: "Get one media item",
    helpAfter: readHelp("ravi gbp media-get 123 456 MEDIA_KEY", "ravi gbp media-get 123 456 MEDIA_KEY --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.media", action: "get", risk: "low" })
  @Returns(wrappedSchema)
  async mediaGet(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("media", { schema: resourceSchema }) media: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getMedia(account, location, media));
  }

  @Command({
    name: "media-create",
    description: "Publish a media item from an official MediaItem payload",
    helpAfter: mutateHelp(
      'ravi gbp media-create 123 456 --payload \'{"mediaFormat":"PHOTO","sourceUrl":"https://example.com/photo.jpg","locationAssociation":{"category":"COVER"}}\'',
      'ravi gbp media-create 123 456 --payload \'{"mediaFormat":"PHOTO","sourceUrl":"https://example.com/photo.jpg","locationAssociation":{"category":"PROFILE"}}\' --json',
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.media",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
    input: ["account", "location", "payload"],
    redactions: ["payload"],
  })
  @Returns(wrappedSchema)
  async mediaCreate(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--payload <json>", description: "MediaItem JSON object" }) payload?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).createMedia(account, location, jsonObject(payload)));
  }

  @Command({
    name: "media-update",
    description: "Update mutable metadata on a media item",
    helpAfter: mutateHelp(
      'ravi gbp media-update 123 456 MEDIA_KEY --mask locationAssociation --payload \'{"locationAssociation":{"category":"PROFILE"}}\'',
      'ravi gbp media-update 123 456 MEDIA_KEY --mask locationAssociation --payload \'{"locationAssociation":{"category":"COVER"}}\' --json',
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.media",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
    input: ["account", "location", "media", "mask", "payload"],
    redactions: ["payload"],
  })
  @Returns(wrappedSchema)
  async mediaUpdate(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("media", { schema: resourceSchema }) media: string,
    @Option({ flags: "--mask <fields>", description: "Required update mask" }) mask?: string,
    @Option({ flags: "--payload <json>", description: "MediaItem JSON object" }) payload?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).updateMedia(
        account,
        location,
        media,
        jsonObject(payload),
        required(mask, "--mask"),
      ),
    );
  }

  @Command({
    name: "media-delete",
    description: "Delete a media item",
    helpAfter: destructiveHelp(
      "ravi gbp media-delete 123 456 MEDIA_KEY",
      "ravi gbp media-delete 123 456 MEDIA_KEY --json",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.media",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(wrappedSchema)
  async mediaDelete(
    @Arg("account", { schema: resourceSchema }) account: string,
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("media", { schema: resourceSchema }) media: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).deleteMedia(account, location, media));
  }

  @Command({
    name: "performance",
    description: "Fetch daily Google Business Profile performance metrics",
    helpAfter: readHelp(
      "ravi gbp performance 456 --metrics BUSINESS_IMPRESSIONS_DESKTOP_MAPS,WEBSITE_CLICKS --start 2026-06-01 --end 2026-06-30",
      "ravi gbp performance locations/456 --metrics CALL_CLICKS --start 2026-06-01 --end 2026-06-30 --json",
    ),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.performance", action: "read", risk: "low" })
  @Returns(wrappedSchema)
  async performance(
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--metrics <csv>", description: "Required DailyMetric values, comma-separated" }) metrics?: string,
    @Option({ flags: "--start <date>", description: "Required start date YYYY-MM-DD", schema: dateSchema })
    start?: string,
    @Option({ flags: "--end <date>", description: "Required end date YYYY-MM-DD", schema: dateSchema }) end?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).performance(
        location,
        csv(required(metrics, "--metrics")),
        required(start, "--start"),
        required(end, "--end"),
      ),
    );
  }

  @Command({
    name: "search-keywords",
    description: "List monthly search keyword impressions for a location",
    helpAfter: readHelp(
      "ravi gbp search-keywords 456 --start-month 2026-01 --end-month 2026-06",
      "ravi gbp search-keywords locations/456 --start-month 2026-01 --end-month 2026-06 --limit 50 --json",
    ),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.performance", action: "keywords", risk: "low" })
  @Returns(wrappedSchema)
  async searchKeywords(
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--start-month <month>", description: "Required first month YYYY-MM", schema: monthSchema })
    start?: string,
    @Option({ flags: "--end-month <month>", description: "Required last month YYYY-MM", schema: monthSchema })
    end?: string,
    @Option({ flags: "--limit <n>", description: "Page size from 1 to 100 (default: 50)" }) limit?: string,
    @Option({ flags: "--cursor <token>" }) cursor?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).searchKeywords(
        location,
        required(start, "--start-month"),
        required(end, "--end-month"),
        integer(limit, 50, 1, 100),
        cursor,
      ),
    );
  }

  @Command({
    name: "categories",
    description: "List official Google Business Profile categories",
    helpAfter: readHelp(
      "ravi gbp categories --filter embalagem",
      "ravi gbp categories --region BR --language pt-BR --json",
    ),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.categories", action: "list", risk: "low" })
  @Returns(wrappedSchema)
  async categories(
    @Option({ flags: "--filter <text>", description: "Display-name filter" }) filter?: string,
    @Option({ flags: "--region <code>", description: "CLDR region code (default: BR)", defaultValue: "BR" })
    region?: string,
    @Option({ flags: "--language <code>", description: "BCP-47 language code (default: pt-BR)", defaultValue: "pt-BR" })
    language?: string,
    @Option({ flags: "--limit <n>", description: "Page size from 1 to 100 (default: 50)" }) limit?: string,
    @Option({ flags: "--cursor <token>" }) cursor?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).listCategories(
        region ?? "BR",
        language ?? "pt-BR",
        filter,
        integer(limit, 50, 1, 100),
        cursor,
      ),
    );
  }

  @Command({
    name: "attributes",
    description: "Get current attributes for a location",
    helpAfter: readHelp("ravi gbp attributes 456", "ravi gbp attributes locations/456 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.attributes", action: "get", risk: "low" })
  @Returns(wrappedSchema)
  async attributes(
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getAttributes(location));
  }

  @Command({
    name: "verifications",
    description: "List verification attempts for a location",
    helpAfter: readHelp("ravi gbp verifications 456", "ravi gbp verifications locations/456 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.verifications", action: "list", risk: "medium" })
  @Returns(wrappedSchema)
  async verifications(
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).listVerifications(location));
  }

  @Command({
    name: "verification-options",
    description: "Fetch available verification methods for a location",
    helpAfter: readHelp(
      "ravi gbp verification-options 456",
      "ravi gbp verification-options locations/456 --language pt-BR --json",
    ),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.verifications", action: "options", risk: "medium" })
  @Returns(wrappedSchema)
  async verificationOptions(
    @Arg("location", { schema: resourceSchema }) location: string,
    @Option({ flags: "--language <code>", defaultValue: "pt-BR" }) language?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).fetchVerificationOptions(location, language ?? "pt-BR"));
  }

  @Command({
    name: "verify",
    description: "Start a location verification using an official method and input payload",
    helpAfter: mutateHelp(
      'ravi gbp verify 456 SMS --payload \'{"phoneNumber":"+551100000000"}\'',
      'ravi gbp verify locations/456 ADDRESS --payload \'{"mailerContact":"Responsavel"}\' --language pt-BR --json',
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.verifications",
    action: "verify",
    risk: "high",
    requiresConfirmation: true,
    input: ["location", "payload", "language"],
    redactions: ["payload"],
  })
  @Returns(wrappedSchema)
  async verify(
    @Arg("location", { schema: resourceSchema }) location: string,
    @Arg("method", {
      description: "Official VerificationMethod value, for example SMS or ADDRESS",
      schema: resourceSchema,
    })
    method: string,
    @Option({ flags: "--payload <json>", description: "Optional method input JSON object" })
    payload?: string,
    @Option({ flags: "--language <code>", defaultValue: "pt-BR" }) language?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).verify(location, method, jsonObject(payload ?? "{}"), language ?? "pt-BR"),
    );
  }

  @Command({
    name: "verification-complete",
    description: "Complete a pending verification with a PIN",
    helpAfter: mutateHelp(
      "ravi gbp verification-complete locations/456/verifications/789 --pin 123456",
      "ravi gbp verification-complete locations/456/verifications/789 --pin 123456 --json",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.verifications",
    action: "complete",
    risk: "high",
    requiresConfirmation: true,
    input: ["verification", "pin"],
    redactions: ["pin"],
  })
  @Returns(wrappedSchema)
  async verificationComplete(
    @Arg("verification", { description: "Full locations/.../verifications/... name", schema: resourceSchema })
    verification: string,
    @Option({ flags: "--pin <pin>", description: "Verification PIN" }) pin?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).completeVerification(verification, required(pin, "--pin")));
  }

  @Command({
    name: "admins",
    description: "List administrators for an account or location",
    helpAfter: readHelp("ravi gbp admins accounts/123", "ravi gbp admins locations/456 --json"),
  })
  @CommandAccess({ kind: "read", resource: "google-business-profile.admins", action: "list", risk: "medium" })
  @Returns(wrappedSchema)
  async admins(
    @Arg("parent", { description: "Full accounts/{id} or locations/{id} resource name", schema: resourceSchema })
    parent: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).listAdmins(parent));
  }

  @Command({
    name: "admin-add",
    description: "Invite an administrator to an account or location",
    helpAfter: mutateHelp(
      "ravi gbp admin-add accounts/123 pessoa@example.com --role MANAGER",
      "ravi gbp admin-add locations/456 pessoa@example.com --role MANAGER --json",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.admins",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
    input: ["parent", "email", "role"],
    redactions: ["email"],
  })
  @Returns(wrappedSchema)
  async adminAdd(
    @Arg("parent", { description: "Full accounts/{id} or locations/{id} resource name", schema: resourceSchema })
    parent: string,
    @Arg("email", { schema: z.string().email() }) email: string,
    @Option({
      flags: "--role <role>",
      description: "Official AdminRole value (default: MANAGER)",
      defaultValue: "MANAGER",
    })
    role?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).createAdmin(parent, email, role ?? "MANAGER"));
  }

  @Command({
    name: "admin-update",
    description: "Update the role of an account or location administrator",
    helpAfter: mutateHelp(
      "ravi gbp admin-update accounts/123/admins/789 --role OWNER",
      "ravi gbp admin-update locations/456/admins/789 --role MANAGER --json",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.admins",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
    input: ["admin", "role"],
  })
  @Returns(wrappedSchema)
  async adminUpdate(
    @Arg("admin", {
      description: "Full accounts/.../admins/... or locations/.../admins/... name",
      schema: resourceSchema,
    })
    admin: string,
    @Option({ flags: "--role <role>", description: "Required official AdminRole value" }) role?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).updateAdmin(admin, required(role, "--role")));
  }

  @Command({
    name: "admin-delete",
    description: "Remove an account or location administrator",
    helpAfter: destructiveHelp(
      "ravi gbp admin-delete accounts/123/admins/789",
      "ravi gbp admin-delete locations/456/admins/789 --json",
    ),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "google-business-profile.admins",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(wrappedSchema)
  async adminDelete(
    @Arg("admin", {
      description: "Full accounts/.../admins/... or locations/.../admins/... name",
      schema: resourceSchema,
    })
    admin: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).deleteAdmin(admin));
  }
}

for (const command of [
  "accounts",
  "accountGet",
  "locations",
  "locationGet",
  "locationUpdate",
  "locationDelete",
  "reviews",
  "reviewGet",
  "reviewReply",
  "reviewReplyDelete",
  "posts",
  "postGet",
  "postCreate",
  "postUpdate",
  "postDelete",
  "media",
  "mediaGet",
  "mediaCreate",
  "mediaUpdate",
  "mediaDelete",
  "performance",
  "searchKeywords",
  "categories",
  "attributes",
  "verifications",
  "verificationOptions",
  "verify",
  "verificationComplete",
  "admins",
  "adminAdd",
  "adminUpdate",
  "adminDelete",
] as const) {
  const method = GoogleBusinessProfileCommands.prototype[command];
  Option({ flags: "--json", description: "Print the stable JSON response envelope" })(
    GoogleBusinessProfileCommands.prototype,
    command,
    method.length,
  );
}

function wrap(result: GbpJson) {
  const payload = { result };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

function required(value: string | undefined, option: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${option} is required.`);
  return normalized;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`Expected integer from ${min} to ${max}.`);
  return parsed;
}

function csv(value: string): string[] {
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.length) throw new Error("--metrics must contain at least one DailyMetric value.");
  return values;
}

function jsonObject(value: string | undefined): GbpJson {
  const input = required(value, "--payload");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("--payload must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("--payload must decode to a JSON object.");
  return parsed as GbpJson;
}

function readHelp(exampleA: string, exampleB: string): string {
  return `
USE
  Read provider state without changing Google Business Profile data.
DO NOT USE
  Do not use as an authentication setup flow; credentials are brokered by Ravi.
EXAMPLES
  ${exampleA}
  ${exampleB}
ON ERROR
  Missing credential -> configure provider google-business-profile in Ravi; invalid input -> correct the named argument.
SOURCES
  Google Business Profile official REST references, verified 2026-07-13.`;
}

function mutateHelp(exampleA: string, exampleB: string): string {
  return `
USE
  Change one explicitly named Google Business Profile resource after reviewing the payload.
DO NOT USE
  Do not batch, infer missing fields, or use this command as a dry run.
HITL REQUIRED
  Obtain confirmation for the exact resource and payload before execution.
EXAMPLES
  ${exampleA}
  ${exampleB}
ON ERROR
  Missing credential -> configure provider google-business-profile; provider rejection -> inspect the official field mask and policy.
SOURCES
  Google Business Profile official REST references, verified 2026-07-13.`;
}

function destructiveHelp(exampleA: string, exampleB: string): string {
  return `
USE
  Permanently remove one explicitly named Google Business Profile resource.
DO NOT USE
  Do not execute without a verified backup/rollback plan and explicit approval.
HITL REQUIRED
  Confirm the full resource name and irreversible effect immediately before execution.
EXAMPLES
  ${exampleA}
  ${exampleB}
ON ERROR
  Missing credential -> configure provider google-business-profile; not found -> re-read the resource before retrying.
SOURCES
  Google Business Profile official REST references, verified 2026-07-13.`;
}
