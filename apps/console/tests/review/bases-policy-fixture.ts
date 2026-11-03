import { randomUUID } from "node:crypto";
import { db, dbClient, schema } from "../../src/server/db";
import { createAuthorizationStore } from "../../src/server/console/authorization/store";
import { fixturePolicy, installFixturePolicy } from "../fleet/authorization-fixture";
import type { ProjectPolicy } from "../../src/server/console/authorization/policy";

/** Synthetic admission only. Establish an explicit test policy administrator,
 * then use production draft/preview/publish for every data grant/revocation.
 * Nothing is inferred from org/project role names; never used by runtime code. */
export async function basesPolicyFixture(organizationId: string, adminId: string, scopes: Array<{
  projectId: string; managers: string[]; readers?: string[]; viewWriters?: string[]; installations?: string[];
}>) {
  const document = fixturePolicy(organizationId, adminId);
  await installFixturePolicy(dbClient, adminId, document);
  const store = createAuthorizationStore(db);
  const actor = { organizationId, userId: adminId };
  for (const [i, scope] of scopes.entries()) {
    const rules: ProjectPolicy["rules"] = [];
    const add = (name: string, ids: string[], actions: ProjectPolicy["rules"][number]["actions"], kind: "user" | "installation" = "user") => {
      if (ids.length) rules.push({ id: `${name}-${i}`, effect: "allow", principals: [...new Set(ids)].map(id => ({ kind, id })), projects: [scope.projectId], actions });
    };
    add("managers", scope.managers, ["project.read", "project.write"]);
    add("readers", [...scope.readers ?? [], ...scope.viewWriters ?? []], ["project.read"]);
    add("view-writers", scope.viewWriters ?? [], ["bases.view.write"]);
    add("installations", scope.installations ?? [], ["project.read", "project.write", "bases.view.write"], "installation");
    document.rules.push(...rules);
  }
  const publish = async () => {
    const current = await store.read(actor);
    const draft = await store.saveDraft(actor, { expectedGeneration: current.generation, operationKey: randomUUID(), reason: "Explicit Base fixture policy", document });
    const preview = await store.preview(actor, { expectedGeneration: draft.generation });
    await store.publish(actor, { expectedGeneration: draft.generation, operationKey: randomUUID(), reason: "Reviewed Base fixture policy", previewId: preview.id });
  };
  await publish();
  return { document, publish };
}

export async function basesCliFixture(organizationId: string, installationId: string, users: string[]) {
  const sessions = new Map<string, { cliSession: { id: string }; accessTokenJti: string }>();
  for (const userId of users) {
    const id = randomUUID(), accessTokenJti = randomUUID();
    await db.insert(schema.cliSessions).values({ id, localInstallationId: installationId, organizationId, userId,
      subjectType: "user", refreshTokenHash: randomUUID(), accessTokenJti, expiresAt: new Date(Date.now() + 3600000) });
    sessions.set(userId, { cliSession: { id }, accessTokenJti });
  }
  return (userId: string) => {
    const session = sessions.get(userId);
    if (!session) throw new Error("Missing explicit CLI fixture session");
    return session;
  };
}
