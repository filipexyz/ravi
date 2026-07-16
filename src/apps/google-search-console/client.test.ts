import { describe, expect, it } from "bun:test";
import { parseCredential } from "./client.js";

describe("GoogleSearchConsoleClient credentials", () => {
  it("accepts the portable credential envelope", () => {
    expect(parseCredential('{"clientId":"id","clientSecret":"secret","refreshToken":"refresh"}')).toEqual({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
  });

  it("never accepts incomplete credentials", () => {
    expect(() => parseCredential('{"clientId":"id"}')).toThrow("clientSecret");
    expect(() => parseCredential("not-json")).toThrow("must be JSON");
  });
});
