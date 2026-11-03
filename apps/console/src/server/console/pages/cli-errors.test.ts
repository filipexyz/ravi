import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  PAGE_SITE_SLUG_UNAVAILABLE_CLI_MESSAGE,
  PAGE_SITE_UNAVAILABLE_CLI_MESSAGE,
  pagePublishCliError,
  pageRouteVisibilityCliError,
  pageSiteCliError,
} from "./cli-errors";

describe("Ravi Pages CLI error mapping", () => {
  test("explains unavailable hosted site slugs without leaking rejection details", () => {
    const mapped = pageSiteCliError(new ConsoleApiError(409, { error: "slug_unavailable" }));

    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe("PAYLOAD_INVALID");
    expect(mapped.message).toBe(PAGE_SITE_SLUG_UNAVAILABLE_CLI_MESSAGE);
  });

  test("does not report missing publish sites as project access denial", () => {
    const mapped = pagePublishCliError(new ConsoleApiError(404, { error: "publish_site_unavailable" }));

    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe("PAYLOAD_INVALID");
    expect(mapped.message).toBe(PAGE_SITE_UNAVAILABLE_CLI_MESSAGE);
  });

  test("keeps true publish permission failures as publish-not-allowed", () => {
    const mapped = pagePublishCliError(new ConsoleApiError(403, { error: "publish_forbidden" }));

    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe("PUBLISH_NOT_ALLOWED");
  });

  test("maps unread publish comments to an actionable publish gate", () => {
    const mapped = pagePublishCliError(
      new ConsoleApiError(409, {
        error: "publish_unread_comments",
        fieldErrors: {
          comments: "Read 1 unread Page comment before publishing. Latest: Thiago on /.",
        },
      }),
    );

    expect(mapped.status).toBe(409);
    expect(mapped.code).toBe("PUBLISH_COMMENTS_UNREAD");
    expect(mapped.message).toContain("Read 1 unread Page comment");
  });

  test("maps a missing route visibility target to a safe 404", () => {
    const mapped = pageRouteVisibilityCliError(new ConsoleApiError(404, { error: "route_not_found" }));

    expect(mapped.status).toBe(404);
    expect(mapped.code).toBe("PAYLOAD_INVALID");
    expect(mapped.message).toBe("The requested Pages route is not active.");
  });

  test("maps visibility validation failures without leaking request fields", () => {
    const mapped = pageRouteVisibilityCliError(
      new ConsoleApiError(400, {
        error: "validation_failed",
        fieldErrors: { visibility: "Invalid option: expected one of \"public\"|\"private\"|\"protected_link\"" },
      }),
    );

    expect(mapped.status).toBe(400);
    expect(mapped.code).toBe("PAYLOAD_INVALID");
    expect(mapped.message).not.toContain("password");
  });
});
