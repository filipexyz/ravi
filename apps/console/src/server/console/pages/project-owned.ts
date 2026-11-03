export function projectOwnedPagesSlug(input: { organizationSlug: string; projectSlug: string }) {
  return `${input.organizationSlug}-${input.projectSlug}`;
}
