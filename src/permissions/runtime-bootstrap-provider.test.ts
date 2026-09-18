import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dbCreateAgent, dbUpdateAgent } from "../router/router-db.js";
import { cleanupIsolatedRaviState, createIsolatedRaviState } from "../test/ravi-state.js";
import { runtimeBootstrapProvider } from "./runtime-bootstrap-provider.js";

/**
 * spec: skills/scoping/per-agent-visibility — least-privilege default (decisão RM 2026-07-03).
 *
 * Guarda a regressão: o bootstrap NÃO PODE voltar a dar `execute:group:*` a todo
 * agente (isso deixava o filtro de skills inerte). Agente nasce só com o kit
 * baseline de grupos (sessions/tasks/specs/skills); o resto é opt-in por agente.
 */

type Cap = { permission: string; objectType: string; objectId: string };

function materialize(type: string, id: string): Cap[] {
  const fn = runtimeBootstrapProvider.materializeCapabilities;
  if (!fn) throw new Error("materializeCapabilities ausente");
  return fn({ type, id } as never) as Cap[];
}

function groupIds(caps: Cap[]): string[] {
  return caps.filter((c) => c.permission === "execute" && c.objectType === "group").map((c) => c.objectId);
}

describe("runtimeBootstrapProvider — least-privilege default", () => {
  test("agente nasce com o baseline de operação (kit de skill + fabric self/doctor), SEM coringa", () => {
    const groups = groupIds(materialize("agent", "newbie")).sort();
    // 4 grupos de skill (sessions/tasks/specs/skills) + fabric de operação (self/doctor).
    expect(groups).toEqual(["doctor", "self", "sessions", "skills", "specs", "tasks"]);
    // Regressão dura: o default nunca mais pode ser o coringa.
    expect(groups).not.toContain("*");
  });

  test("mantém o kit básico de ferramenta/executável/contatos (inalterado)", () => {
    const caps = materialize("agent", "x");
    const has = (permission: string, objectType: string, objectId: string) =>
      caps.some((c) => c.permission === permission && c.objectType === objectType && c.objectId === objectId);
    expect(has("use", "tool", "*")).toBe(true);
    expect(has("use", "toolgroup", "*")).toBe(true);
    expect(has("read", "context", "codex-bash-hook")).toBe(true);
    expect(has("execute", "group", "context")).toBe(false);
    expect(has("execute", "executable", "ravi")).toBe(true);
    expect(has("read_own_contacts", "system", "*")).toBe(true);
  });

  test("subject não-confiável não recebe capability nenhuma", () => {
    expect(materialize("user", "u1")).toEqual([]);
    expect(materialize("agent", "unknown")).toEqual([]);
    expect(materialize("agent", "")).toEqual([]);
  });
});

describe("runtimeBootstrapProvider — chat-only ceiling", () => {
  let stateDir: string | null = null;

  beforeEach(async () => {
    stateDir = await createIsolatedRaviState("ravi-bootstrap-chat-only-");
  });

  afterEach(async () => {
    await cleanupIsolatedRaviState(stateDir);
    stateDir = null;
  });

  test("suppresses the bootstrap floor when the agent profile is chat-only", () => {
    dbCreateAgent({ id: "reception", cwd: "/tmp/reception" });
    dbUpdateAgent("reception", { defaults: { runtimePermissions: { profile: "chat-only" } } });
    expect(materialize("agent", "reception")).toEqual([]);
  });

  test("keeps birth bootstrap for an agent without a stored profile", () => {
    dbCreateAgent({ id: "newborn", cwd: "/tmp/newborn" });
    expect(groupIds(materialize("agent", "newborn")).sort()).toEqual([
      "doctor",
      "self",
      "sessions",
      "skills",
      "specs",
      "tasks",
    ]);
  });
});
