import { describe, expect, test } from "bun:test";
import { authorizationActorFromWorkspace } from "./project-access";
import { evaluatePolicy } from "./authorization/engine";

describe("canonical project authorization boundary", () => {
  test("workspace projection retains verified delegation, not role claims", () => {
    const authorization = { installationId: "installation", sessionId: "session", bindingId: "binding", accessTokenJti: "jti" };
    expect(authorizationActorFromWorkspace({ user: { id: "user" }, organization: { id: "org" }, membership: { role: "owner" }, authorization }))
      .toEqual({ userId: "user", organizationId: "org", delegation: authorization });
  });
  test("no role can authorize without an active policy", async () => {
    for (const organizationRole of ["owner", "admin", "developer", "viewer", "billing"]) {
      expect((await evaluatePolicy(null, { organizationId: "org", projectOrganizationId: "org", projectId: "project",
        userId: "user", active: true, organizationRole, projectRole: "project_admin" }, "project.read")).allowed).toBe(false);
    }
  });
});
