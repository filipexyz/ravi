import { describe, expect, test } from "bun:test";
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
