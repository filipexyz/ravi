"use client";

import { ApiError } from "@/lib/api/client";
import { findProject, useWorkspace } from "@/features/shell/workspace";
import { ErrorState } from "@/ui/states";

/** The project named by the route, from the projects the server layout resolved. */
export function useRouteProject(projectRef: string) {
  return findProject(useWorkspace().projects, projectRef);
}

const notFound = new ApiError(404, "not_found", "Project not found");

export function ProjectNotFound() {
  return <ErrorState error={notFound} title="This project doesn't exist or you don't have access" />;
}
