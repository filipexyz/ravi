import type { ORGANIZATION_ACTIONS } from "./project-authorization";

export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];
/** UI observations only; the backend re-evaluates the current policy per effect. */
export type OrganizationAccess = {
  actions: Record<OrganizationAction, boolean>;
  generation: number;
  revisionId: string | null;
};
