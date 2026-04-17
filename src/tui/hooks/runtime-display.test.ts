import { describe, expect, it } from "bun:test";
import { resolveRuntimeDisplayLabel } from "./runtime-display.js";

describe("resolveRuntimeDisplayLabel", () => {
  it("shows codex default when the configured model is a Claude alias", () => {
    expect(
      resolveRuntimeDisplayLabel({
        configuredProvider: "codex",
        configuredModel: "sonnet",
      }),
    ).toEqual({
      provider: "codex",
      model: "default",
    });
  });

  it("shows the explicit Codex model when it will actually be passed through", () => {
    expect(
      resolveRuntimeDisplayLabel({
        configuredProvider: "codex",
        configuredModel: "gpt-5.4",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4",
    });
  });

  it("prefers the actual execution model reported by runtime events", () => {
    expect(
      resolveRuntimeDisplayLabel({
        configuredProvider: "codex",
        configuredModel: "sonnet",
        runtimeProvider: "codex",
        executionModel: "gpt-5.4-mini",
      }),
    ).toEqual({
      provider: "codex",
      model: "gpt-5.4-mini",
    });
  });

  it("falls back to the configured Claude model for Claude sessions", () => {
    expect(
      resolveRuntimeDisplayLabel({
        configuredProvider: "claude",
        configuredModel: "sonnet",
      }),
    ).toEqual({
      provider: "claude",
      model: "sonnet",
    });
  });
});
