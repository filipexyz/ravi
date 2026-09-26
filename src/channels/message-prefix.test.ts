import { describe, expect, it } from "bun:test";
import { channelMessagePrefixDelivery, parseChannelMessagePrefix } from "./message-prefix.js";

describe("parseChannelMessagePrefix", () => {
  it("reads >> as an end-of-turn prefix and strips it", () => {
    expect(parseChannelMessagePrefix(">>check the deploy")).toEqual({
      kind: "end_of_turn",
      body: "check the deploy",
    });
    expect(parseChannelMessagePrefix(">> check the deploy")).toEqual({
      kind: "end_of_turn",
      body: "check the deploy",
    });
  });

  it("reads !! as a skip-turn prefix and strips it", () => {
    expect(parseChannelMessagePrefix("!!remember the budget is 10k")).toEqual({
      kind: "skip_turn",
      body: "remember the budget is 10k",
    });
    expect(parseChannelMessagePrefix("!! remember the budget is 10k")).toEqual({
      kind: "skip_turn",
      body: "remember the budget is 10k",
    });
  });

  it("allows leading whitespace and drops all whitespace after the prefix", () => {
    expect(parseChannelMessagePrefix("  \n>>   later")).toEqual({ kind: "end_of_turn", body: "later" });
    expect(parseChannelMessagePrefix("\t!!\n\nfirst line\nsecond line  ")).toEqual({
      kind: "skip_turn",
      body: "first line\nsecond line  ",
    });
  });

  it("treats a bare prefix or a prefix followed only by whitespace as normal input", () => {
    for (const text of [">>", "!!", ">>   ", "!!   ", "  >>\n", "\n!!\t "]) {
      expect(parseChannelMessagePrefix(text)).toBeNull();
    }
  });

  it("ignores prefixes that are not at the start of the message", () => {
    for (const text of ["hello >> world", "hello !! world", "ok>>later", "<@U123> >>later", "@ravi !!note"]) {
      expect(parseChannelMessagePrefix(text)).toBeNull();
    }
  });

  it("ignores single markers and runs of three or more", () => {
    for (const text of ["> quoted", "! bang", ">>> block quote", "!!! wow", "!!!!", ">>>>x"]) {
      expect(parseChannelMessagePrefix(text)).toBeNull();
    }
  });

  it("only strips the leading prefix and keeps later markers in the body", () => {
    expect(parseChannelMessagePrefix(">> > quoted")).toEqual({ kind: "end_of_turn", body: "> quoted" });
    expect(parseChannelMessagePrefix(">>!!both")).toEqual({ kind: "end_of_turn", body: "!!both" });
    expect(parseChannelMessagePrefix("!!>>both")).toEqual({ kind: "skip_turn", body: ">>both" });
  });

  it("returns null for empty input", () => {
    expect(parseChannelMessagePrefix("")).toBeNull();
    expect(parseChannelMessagePrefix(undefined)).toBeNull();
    expect(parseChannelMessagePrefix(null)).toBeNull();
  });
});

describe("channelMessagePrefixDelivery", () => {
  it("maps >> to an explicit after_response barrier", () => {
    expect(channelMessagePrefixDelivery(parseChannelMessagePrefix(">>later"))).toEqual({
      deliveryBarrier: "after_response",
      deliveryBarrierSource: "explicit",
    });
  });

  it("maps !! to a skip-turn prompt", () => {
    expect(channelMessagePrefixDelivery(parseChannelMessagePrefix("!!context"))).toEqual({ _skipTurn: true });
  });

  it("leaves unprefixed messages untouched", () => {
    expect(channelMessagePrefixDelivery(parseChannelMessagePrefix("hello"))).toEqual({});
    expect(channelMessagePrefixDelivery(null)).toEqual({});
  });
});
