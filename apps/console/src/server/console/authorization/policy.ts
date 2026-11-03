import { createHash } from "node:crypto";
import { z } from "zod";
import { PROJECT_ACTIONS, ORGANIZATION_ACTIONS } from "@/shared/project-authorization";
export { PROJECT_ACTIONS, ORGANIZATION_ACTIONS } from "@/shared/project-authorization";
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];
export type OrganizationAction = (typeof ORGANIZATION_ACTIONS)[number];
const uuid = z.uuid();
const name = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const projectIds = z.array(z.union([uuid, z.literal("*")])).min(1).max(200);
const humanPrincipals = [
  z.object({ kind: z.literal("user"), id: uuid }).strict(),
  z.object({ kind: z.literal("group"), id: name }).strict(),
  z.object({ kind: z.literal("role"), id: uuid }).strict(),
] as const;
export const principalSchema = z.discriminatedUnion("kind", [
  ...humanPrincipals,
  z.object({ kind: z.literal("service"), id: uuid }).strict(),
  z.object({ kind: z.literal("installation"), id: uuid }).strict(),
  z.object({ kind: z.literal("agent"), installationId: uuid, id: name }).strict(),
]);
export type Principal = z.infer<typeof principalSchema>;
export type HumanPrincipal = Extract<Principal, { kind: "user" | "group" | "role" }>;
// Literal decisions only: wildcard executable/tool grants cannot express safe multi-human isolation.
// The hook endpoint is the single protocol capability with a wildcard resource ID.
export const bridgeCapabilitySchema = z.object({permission:name,objectType:name,objectId:z.string().min(1).max(300)})
  .strict().refine(c => !/[?*]/.test(c.objectId) || (c.permission === "mutate" && c.objectType === "context.bridge-tool-hook" && c.objectId === "*"), "Bridge grants require concrete resources");
