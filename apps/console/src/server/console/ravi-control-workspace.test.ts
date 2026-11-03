import { describe, expect, test } from "bun:test";

import type { ConsoleWorkspace } from "@/server/console/workspace";
import {
  listRaviControlInstallations,
  type RaviControlWorkspaceRepository,
} from "./ravi-control-workspace";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000001";
const INSTANCE_ID = "30000000-0000-4000-8000-000000000001";

describe("Ravi Control organization workspace", () => {
  test("projects only authorized installations with safe project identity", async () => {
    const result = await listRaviControlInstallations({
      organizationRef: "current",
      repository: repository(),
      workspace: workspace(),
    });

    expect(result.projects).toEqual([
      { id: PROJECT_ID, name: "Core", slug: "core" },
    ]);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      project: { id: PROJECT_ID, slug: "core" },
      instance: { id: INSTANCE_ID, displayName: "Primary" },
    });
  });

  test("does not resolve another organization ref", async () => {
    await expect(
      listRaviControlInstallations({
        organizationRef: "another-org",
        repository: repository(),
        workspace: workspace(),
      }),
    ).rejects.toMatchObject({
      payload: { error: "organization_not_found" },
      status: 404,
    });
  });
});

function workspace(): ConsoleWorkspace {
  return {
    mode: "workos",
    organization: { id: ORG_ID, name: "RBBT", slug: "rbbt" },
    membership: { role: "owner" },
    user: { id: "40000000-0000-4000-8000-000000000001" },
  } as ConsoleWorkspace;
}

function repository(): RaviControlWorkspaceRepository {
  return {
    async listAccessibleProjects() {
      return [
        { id: PROJECT_ID, name: "Core", slug: "core", status: "active" },
        {
          id: "20000000-0000-4000-8000-000000000002",
          name: "Deleted",
          slug: "deleted",
          status: "deleted",
        },
      ];
    },
    async listProjectInstallations({ projectRef }) {
      expect(projectRef).toBe(PROJECT_ID);
      return {
        version: 1,
        items: [
          {
            version: 1,
            instance: {
              id: INSTANCE_ID,
              displayName: "Primary",
              projectId: PROJECT_ID,
              desiredState: "running",
              observedState: "ready",
              provisioningPhase: null,
              failureCode: null,
              runtimeProvider: "codex",
              runtimeModel: "gpt-5",
              runtimeVersion: "0.260716.1",
              placementClass: "shared-small",
              lastHeartbeatAt: null,
              createdAt: "2026-07-17T12:00:00.000Z",
              updatedAt: "2026-07-17T12:00:00.000Z",
            },
            latestOperation: null,
            connections: [],
            backups: [],
          },
        ],
      };
    },
  };
}
