import { describe, expect, it } from "bun:test";
import type { Message } from "../db.js";
import { applyRuntimeContinuityRebasePrompt, buildRuntimeContinuityRebasePrompt } from "./session-continuity-rebase.js";

function message(id: number, role: "user" | "assistant", content: string): Message {
  return {
    id,
    session_id: "main-dm",
    role,
    content,
    sdk_session_id: null,
    created_at: `2026-07-18 13:${String(id).padStart(2, "0")}:00`,
  };
}

describe("runtime session continuity rebase", () => {
  it("renders recent same-session history without duplicating the current prompt", () => {
    const rebase = buildRuntimeContinuityRebasePrompt({
      sessionName: "main-dm",
      runtimeProvider: "claude",
      model: "sonnet",
      reason: "provider_mismatch",
      currentPrompts: ["Ouviu?"],
      history: [
        message(1, "user", "Estamos falando do DMN."),
        message(2, "assistant", "Revisei o profile DMN e achei que nao devemos pedir skill tal."),
        message(3, "user", "Ouviu?"),
      ],
    });

    expect(rebase).not.toBeNull();
    expect(rebase?.messageCount).toBe(2);
    expect(rebase?.prompt).toContain("Estamos falando do DMN.");
    expect(rebase?.prompt).toContain("Revisei o profile DMN");
    expect(rebase?.prompt).not.toContain("Ouviu?");

    const prompt = applyRuntimeContinuityRebasePrompt("Ouviu?", rebase!);
    expect(prompt.match(/Ouviu\\?/g)).toHaveLength(1);
    expect(prompt).toContain("## Current User Message(s)");
  });

  it("omits internal system frames from historical context", () => {
    const rebase = buildRuntimeContinuityRebasePrompt({
      sessionName: "main-dm",
      reason: "missing_provider_session",
      currentPrompts: ["continua"],
      history: [
        message(1, "user", "[System] Execute: ls -R /home/ravi"),
        message(2, "assistant", "Contexto util preservado."),
      ],
    });

    expect(rebase).not.toBeNull();
    expect(rebase?.messageCount).toBe(1);
    expect(rebase?.prompt).toContain("Contexto util preservado.");
    expect(rebase?.prompt).not.toContain("ls -R");
    expect(rebase?.prompt).not.toContain("[System] Execute");
  });

  it("does not rebase user-only history from a failed previous turn", () => {
    const rebase = buildRuntimeContinuityRebasePrompt({
      sessionName: "main-dm",
      reason: "missing_provider_session",
      currentPrompts: ["novo pedido"],
      history: [message(1, "user", "pedido anterior que falhou")],
    });

    expect(rebase).toBeNull();
  });
});