const bridgeScope = {installationId:uuid, projectId:uuid};
const ruleBase = { id: name, effect: z.enum(["allow", "deny"]), principals: z.array(principalSchema).min(1).max(40) };
const policyObject = z.object({
  format: z.literal(1), organizationId: uuid,
  // UI shorthand for explicit org authorization.read/manage grants, compiled by
  // the SAME engine. It grants no project data or other organization action.
  administrators: z.array(z.discriminatedUnion("kind", humanPrincipals)).min(1).max(50),
  groups: z.array(z.object({ id: name, members: z.array(uuid).max(1000) }).strict()).max(100),
  roles: z.array(z.object({ id: uuid, name: z.string().trim().min(1).max(80),
    members: z.array(uuid).max(1000), groups: z.array(name).max(100),
    scope: z.discriminatedUnion("kind", [z.object({ kind: z.literal("organization") }).strict(),
      z.object({ kind: z.literal("project"), projects: projectIds }).strict()]),
  }).strict()).max(100).default([]),
  organizationRules: z.array(z.object({ ...ruleBase,
    actions: z.array(z.enum(ORGANIZATION_ACTIONS)).min(1).max(ORGANIZATION_ACTIONS.length),
  }).strict()).max(300).default([]),
  bridgeAgents: z.array(z.object({...bridgeScope, agentIds:z.array(name).min(1).max(100)}).strict()).max(100).optional(),
  bridgeRules: z.array(z.object({id:name,...bridgeScope,agentId:name,
    principals:z.array(z.discriminatedUnion("kind",humanPrincipals)).min(1).max(40),
    effect:z.enum(["allow","approval","deny"]),capabilities:z.array(bridgeCapabilitySchema).min(1).max(100),
  }).strict()).max(300).optional(),
  rules: z.array(z.object({ ...ruleBase, projects: projectIds,
    actions: z.array(z.enum(PROJECT_ACTIONS)).min(1).max(PROJECT_ACTIONS.length),
  }).strict()).max(300),
}).strict();
export const policySchema = policyObject.superRefine((policy, ctx) => {
  const unique = (values: string[], path: (string | number)[]) => {
    if (new Set(values).size !== values.length) ctx.addIssue({ code: "custom", path, message: "Duplicate entry" });
  };
  const projects = (ids: string[], path: (string | number)[]) => {
    unique(ids, path);
    if (ids.includes("*") && ids.length > 1) ctx.addIssue({ code: "custom", path, message: "All projects cannot be combined with IDs" });
  };
  unique(policy.groups.map(g => g.id), ["groups"]);
  unique(policy.roles.map(r => r.id), ["roles"]);
  unique([...policy.rules, ...policy.organizationRules, ...(policy.bridgeRules ?? [])].map(r => r.id), ["rules"]);
  unique(policy.administrators.map(principalKey), ["administrators"]);
  const groups = new Set(policy.groups.map(g => g.id)), roles = new Map(policy.roles.map(r => [r.id, r]));
  const checkGroup = (id: string) => { if (!groups.has(id)) ctx.addIssue({ code: "custom", message: "Unknown policy group" }); };
  policy.groups.forEach((group, i) => unique(group.members, ["groups", i, "members"]));
  policy.roles.forEach((role, i) => {
    unique(role.members, ["roles", i, "members"]); unique(role.groups, ["roles", i, "groups"]);
    role.groups.forEach(checkGroup);
    if (role.scope.kind === "project") projects(role.scope.projects, ["roles", i, "scope", "projects"]);
  });
  unique((policy.bridgeAgents ?? []).map(b => `${b.installationId}:${b.projectId}`), ["bridgeAgents"]);
  for (const scope of policy.bridgeAgents ?? []) unique(scope.agentIds, ["bridgeAgents"]);
  for (const rule of policy.bridgeRules ?? []) {
    if (!(policy.bridgeAgents ?? []).some(b => b.installationId === rule.installationId && b.projectId === rule.projectId && b.agentIds.includes(rule.agentId)))
      ctx.addIssue({code:"custom",message:"Unknown bridge agent assignment"});
  }
  let expanded = policy.administrators.length * 2 + (policy.bridgeRules ?? []).reduce((n,r)=>n+r.principals.length*r.capabilities.length*2,0);
  for (const [i, rule] of [...policy.rules, ...policy.organizationRules].entries()) {
    unique(rule.principals.map(principalKey), ["rules", i, "principals"]); unique(rule.actions, ["rules", i, "actions"]);
    if ("projects" in rule) projects(rule.projects, ["rules", i, "projects"]);
    expanded += rule.principals.length * ("projects" in rule ? rule.projects.length : 1) * rule.actions.length;
  }
  if (expanded > 10000) ctx.addIssue({ code: "custom", path: ["rules"], message: "Policy expansion exceeds limit" });
  for (const principal of [...policy.administrators, ...policy.rules.flatMap(r => r.principals), ...policy.organizationRules.flatMap(r => r.principals), ...(policy.bridgeRules ?? []).flatMap(r => r.principals)]) {
    if (principal.kind === "group") checkGroup(principal.id);
    if (principal.kind === "role" && !roles.has(principal.id)) ctx.addIssue({ code: "custom", message: "Unknown policy role" });
  }
  for (const principal of policy.administrators) if (principal.kind === "role" && roles.get(principal.id)?.scope.kind !== "organization") {
    ctx.addIssue({ code: "custom", message: "Policy administration requires organization-scoped role" });
  }
});
// Membership role names are deliberately not accepted as policy principals.
export type ProjectPolicy = z.input<typeof policyObject>;
export type ParsedPolicy = z.output<typeof policyObject>;
export function principalKey(principal: Principal): string {
  return principal.kind === "agent" ? "agent:" + principal.installationId + ":" + principal.id : principal.kind + ":" + principal.id;
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])).join(",") + "}";
}
export function policyDigest(policy: ProjectPolicy) {
  return createHash("sha256").update(canonicalJson(policySchema.parse(policy))).digest("hex");
}
/** No automatic role-name or project grants, including for the first human. */
export function initialPolicy(organizationId: string, userId: string): ParsedPolicy {
  return policySchema.parse({ format: 1, organizationId, administrators: [{ kind: "user", id: userId }], groups: [], rules: [] });
}
