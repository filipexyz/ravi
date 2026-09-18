/**
 * Contrato do connector: o que ele declara suportado no placement local precisa ser
 * exatamente o que a implementação consegue produzir.
 *
 * Existe porque a divergência entre declaração e implementação foi o defeito
 * recorrente deste trabalho, sempre na mesma forma:
 *
 * - `pull_request.merged` era declarado como suportado localmente e **nunca** podia
 *   ser emitido: a fonte devolvia `departed: {}`, então toda PR mergeada saía como
 *   `closed`.
 * - `workflow_run.branch` era pedido ao `gh` e descartado, o que tornava impossível
 *   ligar um run de CI à PR dele.
 * - `push.*` era declarado suportado no Console e o poller local não produz nada
 *   disso.
 *
 * Nenhum desses quebrava um teste, porque nenhum teste perguntava a pergunta óbvia:
 * *o conjunto declarado é o conjunto produzido?*
 *
 * Este arquivo pergunta isso, nas duas direções, sem LLM e sem rede: o `gh` é
 * injetado, o pipeline é o de verdade (`createGhLocalWatchSource` →
 * `departedNumbersBetween` → `deriveLocalGitHubEvents`), e o conjunto declarado vem
 * do próprio catálogo do connector.
 */

import { describe, expect, it } from "bun:test";
import { listWatchConnectors } from "./connectors.js";
import { deriveLocalGitHubEvents } from "./local-events.js";
import { createGhLocalWatchSource, departedNumbersBetween } from "./local-runner.js";
import type { LocalWatchSnapshot } from "./local-events.js";

const REPO = "owner/repo";

interface GhPr {
  number: number;
  title?: string;
  url?: string;
  isDraft?: boolean;
  headRefOid?: string;
  headRefName?: string;
}

interface GhRun {
  databaseId: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  headBranch?: string;
}

/** Estado final das PRs que saíram da lista de abertas. */
interface GhDeparted {
  number: number;
  state: string;
  title?: string;
  url?: string;
}

interface GhWorld {
  prs: GhPr[];
  runs: GhRun[];
  departed: GhDeparted[];
}

/**
 * `gh` de mentira, com o mesmo contrato de argumentos que o código real usa. Se a
 * implementação pedir um campo novo, o teste falha aqui em vez de silenciosamente
 * receber `undefined` — foi assim que `headBranch` ficou vazio por semanas.
 */
function fakeGh(world: GhWorld): (args: string[]) => string {
  return (args: string[]) => {
    const [group, command] = args;
    if (group === "pr" && command === "list") {
      const json = args[args.indexOf("--json") + 1] ?? "";
      expect(json.length).toBeGreaterThan(0);
      return JSON.stringify(world.prs);
    }
    if (group === "pr" && command === "view") {
      const number = Number.parseInt(args[2] ?? "", 10);
      const found = world.departed.find((item) => item.number === number);
      if (!found) throw new Error(`gh pr view: ${number} unknown`);
      return JSON.stringify(found);
    }
    if (group === "run" && command === "list") return JSON.stringify(world.runs);
    throw new Error(`unexpected gh invocation: ${args.join(" ")}`);
  };
}

/** Percorre o MESMO caminho do poller, só sem NATS nem banco. */
function produceEvents(before: GhWorld, after: GhWorld): string[] {
  const source = createGhLocalWatchSource(fakeGh(after));
  const previous = snapshotFrom(before);
  const current = source.readSnapshot(REPO);
  const departed = source.readDeparted(REPO, departedNumbersBetween(previous, current));
  return deriveLocalGitHubEvents(REPO, { previous, current, departed }).events.map((event) => event.eventType);
}

function snapshotFrom(world: GhWorld): LocalWatchSnapshot {
  return createGhLocalWatchSource(fakeGh(world)).readSnapshot(REPO);
}

const BASE: GhWorld = { prs: [], runs: [], departed: [] };

/**
 * Um cenário por evento declarado. A chave é o evento; o valor é o par de mundos
 * que precisa produzi-lo.
 */
