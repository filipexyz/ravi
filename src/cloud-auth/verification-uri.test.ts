import { describe, expect, it } from "bun:test";
import { completeVerificationUri } from "./verification-uri.js";

describe("completeVerificationUri", () => {
  it("appends user_code to a bare authorize URL", () => {
    expect(completeVerificationUri("https://console.example/cli/authorize", "ABCD-EFGH")).toBe(
      "https://console.example/cli/authorize?user_code=ABCD-EFGH",
    );
  });

  it("preserves an already-complete URL with the same user_code", () => {
    const complete = "https://console.example/cli/authorize?user_code=ABCD-EFGH";
    expect(completeVerificationUri(complete, "ABCD-EFGH")).toBe(complete);
  });

  it("replaces a mismatched user_code with the issued code", () => {
    expect(completeVerificationUri("https://console.example/cli/authorize?user_code=STALE-CODE", "ABCD-EFGH")).toBe(
      "https://console.example/cli/authorize?user_code=ABCD-EFGH",
    );
  });

  it("keeps existing query params and URL-encodes the user_code", () => {
    expect(completeVerificationUri("https://console.example/cli/authorize?source=cli", "AB CD/EF")).toBe(
      "https://console.example/cli/authorize?source=cli&user_code=AB+CD%2FEF",
    );
  });

  it("appends user_code to relative authorize paths", () => {
    expect(completeVerificationUri("/cli/authorize", "ABCD-EFGH")).toBe("/cli/authorize?user_code=ABCD-EFGH");
  });

  it("returns the original URI when the user code is empty", () => {
    expect(completeVerificationUri("https://console.example/cli/authorize", "   ")).toBe(
      "https://console.example/cli/authorize",
    );
  });
});
