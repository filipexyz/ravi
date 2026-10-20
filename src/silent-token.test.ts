import { describe, expect, it } from "bun:test";
import {
  isEmptyOrExactSilentText,
  isExactSilentTokenText,
  isSilentTokenText,
  stripLeadingSilentMarker,
} from "./silent-token.js";

describe("silent token classification", () => {
  it("classifies exact, spaced and truncated markers as silence", () => {
    for (const text of ["@@SILENT@@", "  @@SILENT@@\n", "@@ SILENT @@", "@@SILEN", "@@silent@@"]) {
      expect(isSilentTokenText(text)).toBe(true);
    }
  });

  it("does not classify prose that cites the marker as silence", () => {
    for (const text of [
      "Para silenciar, responda @@SILENT@@ no fim.",
      "The marker @@SILENT@@ means no reply.",
      "`@@SILENT@@`",
    ]) {
      expect(isSilentTokenText(text)).toBe(false);
    }
  });

  it("keeps fragments out of per-part exact classification", () => {
    expect(isExactSilentTokenText("@@SIL")).toBe(false);
    expect(isExactSilentTokenText("@@ SILENT @@")).toBe(true);
    expect(isEmptyOrExactSilentText("  ")).toBe(true);
  });

  it("removes a leading control marker but preserves cited markers", () => {
    expect(stripLeadingSilentMarker("@@SILENT@@ Checking the current state.")).toBe("Checking the current state.");
    expect(stripLeadingSilentMarker("@@SILEN Checking now.")).toBe("Checking now.");
    expect(stripLeadingSilentMarker("Use @@SILENT@@ para silenciar.")).toBe("Use @@SILENT@@ para silenciar.");
  });
});
