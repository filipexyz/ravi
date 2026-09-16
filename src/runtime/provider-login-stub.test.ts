import { describe, expect, it } from "bun:test";
import { isRuntimeProviderLoginStub, PROVIDER_LOGIN_STUB_PHRASES } from "./provider-login-stub.js";

const STUB = "Not logged in";
const STUB_WITH_INSTRUCTION = "Not logged in · Please run /login";

describe("runtime provider login stub", () => {
  it("matches the bare provider stub line", () => {
    expect(isRuntimeProviderLoginStub(STUB)).toBe(true);
    expect(isRuntimeProviderLoginStub("not logged in.")).toBe(true);
  });

  it("matches the combined stub line regardless of the provider that relays it", () => {
    expect(isRuntimeProviderLoginStub(STUB_WITH_INSTRUCTION, { provider: "claude" })).toBe(true);
    expect(isRuntimeProviderLoginStub(STUB_WITH_INSTRUCTION, { provider: "codex" })).toBe(true);
    expect(isRuntimeProviderLoginStub(STUB_WITH_INSTRUCTION)).toBe(true);
  });

  it("scopes an explicitly provider-scoped phrase to that provider", () => {
    const phrases = [{ id: "test.scoped", pattern: /^scoped stub\.?$/i, providers: ["claude"] }];
    expect(isRuntimeProviderLoginStub("Scoped stub", { provider: "claude", phrases })).toBe(true);
    expect(isRuntimeProviderLoginStub("Scoped stub", { provider: "codex", phrases })).toBe(false);
    expect(isRuntimeProviderLoginStub("Scoped stub", { phrases })).toBe(false);
  });

  it("supports an explicit embedded match, still bounded by the shape guard", () => {
    const phrases = [{ id: "test.embedded", pattern: /auth failed: token expired/i, match: "contains" as const }];
    expect(isRuntimeProviderLoginStub("Error: auth failed: token expired", { phrases })).toBe(true);
    expect(isRuntimeProviderLoginStub(`Error: auth failed: token expired ${"x".repeat(300)}`, { phrases })).toBe(false);
  });

  it("does not match a real assistant message that quotes or explains the stub", () => {
    // Regression: this exact shape failed the turn and silently discarded the
    // whole response, because the old check was a substring test.
    const report = [
      "Estudei o CLI. Resumo:",
      "",
      "- o binário não está instalado",
      `- rodando o status, a saída foi: "${STUB}"`,
      "- então falta autenticar antes de usar",
    ].join("\n");

    expect(isRuntimeProviderLoginStub(report)).toBe(false);
    expect(isRuntimeProviderLoginStub(report, { provider: "pi" })).toBe(false);
  });

  it("does not match multi-line text that starts with the stub", () => {
    expect(isRuntimeProviderLoginStub(`${STUB}\n\nTambém vale notar outra coisa.`)).toBe(false);
  });

  it("does not match when the turn produced output tokens", () => {
    expect(isRuntimeProviderLoginStub(STUB, { outputTokens: 12 })).toBe(false);
    expect(isRuntimeProviderLoginStub(STUB, { outputTokens: 0 })).toBe(true);
  });

  it("ignores empty and unrelated text", () => {
    expect(isRuntimeProviderLoginStub(undefined)).toBe(false);
    expect(isRuntimeProviderLoginStub(null)).toBe(false);
    expect(isRuntimeProviderLoginStub("   ")).toBe(false);
    expect(isRuntimeProviderLoginStub("Tudo certo por aqui.")).toBe(false);
  });

  it("normalizes incidental whitespace before matching", () => {
    expect(isRuntimeProviderLoginStub("  Not   logged   in  ")).toBe(true);
  });

  it("exposes a phrase map with unique ids", () => {
    const ids = PROVIDER_LOGIN_STUB_PHRASES.map((phrase) => phrase.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
