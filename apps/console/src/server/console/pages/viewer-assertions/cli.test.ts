import { describe, expect, test } from "bun:test";

import { ConsoleApiError } from "@/server/console/api-error";
import { resolveViewerAssertionCliSite } from "./cli";

describe("viewer assertion CLI site resolution", () => {
  test("uses the Pages site ref when it already resolves in the project", async () => {
    let hostLookups = 0;
    const site = await resolveViewerAssertionCliSite({
      action: "read",
      projectRef: "demo-project",
      siteRef: "demo",
      workspace: workspace(),
    }, {
      findSiteByHost: async () => {
        hostLookups += 1;
        return null;
      },
      getSiteForProject: async (input) => {
        expect(input.action).toBe("read");
        expect(input.siteRef).toBe("demo");
        return pageSite();
      },
    });

    expect(hostLookups).toBe(0);
    expect(site).toMatchObject({ defaultHostname: "demo.ravi.page", id: "site_1", status: "active" });
  });

  test("resolves --site host when the value is not a site slug", async () => {
    const site = await resolveViewerAssertionCliSite({
      action: "write",
      projectRef: "demo-project",
      siteRef: "app.customer.example",
      workspace: workspace(),
    }, {
      findProject: async () => ({ id: "proj_1", organizationId: "org_site" }) as never,
      findSiteByHost: async (input) => {
        expect(input).toEqual({
          host: "app.customer.example",
          organizationId: "org_site",
          projectId: "proj_1",
        });
        return pageSite({ defaultHostname: "demo.ravi.page" });
      },
      getSiteForProject: async () => {
        throw new ConsoleApiError(404, { error: "site_not_found" });
      },
    });

    expect(site.id).toBe("site_1");
  });

  test("does not fall through to a host lookup for an inactive site ref", async () => {
    let hostLookups = 0;
    await expect(resolveViewerAssertionCliSite({
      action: "write",
      projectRef: "demo-project",
      siteRef: "demo",
      workspace: workspace(),
    }, {
      findSiteByHost: async () => {
        hostLookups += 1;
        return pageSite();
      },
      getSiteForProject: async () => pageSite({ status: "disabled" }),
    })).rejects.toMatchObject({ payload: { error: "site_not_found" } });
    expect(hostLookups).toBe(0);
  });

  test("does not query hosts for a missing slug", async () => {
    let hostLookups = 0;
    await expect(resolveViewerAssertionCliSite({
      action: "read",
      projectRef: "demo-project",
      siteRef: "missing",
      workspace: workspace(),
    }, {
      findSiteByHost: async () => {
        hostLookups += 1;
        return null;
      },
      getSiteForProject: async () => {
        throw new ConsoleApiError(404, { error: "site_not_found" });
      },
    })).rejects.toMatchObject({ payload: { error: "site_not_found" } });
    expect(hostLookups).toBe(0);
  });
});

function workspace() {
  return {
    membership: { role: "developer" as const },
    mode: "workos" as const,
    organization: { id: "org_site" },
    user: { id: "user_1" },
  };
}

function pageSite(overrides: { defaultHostname?: string; status?: string } = {}) {
  return {
    defaultHostname: overrides.defaultHostname ?? "demo.ravi.page",
    id: "site_1",
    organizationId: "org_site",
    projectId: "proj_1",
    status: overrides.status ?? "active",
  } as never;
}
