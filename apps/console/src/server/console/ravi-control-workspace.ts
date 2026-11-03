import { ConsoleApiError } from "@/server/console/api-error";
import { listAccessibleProjectRecords } from "@/server/console/project-access";
import type { ConsoleWorkspace } from "@/server/console/workspace";
import { listManagedInstances } from "./managed-instances";

type AccessibleProject = {
  id: string;
  name: string;
  slug: string;
  status: string;
};

export type RaviControlWorkspaceRepository = {
  listAccessibleProjects(workspace: ConsoleWorkspace): Promise<AccessibleProject[]>;
  listProjectInstallations(input: {
    projectRef: string;
    workspace: ConsoleWorkspace;
  }): Promise<Awaited<ReturnType<typeof listManagedInstances>>>;
};

export async function listRaviControlInstallations(input: {
  organizationRef: string;
  repository?: RaviControlWorkspaceRepository;
  workspace: ConsoleWorkspace;
}) {
  if (
    input.organizationRef !== input.workspace.organization.id &&
    input.organizationRef !== input.workspace.organization.slug &&
    input.organizationRef !== "current"
  ) {
    throw new ConsoleApiError(404, { error: "organization_not_found" });
  }
  const repository = input.repository ?? raviControlWorkspaceRepositoryForDb();
  const projects = (await repository.listAccessibleProjects(input.workspace)).filter(
    (project) => project.status !== "deleted",
  );
  const installations = await Promise.all(
    projects.map(async (project) => ({
      project,
      result: await repository.listProjectInstallations({
        projectRef: project.id,
        workspace: input.workspace,
      }),
    })),
  );
  return {
    version: 1 as const,
    organization: {
      id: input.workspace.organization.id,
      name: input.workspace.organization.name,
      slug: input.workspace.organization.slug,
    },
    projects: projects.map(publicProject),
    items: installations.flatMap(({ project, result }) =>
      result.items.map((item) => ({
        ...item,
        project: publicProject(project),
      })),
    ),
  };
}

export function raviControlWorkspaceRepositoryForDb(): RaviControlWorkspaceRepository {
  return {
    async listAccessibleProjects(workspace) {
      return listAccessibleProjectRecords(workspace);
    },
    async listProjectInstallations(input) {
      return listManagedInstances(input);
    },
  };
}

function publicProject(project: AccessibleProject) {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
  };
}