const SCENARIOS: Record<string, { before: GhWorld; after: GhWorld }> = {
  "pull_request.opened": {
    before: BASE,
    after: { prs: [{ number: 1, headRefName: "feat/a", headRefOid: "aaa" }], runs: [], departed: [] },
  },
  "pull_request.closed": {
    before: { prs: [{ number: 1 }], runs: [], departed: [] },
    after: { prs: [], runs: [], departed: [{ number: 1, state: "CLOSED" }] },
  },
  "pull_request.merged": {
    before: { prs: [{ number: 1 }], runs: [], departed: [] },
    after: { prs: [], runs: [], departed: [{ number: 1, state: "MERGED" }] },
  },
  "pull_request.ready_for_review": {
    before: { prs: [{ number: 1, isDraft: true }], runs: [], departed: [] },
    after: { prs: [{ number: 1, isDraft: false }], runs: [], departed: [] },
  },
  "pull_request.converted_to_draft": {
    before: { prs: [{ number: 1, isDraft: false }], runs: [], departed: [] },
    after: { prs: [{ number: 1, isDraft: true }], runs: [], departed: [] },
  },
  "pull_request.synchronize": {
    before: { prs: [{ number: 1, headRefOid: "aaa" }], runs: [], departed: [] },
    after: { prs: [{ number: 1, headRefOid: "bbb" }], runs: [], departed: [] },
  },
  "workflow_run.succeeded": {
    before: { prs: [], runs: [{ databaseId: 1, status: "in_progress", conclusion: null }], departed: [] },
    after: { prs: [], runs: [{ databaseId: 1, status: "completed", conclusion: "success" }], departed: [] },
  },
  "workflow_run.failed": {
    before: { prs: [], runs: [{ databaseId: 1, status: "in_progress", conclusion: null }], departed: [] },
    after: { prs: [], runs: [{ databaseId: 1, status: "completed", conclusion: "failure" }], departed: [] },
  },
  "workflow_run.cancelled": {
    before: { prs: [], runs: [{ databaseId: 1, status: "in_progress", conclusion: null }], departed: [] },
    after: { prs: [], runs: [{ databaseId: 1, status: "completed", conclusion: "cancelled" }], departed: [] },
  },
  "workflow_run.completed": {
    before: { prs: [], runs: [{ databaseId: 1, status: "queued", conclusion: null }], departed: [] },
    after: { prs: [], runs: [{ databaseId: 1, status: "completed", conclusion: "neutral" }], departed: [] },
  },
};

function declaredLocalEventTypes(): string[] {
  const connector = listWatchConnectors("github")[0];
  return (connector?.eventTypes ?? [])
    .filter((eventType) => eventType.localSupport === "supported")
    .map((eventType) => eventType.eventType)
    .sort();
}

describe("github connector contract", () => {
  it("declares exactly the events it can produce", () => {
    const declared = declaredLocalEventTypes();
    const produced = new Set<string>();
    for (const scenario of Object.values(SCENARIOS)) {
      for (const eventType of produceEvents(scenario.before, scenario.after)) produced.add(eventType);
    }

    // As duas direções importam: declarar o que não existe mente para quem confia na
    // matriz, e produzir o que não está declarado passa por fora do contrato.
    expect([...produced].sort()).toEqual(declared);
  });

  it("can produce every declared event on its own", () => {
    for (const [eventType, scenario] of Object.entries(SCENARIOS)) {
      expect(produceEvents(scenario.before, scenario.after)).toContain(eventType);
    }
  });

  it("keeps every scenario inside the declared set", () => {
    const declared = new Set(declaredLocalEventTypes());
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      for (const eventType of produceEvents(scenario.before, scenario.after)) {
        expect({ scenario: name, eventType, declared: declared.has(eventType) }).toMatchObject({ declared: true });
      }
    }
  });

  it("does not claim local support for events only the console delivers", () => {
    // `push.*` é entrega de webhook: o poller não deriva isso de estado.
    const connector = listWatchConnectors("github")[0];
    const push = connector?.eventTypes.find((eventType) => eventType.eventType === "push.default_branch");
    expect(push?.consoleSupport).toBe("supported");
    expect(push?.localSupport).toBe("roadmap");
  });
});
