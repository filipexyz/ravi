import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  createViewerAssertionAudienceForSite,
  type ViewerAssertionRegistryRepository,
} from "./registry";

describe("viewer assertion audience registry", () => {
  test("stores the site organization and only hostnames bound to that site", async () => {
    const writes: unknown[] = [];
    const repository = fakeRepository(writes);
    const record = await createViewerAssertionAudienceForSite({
      body: {
        audience: "https://api.customer.example",
        origins: ["https://demo.ravi.page", "https://app.customer.example"],
      },
      repository,
      requestId: "req_1",
      site: {
        defaultHostname: "demo.ravi.page",
        id: "site_1",
        organizationId: "org_site",
        projectId: "proj_1",
        status: "active",
      },
      userId: "user_1",
    });

    expect(record.organizationId).toBe("org_site");
    expect(writes).toEqual([
      {
        audience: "https://api.customer.example",
        createdByUserId: "user_1",
        organizationId: "org_site",
        origins: ["https://demo.ravi.page", "https://app.customer.example"],
        projectId: "proj_1",
        siteId: "site_1",
      },
    ]);
  });

  test("rejects an origin that is not the site hostname", async () => {
    await expect(
      createViewerAssertionAudienceForSite({
        body: { audience: "api", origins: ["https://evil.example"] },
        repository: fakeRepository(),
        requestId: "req_2",
        site: {
          defaultHostname: "demo.ravi.page",
          id: "site_1",
          organizationId: "org_site",
          projectId: "proj_1",
          status: "active",
        },
        userId: "user_1",
      }),
    ).rejects.toBeInstanceOf(ConsoleApiError);
  });
});

function fakeRepository(writes: unknown[] = []): ViewerAssertionRegistryRepository {
  return {
    async deleteAudience() {
      return null;
    },
    async findActiveAudience() {
      return null;
    },
    async insertAudit() {},
    async listAudiences() {
      return [];
    },
    async listSiteHostnames(site) {
      return [site.defaultHostname, "app.customer.example"];
    },
    async upsertAudience(input) {
      writes.push(input);
      return {
        ...input,
        id: "aud_1",
        status: "active",
        updatedAt: new Date("2026-09-29T00:00:00.000Z"),
      };
    },
  };
}
