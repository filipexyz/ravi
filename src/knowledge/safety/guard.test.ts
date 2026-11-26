import { describe, expect, it } from "bun:test";

import { runWithContext } from "../../cli/context.js";
import { ContractError } from "../../cli/agent-contract.js";
import type { KnowledgeExposureReport } from "./exposure.js";
import { assertKnowledgeAllowed } from "./guard.js";
import type { KnowledgeTurnVerdict } from "./turn.js";

const SAFE: KnowledgeExposureReport = { ok: true, offenders: [], checkedAgents: 1 };
const OPERATOR: KnowledgeTurnVerdict = {
  ok: true,
  turn: {
    audience: "operator",
    turnKey: null,
    sessionName: null,
    agentId: null,
    execContext: { v: 1, speaker: { kind: "terminal" }, conversation: "terminal" },
  },
};

function quietly<T>(run: () => T): T {
  return runWithContext({ suppressCliOutput: true }, run);
}

function thrown(run: () => unknown): ContractError {
  try {
    quietly(run);
  } catch (error) {
    if (error instanceof ContractError) return error;
    throw error;
  }
  throw new Error("expected a ContractError");
}

describe("assertKnowledgeAllowed", () => {
  it("returns the operator turn when exposure is safe", () => {
    expect(
      quietly(() =>
        assertKnowledgeAllowed("knowledge.search", true, { exposure: () => SAFE, classify: () => OPERATOR }),
      ),
    ).toEqual({ turn: OPERATOR.ok ? OPERATOR.turn : (null as never) });
  });

  it("refuses unsafe exposure first, even on the terminal, listing up to 5 offenders", () => {
    let classified = false;
    const offenders = Array.from({ length: 7 }, (_, index) => ({
      agentId: `agent-${index}`,
      profile: "bootstrap",
      reasons: ["instance wa-main admits open DMs"],
    }));

    const error = thrown(() =>
      assertKnowledgeAllowed("knowledge.search", true, {
        exposure: () => ({ ok: false, offenders, checkedAgents: 7 }),
        classify: () => {
          classified = true;
          return OPERATOR;
        },
      }),
    );

    expect(classified).toBe(false);
    expect(error.code).toBe("KNOWLEDGE_EXPOSURE_UNSAFE");
    expect(error.exitCode).toBe(3);
    const issues = error.details.issues as string[];
    expect(issues.filter((issue) => issue.startsWith("agent-"))).toHaveLength(5);
    expect(issues).toContain("and 2 more agent(s)");
  });

  it("treats exposure that cannot be read as unsafe", () => {
    const error = thrown(() =>
      assertKnowledgeAllowed("knowledge.search", true, {
        exposure: () => {
          throw new Error("db locked");
        },
        classify: () => OPERATOR,
      }),
    );

    expect(error.code).toBe("KNOWLEDGE_EXPOSURE_UNSAFE");
  });

  it("refuses a turn that is not the operator's with exit 3", () => {
    const error = thrown(() =>
      assertKnowledgeAllowed("knowledge.read", false, {
        exposure: () => SAFE,
        classify: () => ({
          ok: false,
          code: "KNOWLEDGE_TURN_NOT_OPERATOR",
          reason: "group",
          actorPrincipal: "contact:c",
        }),
      }),
    );

    expect(error.code).toBe("KNOWLEDGE_TURN_NOT_OPERATOR");
    expect(error.exitCode).toBe(3);
    expect(error.details.refusal).toBe("group");
    expect(error.details.issues).toEqual([
      "Knowledge only answers the operator in their own direct chat or terminal. Tell the person to ask in private.",
    ]);
  });
});
