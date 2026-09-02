import { describe, expect, it } from "bun:test";
import {
  createSessionSendWaitState,
  isSessionSendWaitTerminal,
  noteSessionSendWaitRuntimeEvent,
} from "./session-send-wait.js";

describe("session send wait terminal matching", () => {
  it("settles a single send on the first terminal", () => {
    let state = createSessionSendWaitState();
    state = noteSessionSendWaitRuntimeEvent(state, "turn.started");
    expect(isSessionSendWaitTerminal(state, "turn.complete")).toBe(true);
  });

  it("ignores the in-flight turn.complete after an overlapping send is queued", () => {
    let state = createSessionSendWaitState();
    state = noteSessionSendWaitRuntimeEvent(state, "dispatch.queued");
    expect(isSessionSendWaitTerminal(state, "turn.complete")).toBe(false);
    expect(isSessionSendWaitTerminal(state, "turn.failed")).toBe(false);
    expect(isSessionSendWaitTerminal(state, "turn.interrupted")).toBe(false);

    state = noteSessionSendWaitRuntimeEvent(state, "turn.started");
    expect(isSessionSendWaitTerminal(state, "turn.complete")).toBe(true);
  });

  it("clears wait on failed or interrupted terminals for this send", () => {
    let failed = createSessionSendWaitState();
    failed = noteSessionSendWaitRuntimeEvent(failed, "turn.started");
    expect(isSessionSendWaitTerminal(failed, "turn.failed")).toBe(true);

    let interrupted = createSessionSendWaitState();
    interrupted = noteSessionSendWaitRuntimeEvent(interrupted, "dispatch.queued");
    interrupted = noteSessionSendWaitRuntimeEvent(interrupted, "turn.started");
    expect(isSessionSendWaitTerminal(interrupted, "turn.interrupted")).toBe(true);
  });
});
