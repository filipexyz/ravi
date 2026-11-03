export const PROJECT_ACTIONS = ["project.read", "project.write", "project.admin", "bases.view.write", "bridge.conversations.read", "bridge.conversations.send", "bridge.conversations.approve", "runtime.sessions.configure"] as const;
/** Typed control-plane actions. Stored secrets are never returned. API-key
 * issuance may return a newly generated token once, outside metadata reads. */
export const ORGANIZATION_ACTIONS = [
  "organization.settings.read", "organization.settings.manage",
  "organization.onboarding.read", "organization.onboarding.manage",
  "organization.sso.read", "organization.sso.manage",
  "organization.credentials.read", "organization.credentials.manage",
  "organization.installations.read", "organization.installations.manage",
  "organization.authorization.read", "organization.authorization.manage",
  "organization.projects.create",
  "organization.members.read", "organization.members.manage",
  "organization.api_keys.read", "organization.api_keys.manage",
] as const;
export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];
export const ORGANIZATION_ACTION_LABELS: Record<OrganizationAction, string> = {
  "organization.settings.read": "View organization settings", "organization.settings.manage": "Change organization settings",
  "organization.onboarding.read": "View setup guide", "organization.onboarding.manage": "Complete setup guide",
  "organization.sso.read": "View SSO configuration", "organization.sso.manage": "Change SSO configuration",
  "organization.credentials.read": "View credential metadata", "organization.credentials.manage": "Manage credentials (never reveal values)",
  "organization.installations.read": "View installation configuration", "organization.installations.manage": "Manage installations",
  "organization.authorization.read": "View access policies", "organization.authorization.manage": "Manage access policies",
  "organization.projects.create": "Create projects (separate data grants required)",
  "organization.members.read": "View member directory",
  "organization.members.manage": "Manage membership (not access roles)",
  "organization.api_keys.read": "View API key ownership and service identities",
  "organization.api_keys.manage": "Issue, classify and revoke API keys (no implicit grants)",
};
export type AuthorizationResource = { kind: "organization"; id: string } | { kind: "project"; id: string };
export const PROJECT_ACTION_LABELS = {
  "runtime.sessions.configure": "Change session model, thinking and display name",
  "bridge.conversations.read": "Read your private Ravi conversations",
  "bridge.conversations.send": "Start and cancel your Ravi turns",
  "bridge.conversations.approve": "Decide eligible actions in your Ravi turns",
  "project.read": "Read project resources",
  "project.write": "Change resources and manage Bases",
  "project.admin": "Administer project settings",
  "bases.view.write": "Write through permitted Base views only",
} as const;
