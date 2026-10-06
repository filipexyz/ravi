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

  it("observes presence sends with reasons", async () => {
    const events: Array<{ active: boolean; reason: string; status: string }> = [];
    const { timers } = makeTimers();
    const heartbeat = new TypingPresenceHeartbeat(
      async () => {},
      20_000,
      timers,
      undefined,
      undefined,
      undefined,
      (event) => {
        events.push({ active: event.active, reason: event.reason, status: event.status });
      },
    );

    await heartbeat.start("session-a", { instanceId: "main", to: "chat@g.us" });
    await heartbeat.renew("session-a");
    await heartbeat.stop("session-a");

    expect(events).toEqual([
      { active: true, reason: "start", status: "sent" },
      { active: true, reason: "renew", status: "sent" },
      { active: false, reason: "stop", status: "sent" },
    ]);
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
      { to: "first@g.us", active: false },
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

  it("expires stale sessions instead of renewing forever", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { handles, timers } = makeTimers();
    let now = 0;
    const heartbeat = new TypingPresenceHeartbeat(
      async (target, active) => {
        calls.push({ to: target.to, active });
      },
      20_000,
      timers,
      60_000,
      { now: () => now },
    );

    await heartbeat.start("session-a", { instanceId: "main", to: "chat@g.us" });
    now = 61_000;
    handles[0]?.callback();

    expect(calls).toEqual([
      { to: "chat@g.us", active: true },
      { to: "chat@g.us", active: false },
    ]);
    expect(handles[0]?.cleared).toBe(true);
    expect(heartbeat.has("session-a")).toBe(false);
  });

  it("stops presence when the runtime session is no longer active", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { handles, timers } = makeTimers();
    let active = true;
    const heartbeat = new TypingPresenceHeartbeat(
      async (target, emittedActive) => {
        calls.push({ to: target.to, active: emittedActive });
      },
      20_000,
      timers,
      60_000,
      { now: () => 0 },
      () => active,
    );

    await heartbeat.start("session-a", { instanceId: "main", to: "chat@g.us" });
    active = false;
    handles[0]?.callback();

    expect(calls).toEqual([
      { to: "chat@g.us", active: true },
      { to: "chat@g.us", active: false },
    ]);
    expect(handles[0]?.cleared).toBe(true);
    expect(heartbeat.has("session-a")).toBe(false);
  });

  it("arms the stale safety net even when the first presence send never answers", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { handles, timers } = makeTimers();
    let now = 0;
    const heartbeat = new TypingPresenceHeartbeat(
      (target, active) => {
        calls.push({ to: target.to, active });
        // The first "typing on" call hangs forever, as a stalled Omni request would.
        return calls.length === 1 ? new Promise<void>(() => {}) : Promise.resolve();
      },
      20_000,
      timers,
      60_000,
      { now: () => now },
    );

    void heartbeat.start("session-a", { instanceId: "main", to: "chat@g.us" });
    await Promise.resolve();

    expect(heartbeat.has("session-a")).toBe(true);
    now = 60_000;
    handles[0]?.callback();
    await Promise.resolve();

    expect(heartbeat.has("session-a")).toBe(false);
    expect(handles[0]?.cleared).toBe(true);
    expect(calls).toEqual([
      { to: "chat@g.us", active: true },
      { to: "chat@g.us", active: false },
    ]);
  });

  it("repeats the stop when the session stopped while the first send was in flight", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { timers } = makeTimers();
    let releaseStart: () => void = () => {};
    const heartbeat = new TypingPresenceHeartbeat(
      (target, active) => {
        calls.push({ to: target.to, active });
        if (calls.length === 1) return new Promise<void>((resolve) => (releaseStart = resolve));
        return Promise.resolve();
      },
      20_000,
      timers,
    );

    const starting = heartbeat.start("session-a", { instanceId: "main", to: "chat@g.us" });
    await heartbeat.stop("session-a");
    releaseStart();
    await starting;

    expect(heartbeat.has("session-a")).toBe(false);
    expect(calls).toEqual([
      { to: "chat@g.us", active: true },
      { to: "chat@g.us", active: false },
      { to: "chat@g.us", active: false },
    ]);
  });

  it("does not register a replacement when the session stops during the replace-stop", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { handles, timers } = makeTimers();
    let releaseReplaceStop: () => void = () => {};
    const heartbeat = new TypingPresenceHeartbeat(
      (target, active) => {
        calls.push({ to: target.to, active });
        if (calls.length === 2) return new Promise<void>((resolve) => (releaseReplaceStop = resolve));
        return Promise.resolve();
      },
      20_000,
      timers,
    );

    await heartbeat.start("session-a", { instanceId: "main", to: "old@g.us" });
    const replacing = heartbeat.start("session-a", { instanceId: "main", to: "new@g.us" });
    await heartbeat.stop("session-a");
    releaseReplaceStop();
    await replacing;

    expect(heartbeat.has("session-a")).toBe(false);
    expect(handles).toHaveLength(1);
    expect(calls).toEqual([
      { to: "old@g.us", active: true },
      { to: "old@g.us", active: false },
    ]);
  });

  it("stops the old target when a different target replaces it during the first send", async () => {
    const calls: Array<{ to: string; active: boolean }> = [];
    const { timers } = makeTimers();
    let releaseStart: () => void = () => {};
    const heartbeat = new TypingPresenceHeartbeat(
      (target, active) => {
        calls.push({ to: target.to, active });
        if (calls.length === 1) return new Promise<void>((resolve) => (releaseStart = resolve));
        return Promise.resolve();
      },
      20_000,
      timers,
    );

    const first = heartbeat.start("session-a", { instanceId: "main", to: "old@g.us" });
    await heartbeat.start("session-a", { instanceId: "main", to: "new@g.us" });
    releaseStart();
    await first;

    expect(heartbeat.has("session-a")).toBe(true);
    expect(calls).toEqual([
      { to: "old@g.us", active: true },
      { to: "old@g.us", active: false },
      { to: "new@g.us", active: true },
      { to: "old@g.us", active: false },
    ]);
  });
});
