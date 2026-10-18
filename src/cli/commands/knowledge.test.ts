import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";

import { saveMessage } from "../../db.js";
import type { KnowledgeClient } from "../../knowledge/client.js";
import { insertKnowledgeGap, listGapsByStatus } from "../../knowledge/gaps/store.js";
import type { KnowledgeItem } from "../../knowledge/items/store.js";
import type { KnowledgeSearchPayload, KnowledgeTurn } from "../../knowledge/types.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../../test/ravi-state.js";
import { CONTRACT_EXIT_POLICY, ContractError } from "../agent-contract.js";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { KnowledgeCommands, type KnowledgeCommandDeps } from "./knowledge.js";

// The search test opens real SQLite state; a loaded machine can take seconds.
setDefaultTimeout(20_000);

const TURN: KnowledgeTurn = {
  audience: "operator",
  turnKey: null,
  sessionName: null,
  agentId: null,
  execContext: { v: 1, speaker: { kind: "terminal" }, conversation: "terminal" } as KnowledgeTurn["execContext"],
};

const ITEM: KnowledgeItem = {
  id: "11111111-2222-3333-4444-555555555555",
  scope: "contact",
  subjectId: "c1",
  agentId: null,
  kind: "preference",
  key: "prefere-audio-curto",
  body: "prefere áudio curto",
  status: "active",
  trust: "approved",
  speaker: "operator",
  recordedAt: 1,
  expiresAt: null,
  supersededBy: null,
  createdBy: "operator",
  createdAt: 1,
  updatedAt: 1,
};

const SECRET_BODY = "Entregas para o Sul levam 12 dias úteis";

type Calls = string[];

/** Every dependency records its call; the gate records first. */
function recordingDeps(calls: Calls, gate?: KnowledgeCommandDeps["gate"]): KnowledgeCommandDeps {
  const record =
    <T>(name: string, value: T) =>
    (..._args: unknown[]) => {
      calls.push(name);
      return value;
    };
  return {
    gate:
      gate ??
      ((op) => {
        calls.push(`gate:${op}`);
        return { turn: TURN };
      }),
    search: record("search", Promise.resolve(searchPayload())) as KnowledgeCommandDeps["search"],
    read: record("read", Promise.resolve({})) as unknown as KnowledgeCommandDeps["read"],
    why: record("why", Promise.resolve({ runs: [], issues: [], next: [] })) as KnowledgeCommandDeps["why"],
    sources: record("sources", Promise.resolve({})) as unknown as KnowledgeCommandDeps["sources"],
    marks: record(
      "marks",
      Promise.resolve({ marks: [], card: null, issues: [], next: [] }),
    ) as KnowledgeCommandDeps["marks"],
    remember: record("remember", { item: ITEM, activated: true, reason: null }) as KnowledgeCommandDeps["remember"],
    confirm: record("confirm", ITEM) as KnowledgeCommandDeps["confirm"],
    forget: record("forget", { archived: 1, redacted: 0, ftsRowsDeleted: 0 }) as KnowledgeCommandDeps["forget"],
    planProposal: ((input: { text?: string }) => {
      calls.push("plan");
      return {
        plan: {
          kind: "note",
          project: "vendas",
          title: null,
          body: input.text ?? "",
          evidence: [],
          supersedes: null,
          requestedAudience: { kind: "members" },
          idempotencyKey: "k",
        },
        summary: { kind: "note", bytes: Buffer.byteLength(input.text ?? ""), project: "vendas", audience: "members" },
      };
    }) as KnowledgeCommandDeps["planProposal"],
    submitProposal: record(
      "submit",
      Promise.resolve({
        proposal: {
          id: "p1",
          kind: "note",
          status: "pending",
          projectId: "proj",
          title: null,
          body: SECRET_BODY,
          answer: null,
          faq: null,
          waitingCount: 0,
          cardUrl: "https://console.ravi.bot/k/p1",
          createdAt: "2026-10-17T00:00:00.000Z",
          expiresAt: "2026-11-17T00:00:00.000Z",
          decidedAt: null,
        },
        deduped: false,
      }),
    ) as KnowledgeCommandDeps["submitProposal"],
    knowledge: {
      openClient: async () => {
        calls.push("console");
        return null;
      },
    },
  };
}

