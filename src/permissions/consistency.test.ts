import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { canWithCapabilities, type CapabilityContextLike } from "./capability-context.js";
// Cross-evaluator agreement guards against drift between the live recursive
// engine, the pre-expanded snapshot matcher, the delegated materializer, and
// the explain reporter.
import { materializeDelegatedAuthority, snapshotSubjectCapabilities } from "./delegation.js";
import { can, canWithCapabilityContext } from "./engine.js";
import { explainPermissionDecision } from "./explain.js";
import { grantRelation } from "./relations.js";

let stateDir: string | null = null;

interface Request {
  relation: string;
  objectType: string;
  objectId: string;
}

interface Tuple {
  relation: string;
  objectType: string;
  objectId: string;
}

/**
 * Each scenario seeds direct grants + role grants on `agent:subject` (no
 * `constrain`, which is a surface-only mechanism and intentionally differs
 * between the live engine and a subject snapshot), then asserts that the live
 * recursive engine (`can`) and the pre-expanded snapshot matcher agree on every
 * probe. These are two independent implementations of subject authority, so a
 * divergence here is a real consistency regression.
 */
const SUBJECT_SCENARIOS: Array<{
  name: string;
  grants: Array<{ subjectType: string; subjectId: string } & Tuple>;
  probes: Request[];
}> = [
  {
    name: "exact + wildcard + pattern",
    grants: [
      { subjectType: "agent", subjectId: "s", relation: "use", objectType: "tool", objectId: "Bash" },
      { subjectType: "agent", subjectId: "s", relation: "execute", objectType: "group", objectId: "*" },
      { subjectType: "agent", subjectId: "s", relation: "access", objectType: "session", objectId: "dev-*" },
    ],
    probes: [
      { relation: "use", objectType: "tool", objectId: "Bash" },
      { relation: "use", objectType: "tool", objectId: "Read" },
      { relation: "execute", objectType: "group", objectId: "sessions_info" },
      { relation: "access", objectType: "session", objectId: "dev-1" },
      { relation: "access", objectType: "session", objectId: "prod-1" },
    ],
  },
  {
    name: "tool-group membership",
    grants: [{ subjectType: "agent", subjectId: "s", relation: "use", objectType: "toolgroup", objectId: "read-only" }],
    probes: [
      { relation: "use", objectType: "tool", objectId: "Read" },
      { relation: "use", objectType: "tool", objectId: "Bash" },
    ],
  },
  {
    name: "nested role membership",
    grants: [
      { subjectType: "agent", subjectId: "s", relation: "member", objectType: "role", objectId: "trusted" },
      { subjectType: "role", subjectId: "trusted", relation: "member", objectType: "role", objectId: "base" },
      { subjectType: "role", subjectId: "base", relation: "execute", objectType: "group", objectId: "sessions_info" },
    ],
    probes: [
      { relation: "execute", objectType: "group", objectId: "sessions_info" },
      { relation: "execute", objectType: "group", objectId: "whatsapp_group_create" },
    ],
  },
  {
    name: "superadmin short-circuit",
    grants: [{ subjectType: "agent", subjectId: "s", relation: "admin", objectType: "system", objectId: "*" }],
    probes: [
      { relation: "use", objectType: "tool", objectId: "Bash" },
      { relation: "execute", objectType: "group", objectId: "anything" },
    ],
  },
  {
    name: "no grants (fail closed)",
    grants: [],
    probes: [
      { relation: "use", objectType: "tool", objectId: "Bash" },
      { relation: "execute", objectType: "group", objectId: "sessions_info" },
    ],
  },
];

