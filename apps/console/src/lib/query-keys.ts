export const queryKeys = {
  organization: (organizationId: string) => ["organization", organizationId] as const,
  projects: (organizationId: string) => ["organization", organizationId, "projects"] as const,
  project: (organizationId: string, projectId: string) => ["organization", organizationId, "project", projectId] as const,
  artifacts: (organizationId: string, projectId: string) =>
    ["organization", organizationId, "project", projectId, "artifacts"] as const,
  events: (organizationId: string, projectId?: string) =>
    projectId
      ? (["organization", organizationId, "project", projectId, "events"] as const)
      : (["organization", organizationId, "events"] as const),
};

/**
 * Every cached response is scoped to the selected organization, so switching
 * organizations can never show another tenant's data (tanstack SPEC).
 */
export function orgScopedKey(organizationId: string, ...parts: unknown[]) {
  return ["organization", organizationId, ...parts] as const;
}
