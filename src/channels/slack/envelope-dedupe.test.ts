import { describe, expect, it } from "bun:test";

import { createEnvelopeDedupe, SEEN_ENVELOPES_MAX } from "./envelope-dedupe.js";

describe("an envelope is answered once", () => {
  it("is new the first time and seen after, per envelope id", () => {
    const first = createEnvelopeDedupe();

    expect(first("env-1")).toBe(true);
    expect(first("env-1")).toBe(false);
    expect(first("env-2")).toBe(true);
    expect(first("env-2")).toBe(false);
  });

  it("treats an interaction with no envelope id as new every time: there is nothing to match it by", () => {
    const first = createEnvelopeDedupe();

    expect(first(undefined)).toBe(true);
    expect(first(undefined)).toBe(true);
    expect(first("")).toBe(true);
  });

  it("keeps each consumer's memory apart", () => {
    const controls = createEnvelopeDedupe();
    const shortcuts = createEnvelopeDedupe();

    expect(controls("env-1")).toBe(true);
    expect(shortcuts("env-1")).toBe(true);
    expect(controls("env-1")).toBe(false);
  });

  it("forgets the oldest envelope past its bound, so the memory never grows without limit", () => {
    const first = createEnvelopeDedupe(3);

    for (const id of ["a", "b", "c"]) expect(first(id)).toBe(true);
    // A fourth pushes `a` out; `b` and `c` are still remembered.
    expect(first("d")).toBe(true);
    expect(first("b")).toBe(false);
    expect(first("c")).toBe(false);
    expect(first("a")).toBe(true);
  });

  it("remembers a thousand envelopes by default", () => {
    expect(SEEN_ENVELOPES_MAX).toBe(1000);
  });
});
