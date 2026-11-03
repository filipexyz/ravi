import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  assertViewerAssertionOriginsForSite,
  normalizeViewerAssertionAudience,
  normalizeViewerAssertionOrigin,
} from "./audience";

describe("viewer assertion audience rules", () => {
  test("accepts an exact audience and site origins", () => {
    expect(normalizeViewerAssertionAudience(" https://api.customer.example ")).toBe("https://api.customer.example");
    expect(
      assertViewerAssertionOriginsForSite(
        ["https://demo.ravi.page/", "https://app.customer.example"],
        ["demo.ravi.page", "app.customer.example"],
      ),
    ).toEqual(["https://demo.ravi.page", "https://app.customer.example"]);
  });

  test("rejects wildcard audiences and origins that are not bound to the site", () => {
    expect(() => normalizeViewerAssertionAudience("https://api.customer.example/*")).toThrow(ConsoleApiError);
    expect(() => normalizeViewerAssertionAudience("*")).toThrow(ConsoleApiError);
    expect(() => normalizeViewerAssertionOrigin("http://demo.ravi.page")).toThrow(ConsoleApiError);
    expect(() => normalizeViewerAssertionOrigin("https://*.ravi.page")).toThrow(ConsoleApiError);
    expect(() => assertViewerAssertionOriginsForSite(["https://evil.example"], ["demo.ravi.page"])).toThrow(
      ConsoleApiError,
    );
  });
});
