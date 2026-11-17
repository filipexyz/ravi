import { describe, expect, it } from "bun:test";
import { decodeLiteralLineBreaks } from "./thread-text.js";

describe("decodeLiteralLineBreaks", () => {
  it("turns shell-typed \\n into line breaks in a one-line brief", () => {
    expect(decodeLiteralLineBreaks("Publicar no GitHub\\n\\nLuís autorizou.\\r\\nObjetivo: preparar.")).toBe(
      "Publicar no GitHub\n\nLuís autorizou.\nObjetivo: preparar.",
    );
  });

  it("leaves text with real line breaks alone", () => {
    const text = "Corrigir o parser\n\nO split usa `/\\n/` hoje.";
    expect(decodeLiteralLineBreaks(text)).toBe(text);
  });

  it("keeps an escaped \\\\n and text without any", () => {
    expect(decodeLiteralLineBreaks("printf 'a\\\\nb'")).toBe("printf 'a\\\\nb'");
    expect(decodeLiteralLineBreaks("Sem quebras aqui.")).toBe("Sem quebras aqui.");
  });
});
