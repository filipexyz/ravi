import { randomUUID } from "node:crypto";
import { BridgeError, type BridgeGrant, type BridgeTeam } from "./protocol.js";
import type { BridgeStore, ConversationRow, Enrollment } from "./store.js";

export function conversationAgentsAllowed(store: BridgeStore, conversation: ConversationRow, grant: BridgeGrant) {
  const required = store
    .team(conversation.id)
    ?.members.flatMap((member) => (member.kind === "agent" ? [member.agentId] : [])) ?? [conversation.agent_id];
  return required.every((id) => grant.agents.some((agent) => agent.id === id));
}

/** A new shared conversation only; there is deliberately no conversion operation. */
export function createTeam(
  store: BridgeStore,
  enrollment: Enrollment,
  grant: BridgeGrant,
  input: { title: string; agentIds: string[]; personIds: string[] },
  runtimeAgents: { id: string }[],
) {
  const agentIds = [...new Set(input.agentIds)],
    personIds = [...new Set([grant.sub, ...input.personIds])];
  if (
    !grant.canSend ||
    !grant.teamParticipants ||
    agentIds.length < 2 ||
    agentIds.length > 6 ||
    personIds.length > 30 ||
    !input.title.trim() ||
    input.title.length > 120 ||
    agentIds.some(
      (id) => !grant.agents.some((agent) => agent.id === id) || !runtimeAgents.some((agent) => agent.id === id),
    ) ||
    personIds.some((id) => !grant.teamParticipants!.some((person) => person.id === id))
  )
    throw new BridgeError("NOT_FOUND_OR_DENIED");
  const id = randomUUID(),
    owner = agentIds[0]!;
  const team: BridgeTeam = {
    ownerAgentId: owner,
    memory: [],
    members: [
      ...agentIds.map((agentId) => ({ kind: "agent" as const, agentId })),
      ...personIds.map((personId) => ({
        kind: "person" as const,
        personId,
        name: grant.teamParticipants!.find((person) => person.id === personId)!.name,
        role: personId === grant.sub ? ("owner" as const) : ("member" as const),
      })),
    ],
  };
  store.db
    .query("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(
      id,
      enrollment.id,
      grant.sub,
      grant.projectId,
      owner,
      `console-${id}`,
      `agent:${owner}:console:${id}`,
      input.title.trim(),
      0,
      Date.now(),
    );
  store.db.query("INSERT INTO teams VALUES (?,?)").run(id, JSON.stringify(team));
  for (const person of personIds)
    store.db
      .query("INSERT INTO team_members VALUES (?,?,?)")
      .run(id, person, person === grant.sub ? "owner" : "member");
  return { conversationId: id, conversation: store.conversationDto(store.conversation(id)!) };
}

/** Resolve mentions from the authorized roster, never from arbitrary runtime ids. */
export function teamRecipients(store: BridgeStore, conversation: ConversationRow, text: string): string[] {
  const team = store.team(conversation.id);
  if (!team) return [conversation.agent_id];
  const agents = team.members.flatMap((member) => (member.kind === "agent" ? [member.agentId] : []));
  const mentions = [...text.matchAll(/(?:^|\s)@([a-zA-Z0-9_-]+)/g)].map((match) => match[1]!.toLowerCase());
  if (mentions.some((mention) => mention === "everyone" || mention === "todos")) return agents;
  const selected = agents.filter((agent) => mentions.includes(agent.toLowerCase()));
  return selected.length ? selected : [team.ownerAgentId];
}
