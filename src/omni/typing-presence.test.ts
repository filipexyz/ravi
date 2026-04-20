import { describe, expect, it } from "bun:test";
import { TypingPresenceHeartbeat, type TypingPresenceTimers } from "./typing-presence.js";

function makeTimers() {
  const handles: Array<{ callback: () => void; cleared: boolean; unref: () => void }> = [];
  const timers: TypingPresenceTimers = {
    setInterval(callback) {
      const handle = { callback, cleared: false, unref: () => {} };
      handles.push(handle);
      return handle as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(handle) {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
  };
  return { handles, timers };
}

describe("TypingPresenceHeartbeat", () => {
  it("renews typing presence until the session stops", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { handles, timers } = makeTimers();
    const heartbeat = new TypingPresenceHeartbeat(
      async (target, active) => {
        calls.push({ to: target.to, active });
      },
      20_000,
      timers,
    );

    await heartbeat.start("session-a", { instanceId: "main", to: "chat@g.us" });
    handles[0]?.callback();
    await heartbeat.renew("session-a");
    await heartbeat.stop("session-a");

    expect(calls).toEqual([
      { to: "chat@g.us", active: true },
      { to: "chat@g.us", active: true },
      { to: "chat@g.us", active: true },
      { to: "chat@g.us", active: false },
    ]);
    expect(handles[0]?.cleared).toBe(true);
    expect(heartbeat.has("session-a")).toBe(false);
  });

  it("replaces the previous heartbeat when the same session receives a new target", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { handles, timers } = makeTimers();
    const heartbeat = new TypingPresenceHeartbeat(
      async (target, active) => {
        calls.push({ to: target.to, active });
      },
      20_000,
      timers,
    );

    await heartbeat.start("session-a", { instanceId: "main", to: "first@g.us" });
    await heartbeat.start("session-a", { instanceId: "main", to: "second@g.us" });
    handles[1]?.callback();

    expect(handles[0]?.cleared).toBe(true);
    expect(calls).toEqual([
      { to: "first@g.us", active: true },
      { to: "second@g.us", active: true },
      { to: "second@g.us", active: true },
    ]);
  });

  it("does not renew inactive sessions", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { timers } = makeTimers();
    const heartbeat = new TypingPresenceHeartbeat(
      async (target, active) => {
        calls.push({ to: target.to, active });
      },
      20_000,
      timers,
    );

    await expect(heartbeat.renew("missing")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});