describe("evaluator consistency (G2)", () => {
  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-consistency-test-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  describe("live engine vs pre-expanded snapshot agree on subject authority", () => {
    for (const scenario of SUBJECT_SCENARIOS) {
      it(scenario.name, () => {
        for (const g of scenario.grants) {
          grantRelation(g.subjectType, g.subjectId, g.relation, g.objectType, g.objectId, "manual", {
            permanent: true,
          });
        }
        const snapshot = snapshotSubjectCapabilities("agent", "s", { includeConstraints: false });
        for (const probe of scenario.probes) {
          const live = can("agent", "s", probe.relation, probe.objectType, probe.objectId);
          const snap = canWithCapabilities(snapshot, probe.relation, probe.objectType, probe.objectId);
          expect({ probe, snap }).toEqual({ probe, snap: live });
        }
      });
    }
  });

  describe("delegated enforcement path agrees with the materializer", () => {
    const DELEGATED_SCENARIOS: Array<{
      name: string;
      grants: Array<{ subjectType: string; subjectId: string } & Tuple>;
      probes: Request[];
    }> = [
      {
        name: "actor inherits through a zeroed surface",
        grants: [
          { subjectType: "agent", subjectId: "executor", relation: "execute", objectType: "group", objectId: "*" },
          {
            subjectType: "contact",
            subjectId: "luis",
            relation: "execute",
            objectType: "group",
            objectId: "sessions_info",
          },
        ],
        probes: [
          { relation: "execute", objectType: "group", objectId: "sessions_info" },
          { relation: "execute", objectType: "group", objectId: "whatsapp_group_create" },
        ],
      },
      {
        name: "surface deny vetoes",
        grants: [
          { subjectType: "agent", subjectId: "executor", relation: "execute", objectType: "group", objectId: "*" },
          {
            subjectType: "contact",
            subjectId: "luis",
            relation: "execute",
            objectType: "group",
            objectId: "sessions_info",
          },
          {
            subjectType: "chat",
            subjectId: "chat_group_1",
            relation: "deny_execute",
            objectType: "group",
            objectId: "sessions_info",
          },
        ],
        probes: [{ relation: "execute", objectType: "group", objectId: "sessions_info" }],
      },
    ];

    for (const scenario of DELEGATED_SCENARIOS) {
      it(scenario.name, () => {
        for (const g of scenario.grants) {
          grantRelation(g.subjectType, g.subjectId, g.relation, g.objectType, g.objectId, "manual", {
            permanent: true,
          });
        }
        const materialized = materializeDelegatedAuthority({
          agentPrincipal: { subjectType: "agent", subjectId: "executor" },
          actorPrincipal: { subjectType: "contact", subjectId: "luis" },
          surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
        });
        const context: CapabilityContextLike = {
          agentId: "executor",
          kind: "turn-runtime",
          capabilities: materialized.effectiveCapabilities,
          metadata: {
            authorityMode: "delegated",
            executorAgentId: "executor",
            actorPrincipal: "contact:luis",
            surfacePrincipal: "chat:chat_group_1",
          },
        };
        for (const probe of scenario.probes) {
          const enforcement = canWithCapabilityContext(context, probe.relation, probe.objectType, probe.objectId);
          const fromMaterializer = canWithCapabilities(
            materialized.effectiveCapabilities,
            probe.relation,
            probe.objectType,
            probe.objectId,
          );
          expect({ probe, enforcement }).toEqual({ probe, enforcement: fromMaterializer });
        }
      });
    }
  });

  describe("explain final decision equals the materializer", () => {
    it("matches for an allowed delegated request", () => {
      grantRelation("agent", "executor", "execute", "group", "*", "manual", { permanent: true });
      grantRelation("contact", "luis", "execute", "group", "sessions_info", "manual", { permanent: true });

      const decision = explainPermissionDecision({
        agentId: "executor",
        actor: "contact:luis",
        chat: "chat:chat_group_1",
        relation: "execute",
        objectType: "group",
        objectId: "sessions_info",
      });
      const materialized = materializeDelegatedAuthority({
        agentPrincipal: { subjectType: "agent", subjectId: "executor" },
        actorPrincipal: { subjectType: "contact", subjectId: "luis" },
        surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      });

      expect(decision.final.allowed).toBe(
        canWithCapabilities(materialized.effectiveCapabilities, "execute", "group", "sessions_info"),
      );
      expect(decision.final.allowed).toBe(true);
    });

    it("matches for a denied delegated request", () => {
      grantRelation("agent", "executor", "execute", "group", "*", "manual", { permanent: true });

      const decision = explainPermissionDecision({
        agentId: "executor",
        actor: "contact:luis",
        chat: "chat:chat_group_1",
        relation: "execute",
        objectType: "group",
        objectId: "sessions_info",
      });
      const materialized = materializeDelegatedAuthority({
        agentPrincipal: { subjectType: "agent", subjectId: "executor" },
        actorPrincipal: { subjectType: "contact", subjectId: "luis" },
        surfacePrincipal: { subjectType: "chat", subjectId: "chat_group_1" },
      });

      expect(decision.final.allowed).toBe(
        canWithCapabilities(materialized.effectiveCapabilities, "execute", "group", "sessions_info"),
      );
      expect(decision.final.allowed).toBe(false);
    });
  });
});