function searchPayload() {
  return {
    query: "prazo",
    audience: "operator" as const,
    nonce: "n",
    rule: "r",
    results: [],
    withheld: null,
    runId: null,
    localRunId: "kl:1",
    issues: [],
    next: ["ravi knowledge why --last"],
  };
}

/** Each command, invoked with arguments that would otherwise do work. */
const INVOCATIONS: Array<[string, (command: KnowledgeCommands) => Promise<unknown>]> = [
  ["search", (c) => c.search("prazo", undefined, undefined, undefined, "7d", undefined, "5", false, true)],
  ["read", (c) => c.read("kc:1", "2", true)],
  ["why", (c) => c.why(true, undefined, undefined, undefined, true)],
  ["sources", (c) => c.sources(undefined, true)],
  ["marks", (c) => c.marks(undefined, true)],
  [
    "remember",
    (c) => c.remember("prefere áudio curto", "contact:c1", undefined, undefined, undefined, undefined, true),
  ],
  ["forget", (c) => c.forget("ki:abc", undefined, undefined, true)],
  [
    "propose",
    (c) => c.propose(SECRET_BODY, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true),
  ],
];

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T | undefined; error: unknown; output: string }> {
  const log = console.log;
  const error = console.error;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { value: await fn(), error: undefined, output: lines.join("\n") };
  } catch (caught) {
    return { value: undefined, error: caught, output: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe("knowledge command surface", () => {
  it("declares eight commands, their access and the write brakes", () => {
    const names = getCommandsMetadata(KnowledgeCommands).map((command) => command.name);
    expect(names.sort()).toEqual(["forget", "marks", "propose", "read", "remember", "search", "sources", "why"]);

    const access = getCommandAccessMetadata(KnowledgeCommands);
    for (const read of ["search", "read", "why", "sources", "marks"]) {
      expect(access.get(read)).toMatchObject({ kind: "read", resource: "knowledge", action: read, risk: "medium" });
    }
    expect(access.get("remember")).toMatchObject({ kind: "mutate", action: "remember", risk: "low" });
    expect(access.get("remember")?.requiresConfirmation).toBeUndefined();
    expect(access.get("forget")).toMatchObject({ kind: "mutate", risk: "destructive", requiresConfirmation: true });
    expect(access.get("propose")).toMatchObject({ kind: "mutate", risk: "medium", requiresConfirmation: true });

    const instance = new KnowledgeCommands();
    const returns = getReturnsMetadata(KnowledgeCommands);
    for (const name of names) {
      const flags = getOptionsMetadata(instance, name).map((option) => option.flags);
      expect(flags).toContain("--json");
      expect(returns.get(name)).toBeDefined();
    }
    const lastFlag = (method: string) => {
      const options = getOptionsMetadata(instance, method);
      return options.reduce((last, option) => (option.index > last.index ? option : last)).flags;
    };
    expect(lastFlag("forget")).toBe("--execute");
    expect(lastFlag("propose")).toBe("--execute");

    const timeouts = Object.fromEntries(
      getCommandsMetadata(KnowledgeCommands).map((command) => [command.name, command.remoteTimeoutMs]),
    );
    expect(timeouts).toMatchObject({ search: 45_000, read: 45_000, propose: 45_000 });
  });
});

describe("knowledge gate", () => {
  for (const [name, invoke] of INVOCATIONS) {
    it(`${name} calls the gate before any work`, async () => {
      const calls: Calls = [];
      const { error } = await quiet(() => invoke(new KnowledgeCommands(recordingDeps(calls))));
      if (name === "propose") {
        // `propose` without --execute stops at the brake, after planning.
        expect((error as ContractError).code).toBe("WRITE_REQUIRES_EXECUTE");
      } else {
        expect(error).toBeUndefined();
      }
      expect(calls[0]).toBe(`gate:knowledge ${name}`);
      expect(calls.length).toBeGreaterThan(1);
    });

    it(`${name} exits 3 with no Console call when the gate refuses`, async () => {
      const calls: Calls = [];
      const refusal = new ContractError(
        `knowledge ${name}`,
        "KNOWLEDGE_TURN_NOT_OPERATOR",
        "Knowledge answers only the operator's own turns.",
        CONTRACT_EXIT_POLICY,
      );
      const deps = recordingDeps(calls, () => {
        throw refusal;
      });
      const { error } = await quiet(() => invoke(new KnowledgeCommands(deps)));
      expect(error).toBe(refusal);
      expect((error as ContractError).exitCode).toBe(3);
      expect(calls).toEqual([]);
    });
  }

  it("a gate refusal for exposure also stops before any work", async () => {
    const calls: Calls = [];
    const deps = recordingDeps(calls, (op) => {
      throw new ContractError(op, "KNOWLEDGE_EXPOSURE_UNSAFE", "unsafe", CONTRACT_EXIT_POLICY, {
        issues: ["agent main: instance wa-main admits open DMs"],
      });
    });
    const { error } = await quiet(() =>
      new KnowledgeCommands(deps).search(
        "prazo",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect((error as ContractError).code).toBe("KNOWLEDGE_EXPOSURE_UNSAFE");
    expect((error as ContractError).exitCode).toBe(3);
    expect(calls).toEqual([]);
  });
});

describe("knowledge write brakes", () => {
  it("propose without --execute exits 3 WRITE_REQUIRES_EXECUTE with a plan that has bytes but not the body", async () => {
    const calls: Calls = [];
    const command = new KnowledgeCommands(recordingDeps(calls));
    const { error, output } = await quiet(() =>
      command.propose(SECRET_BODY, undefined, undefined, undefined, ["kc:1"], undefined, "vendas", undefined, true),
    );
    const contractError = error as ContractError;
    expect(contractError.code).toBe("WRITE_REQUIRES_EXECUTE");
    expect(contractError.exitCode).toBe(3);
    expect(contractError.details.plan).toMatchObject({
      kind: "note",
      bytes: Buffer.byteLength(SECRET_BODY),
      project: "vendas",
      audience: "members",
    });
    expect(JSON.stringify(contractError.envelope())).not.toContain(SECRET_BODY);
    expect(output).not.toContain(SECRET_BODY);
    expect(calls).not.toContain("submit");

    const sent = await quiet(() =>
      command.propose(
        SECRET_BODY,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "vendas",
        undefined,
        true,
        true,
      ),
    );
    expect(sent.error).toBeUndefined();
    expect(calls).toContain("submit");
    expect(sent.value).toMatchObject({ deduped: false, proposal: { id: "p1" } });
  });

  it("propose needs exactly one kind flag (usage exit 2)", async () => {
    const calls: Calls = [];
    const command = new KnowledgeCommands(recordingDeps(calls));
    const none = await quiet(() =>
      command.propose(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true),
    );
    expect((none.error as ContractError).exitCode).toBe(2);
    const two = await quiet(() =>
      command.propose("a", "b", undefined, undefined, undefined, undefined, undefined, undefined, true),
    );
    expect((two.error as ContractError).code).toBe("USAGE_ERROR");
    expect(calls).not.toContain("plan");
  });

  it("forget <id> without --redact runs at once", async () => {
    const calls: Calls = [];
    let received: unknown;
    const deps = recordingDeps(calls);
    deps.forget = ((input: unknown) => {
      calls.push("forget");
      received = input;
      return { archived: 1, redacted: 0, ftsRowsDeleted: 0 };
    }) as KnowledgeCommandDeps["forget"];
    const { value, error } = await quiet(() =>
      new KnowledgeCommands(deps).forget("ki:abc", undefined, undefined, true),
    );
    expect(error).toBeUndefined();
    expect(value).toEqual({ archived: 1, redacted: 0, ftsRowsDeleted: 0 });
    expect(received).toEqual({ id: "abc", redact: false });
  });

  it("forget --redact without --execute exits 3 and forgets nothing", async () => {
    const calls: Calls = [];
    const command = new KnowledgeCommands(recordingDeps(calls));
    const { error } = await quiet(() => command.forget(undefined, "contact:c1", true, true));
    expect((error as ContractError).code).toBe("WRITE_REQUIRES_EXECUTE");
    expect((error as ContractError).details.plan).toMatchObject({
      action: "redact",
      about: { kind: "contact", id: "c1" },
    });
    expect(calls).not.toContain("forget");

    const done = await quiet(() => command.forget(undefined, "contact:c1", true, true, true));
    expect(done.error).toBeUndefined();
    expect(calls).toContain("forget");
  });
});

describe("knowledge input", () => {
  it("rejects malformed --about, --type and --since with exit 2", async () => {
    const command = new KnowledgeCommands(recordingDeps([]));
    for (const run of [
      () => command.search("x", "person:1", undefined, undefined, undefined, undefined, undefined, undefined, true),
      () =>
        command.search("x", undefined, "meeting,video", undefined, undefined, undefined, undefined, undefined, true),
      () => command.search("x", undefined, undefined, undefined, "yesterday", undefined, undefined, undefined, true),
      () => command.search("x", undefined, undefined, undefined, undefined, undefined, "0", undefined, true),
    ]) {
      const { error } = await quiet(run);
      expect((error as ContractError).exitCode).toBe(2);
    }
  });

  it("passes parsed filters to the search", async () => {
    let input: Record<string, unknown> | undefined;
    const deps = recordingDeps([]);
    deps.now = () => Date.parse("2026-10-17T00:00:00.000Z");
    deps.search = (async (received: Record<string, unknown>) => {
      input = received;
      return searchPayload();
    }) as unknown as KnowledgeCommandDeps["search"];
    await quiet(() =>
      new KnowledgeCommands(deps).search("prazo", "chat:abc", "page,chat", "Ana", "7d", "vendas", "3", true, true),
    );
    expect(input).toMatchObject({
      query: "prazo",
      about: { kind: "chat", id: "abc" },
      kinds: ["page", "chat"],
      who: "Ana",
      project: "vendas",
      limit: 3,
      localOnly: true,
      turn: TURN,
    });
    expect((input?.since as Date | undefined)?.toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });

  it("maps a Console refusal from the run to exit 3 with its issue", async () => {
    const { CloudAuthError } = await import("../../cloud-auth/errors.js");
    const deps = recordingDeps([]);
    deps.search = (async () => {
      throw new CloudAuthError("KNOWLEDGE_DISABLED", "disabled", { status: 403 });
    }) as unknown as KnowledgeCommandDeps["search"];
    const { error } = await quiet(() =>
      new KnowledgeCommands(deps).search(
        "prazo",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect((error as ContractError).code).toBe("KNOWLEDGE_DISABLED");
    expect((error as ContractError).exitCode).toBe(3);
    expect(((error as ContractError).details.issues as string[]).length).toBe(1);
  });
});

describe("knowledge search --json", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-knowledge-command-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  it("returns and prints a KnowledgeSearchPayload", async () => {
    saveMessage("dev-main", "user", "qual o prazo de entrega do pedido?", null, {
      channel: "whatsapp",
      chatId: "5511999990001@s.whatsapp.net",
    });
    const command = new KnowledgeCommands({
      gate: () => ({ turn: TURN }),
      knowledge: { openClient: async () => null as KnowledgeClient | null, inGateway: () => false },
    });
    const { value, error, output } = await quiet(() =>
      command.search(
        "prazo entrega",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      ),
    );
    expect(error).toBeUndefined();
    const schema = getReturnsMetadata(KnowledgeCommands).get("search");
    expect(() => schema?.parse(value)).not.toThrow();
    expect(JSON.parse(output)).toEqual(JSON.parse(JSON.stringify(value)));
    const payload = value as KnowledgeSearchPayload;
    expect(payload.audience).toBe("operator");
    expect(payload.issues).toContain("console_not_logged_in");
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0]?.origin).toBe("local");
    expect(payload.results[0]?.excerpt).toContain(`RAVI_KNOWLEDGE ${payload.nonce}`);
    expect(payload.next.length).toBeGreaterThan(0);
  });

  it("forget --about a contact drops its open gap questions", async () => {
    const gap = {
      agentId: "support",
      instanceId: "wa-main",
      channel: "whatsapp",
      accountId: "wa-main",
      chatId: "5511999990001@s.whatsapp.net",
      sessionName: "support-dm-990001",
      question: "tem desconto para ONG?",
    };
    insertKnowledgeGap({ ...gap, contactId: "contact_ana" });
    insertKnowledgeGap({
      ...gap,
      contactId: "contact_bruno",
      chatId: "5511999990002@s.whatsapp.net",
      question: "qual o prazo para o Sul?",
    });
    const command = new KnowledgeCommands({ gate: () => ({ turn: TURN }) });
    const { error } = await quiet(() => command.forget(undefined, "contact:contact_ana", undefined, true));
    expect(error).toBeUndefined();
    expect(listGapsByStatus("dropped", 10).map((row) => row.contactId)).toEqual(["contact_ana"]);
    expect(listGapsByStatus("pending", 10).map((row) => row.contactId)).toEqual(["contact_bruno"]);
  });
});
