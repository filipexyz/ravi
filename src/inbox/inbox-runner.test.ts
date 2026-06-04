import { describe, expect, it } from "bun:test";
import { computeInboxDeliveryProgress } from "./inbox-runner.js";

describe("inbox runner delivery progress", () => {
  it("advances the local cursor when every leased item was delivered", () => {
    expect(
      computeInboxDeliveryProgress(10, [
        { sequence: 11, delivered: true },
        { sequence: 12, delivered: true },
      ]),
    ).toEqual({ lastSequence: 12, hadDeliveryFailure: false });
  });

  it("does not advance past a delivery failure", () => {
    expect(
      computeInboxDeliveryProgress(10, [
        { sequence: 11, delivered: true },
        { sequence: 12, delivered: false },
        { sequence: 13, delivered: true },
      ]),
    ).toEqual({ lastSequence: 11, hadDeliveryFailure: true });
  });
});
