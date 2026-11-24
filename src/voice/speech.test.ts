import { describe, expect, it } from "bun:test";
import { buildVoicePrompt, classifySpokenControl, extractSpokenLead, sanitizeForSpeech } from "./speech.js";

describe("voice speech", () => {
  it("speaks the session's own 🔊 line and keeps the rest for the screen", () => {
    const result = extractSpokenLead("🔊 Pronto, mandei o resumo para a Ana.\n\n## Detalhes\n- enviado às 10h");
    expect(result.fromMarker).toBe(true);
    expect(result.spokenText).toBe("Pronto, mandei o resumo para a Ana.");
    expect(result.screenText).toContain("## Detalhes");
  });

  it("falls back to the first sentences without markdown", () => {
    const result = extractSpokenLead("**Feito.** Criei a tarefa. Ela vence amanhã. Avisei o time. Mais uma frase.");
    expect(result.fromMarker).toBe(false);
    expect(result.spokenText).toBe("Feito. Criei a tarefa. Ela vence amanhã.");
  });

  it("never speaks code, links, paths or secret-looking tokens", () => {
    const spoken = sanitizeForSpeech(
      "Veja `bun test` em src/voice/door.ts e https://example.com/x. A chave é sk-abcdefghijklmnopqrstuvwxyz123456.\n```ts\nconst a = 1;\n```",
    );
    expect(spoken).not.toContain("bun test");
    expect(spoken).not.toContain("door.ts");
    expect(spoken).not.toContain("example.com");
    expect(spoken).not.toContain("sk-");
    expect(spoken).not.toContain("const a");
  });

  it("marks guest speech in the prompt and asks for a spoken line", () => {
    const prompt = buildVoicePrompt({
      text: "oi",
      speaker: { kind: "guest", id: "guest:x", label: "x" },
      language: "pt",
    });
    expect(prompt).toContain("[voice surface]");
    expect(prompt).toContain("Guest speaker");
    expect(prompt.endsWith("oi")).toBe(true);
  });

  it("recognizes spoken cancel and deny, never a spoken approval", () => {
    expect(classifySpokenControl("Cancela isso")).toBe("cancel");
    expect(classifySpokenControl("pare")).toBe("cancel");
    expect(classifySpokenControl("não")).toBe("deny");
    expect(classifySpokenControl("sim")).toBeNull();
    expect(classifySpokenControl("cancela a reunião de amanhã com o João")).toBeNull();
  });
});
