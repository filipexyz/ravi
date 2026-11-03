import { dbClient } from "@/server/db";
import { getOidcBaseConfig, getOidcOrigin } from "@/lib/auth/oidc-config";
import { compilePolicy } from "../authorization/engine";
import { policyDigest, policySchema, type ProjectAction } from "../authorization/policy";
import { assertFleetActor, FleetError, type FleetActor } from "./contract";
import { currentBrowserSession } from "./authorization";
import { transactionView } from "./postgres-store";
import { bridgeBindings } from "./bridge-config";

export async function gatewayAuthority(
  actor: FleetActor,
  installationId: string,
  projectId: string,
  action: "read" | "send" | "approve" | "configure" | "team-create" | "directory" | "installation-read" | "installation-manage",
  requestId?: string,
  recordAllowed = false,
  team?: { agentIds:string[]; personIds:string[] },
) {
  let revisionId: string | null = null,
    generation = 0;
  const audit = async (allowed: boolean, reason: string) => {
    if (!requestId || (allowed && (!recordAllowed || action === "read"))) return;
    const policyAction =
      action === "configure" ? "runtime.sessions.configure" : action === "team-create" ? "project.write" : action === "directory" ? "organization.members.read" : action.startsWith("installation-") ? `organization.installations.${action.slice(13)}` : `bridge.conversations.${action}`;
    await dbClient`insert into authorization_audit(organization_id,actor_id,action,project_id,revision_id,generation,request_id,metadata)
      select ${actor.organizationId},${actor.userId},${policyAction},${projectId},${revisionId},${generation},${requestId},
      ${JSON.stringify({ installationId, allowed, reason })}::jsonb
      from users u, organizations o where u.id=${actor.userId} and o.id=${actor.organizationId}`;
  };
  try {
    assertFleetActor(actor, getOidcBaseConfig().organizationId);
    if (!actor.sessionId) throw new FleetError("auth_required", 401);
    const binding = (await bridgeBindings()).find(
      (b) => b.active && b.organizationId === actor.organizationId && b.installationId === installationId,
    );
    if (!binding || binding.issuer !== getOidcOrigin()) throw new FleetError("bridge_access_denied", 403);
    const value = await dbClient.begin(async (tx) => {
      await currentBrowserSession(tx, actor);
      const [member] =
        await tx`select m.role from organization_memberships m join users u on u.id=m.user_id join organizations o on o.id=m.organization_id
      where m.organization_id=${actor.organizationId} and m.user_id=${actor.userId} and m.status='active' and u.status='active' and o.status='active' for share of m,u,o`;
      const [project] =
        await tx`select id,name,organization_id from projects where id=${projectId} and organization_id=${actor.organizationId} for share`;
      const [head] =
        await tx`select active_revision_id,generation from authorization_policy_heads where organization_id=${actor.organizationId} for share`;
      revisionId = head?.active_revision_id ?? null;
      generation = Number(head?.generation ?? 0);
      if (!member || !project || !head?.active_revision_id) throw new FleetError("bridge_access_denied", 403);
      const [revision] =
        await tx`select document,digest from authorization_policy_revisions where id=${head.active_revision_id} and organization_id=${actor.organizationId}`;
      const parsed = policySchema.safeParse(revision?.document);
      if (!parsed.success || policyDigest(parsed.data) !== revision?.digest)
        throw new FleetError("authorization_revision_invalid", 503);
      const engine = await compilePolicy(parsed.data);
      const facts = {
        organizationId: actor.organizationId,
        projectOrganizationId: project.organization_id,
        projectId,
        userId: actor.userId,
        active: true,
        organizationRole: member.role,
        projectRole: null,
      };
      const can = async (action: ProjectAction) => (await engine.decide(facts, action)).allowed;
      const canOrganization = async (action: "organization.members.read" | "organization.installations.read" | "organization.installations.manage") => (await engine.decideOrganization(facts,action)).allowed;
      const agents = await engine.bridgeDelegation(facts, installationId);
      if (!agents.length) throw new FleetError("bridge_access_denied", 403);
      if (action === "configure" && !(await can("runtime.sessions.configure")))
        throw new FleetError("gateway_access_denied", 403);
      const canSend = await can("bridge.conversations.send"),
        canApprove = await can("bridge.conversations.approve");
      if (action === "team-create" && (!canSend || !(await can("project.write")))) throw new FleetError("gateway_access_denied",403);
      if (action.startsWith("installation-") && !(await canOrganization(action === "installation-read" ? "organization.installations.read" : "organization.installations.manage"))) throw new FleetError("gateway_access_denied",403);
      if (
        !(await can("bridge.conversations.read")) ||
        (action === "send" && !canSend) ||
        (action === "approve" && !canApprove)
      )
        throw new FleetError("bridge_access_denied", 403);
      const people: { id:string; name:string; email:string; agentIds:string[] }[] = [];
      if (action === "directory" || action === "team-create") {
        const directory = await canOrganization("organization.members.read");
        if (action === "team-create" && (!team || team.agentIds.some((id)=>!agents.some((agent)=>agent.id === id)))) throw new FleetError("gateway_access_denied",403);
        const members = await tx`select u.id,u.display_name,u.primary_email as email,m.role from organization_memberships m join users u on u.id=m.user_id
          where m.organization_id=${actor.organizationId} and m.status='active' and u.status='active' order by u.id limit 1000 for share of m,u`;
        for (const person of members) {
          if (!directory && person.id !== actor.userId) continue;
          if (team && person.id !== actor.userId && !team.personIds.includes(String(person.id))) continue;
          const personFacts = {...facts,userId:String(person.id),organizationRole:String(person.role)};
          if (!(await engine.decide(personFacts,"bridge.conversations.read")).allowed) continue;
          const delegation = await engine.bridgeDelegation(personFacts,installationId);
          if (!delegation.length || (team && !team.agentIds.every((id)=>delegation.some((agent)=>agent.id === id)))) continue;
          people.push({id:String(person.id),name:String(person.display_name ?? person.email),email:String(person.email),agentIds:delegation.map((agent)=>agent.id)});
        }
        if (team && [actor.userId,...team.personIds].some((id)=>!people.some((person)=>person.id === id))) throw new FleetError("team_member_unavailable",403);
      }
      const view = transactionView(tx, actor),
        installation = await view.installation(installationId);
      if (!installation || installation.revision !== binding.installationRevision)
        throw new FleetError("bridge_enrollment_stale", 409);
      const credential = await view.credential(installation.credentialId);
      if (
        !credential ||
        credential.status !== "active" ||
        credential.kind !== "ssh_private_key" ||
        credential.revision !== binding.credentialRevision
      )
        throw new FleetError("bridge_enrollment_stale", 409);
      return {
        binding,
        agents,
        installation,
        credential,
        canSend,
        canApprove,
        policyRevision: Number(head.generation),
        policyDigest: revision.digest,
        projectName: String(project.name),
        people,
        teamParticipants: team ? people.map(({id,name})=>({id,name})) : undefined,
      };
    });
    await audit(true, "authorized");
    return value;
  } catch (error) {
    // The failed decision has no effect transaction to commit. Record its safe
    // identity/operation metadata separately so denial survives rollback.
    if (error instanceof FleetError) await audit(false, error.code);
    throw error;
  }
}

export async function gatewayOptions(actor: FleetActor) {
  const result = [];
  for (const binding of await bridgeBindings()) {
    if (!binding.active || binding.organizationId !== actor.organizationId) continue;
    for (const project of await dbClient`select id from projects where organization_id=${actor.organizationId} order by id limit 100`) {
      try {
        const state = await gatewayAuthority(actor, binding.installationId, String(project.id), "read");
        result.push({
          installationId: binding.installationId,
          projectId: String(project.id),
          installationName: state.installation.label,
          projectName: state.projectName,
          agentIds: state.agents.map((a) => a.id),
          canSend: state.canSend,
          canApprove: state.canApprove,
        });
      } catch (error) {
        if (error instanceof FleetError && error.status === 403) continue;
        throw error;
      }
    }
  }
  return { subject: actor.userId, options: result };
}
