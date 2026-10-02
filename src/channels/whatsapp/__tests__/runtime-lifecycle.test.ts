/**
 * WhatsAppRuntime lifecycle: start/connect/disconnect/logout, QR and pairing
 * code, connectionReplaced/loggedOut, reconnect + supervisor, health/status, passkey,
 * group prewarm noise, publish retry. Ports plugin.test, disconnect-status and
 * prewarm-connection-closed (omni packages/channel-whatsapp) to the one-instance runtime.
 */

import { describe, expect, it, mock } from "bun:test";
import type { WASocket } from "baileys";
import type { Logger } from "../lib/foundation.js";
import { WhatsAppRuntimeError } from "../runtime-errors.js";
import {
  type FakeSocket,
  OWNER_JID,
  createFakeSocket,
  createHarness,
  createMemoryAuthStorage,
  flush,
} from "./runtime-harness.js";

function closeWith(statusCode: number, message = "closed") {
  const error = Object.assign(new Error(message), { output: { statusCode, payload: { message } } });
  return { connection: "close", lastDisconnect: { error, date: new Date() } };
}

function spyLogger() {
  return {
    debug: mock((_message: string, _data?: Record<string, unknown>) => {}),
    info: mock((_message: string, _data?: Record<string, unknown>) => {}),
    warn: mock((_message: string, _data?: Record<string, unknown>) => {}),
    error: mock((_message: string, _data?: Record<string, unknown>) => {}),
  } satisfies Logger;
}

describe("WhatsAppRuntime start()", () => {
  it("never blocks and waits for pairing when no creds are stored", async () => {
    const h = createHarness({ registered: false });
    expect(h.runtime.getState()).toBe("idle");
    expect(h.runtime.health()).toEqual({ status: "starting" });

    const result = h.runtime.start();
    expect(result).toBeUndefined();
    expect(h.runtime.getState()).toBe("pairing_required");
    expect(h.runtime.health()).toEqual({ status: "starting", reason: "pairing_required" });
    await flush();
    expect(h.ensureInboundStream).toHaveBeenCalledTimes(1);
    expect(h.sockets).toHaveLength(0);
    expect(h.runtime.getStatus()).toEqual({ state: "disconnected", isConnected: false, profileName: null });
  });

  it("connects in the background with stored creds and publishes connection.connected", async () => {
    const h = createHarness();
    h.runtime.start();
    expect(h.runtime.getState()).toBe("connecting");
    expect(h.runtime.health().status).toBe("starting");

    const sock = await h.connect();
    expect(h.sockets).toHaveLength(1);
    expect(h.runtime.getState()).toBe("connected");
    expect(h.runtime.health()).toEqual({ status: "connected", connectedAt: h.clock.now });
    expect(h.runtime.getStatus()).toEqual({ state: "connected", isConnected: true, profileName: "Ravi Bot" });
    expect(sock.fake.profilePictureUrl).toHaveBeenCalledWith(OWNER_JID, "image");

    const connected = h.publishedOfType("connection.connected");
    expect(connected).toHaveLength(1);
    expect(connected[0]?.event.instanceId).toBe(h.instanceId);
    expect(connected[0]?.event.payload).toEqual({
      profileName: "Ravi Bot",
      profilePicUrl: "https://pps.whatsapp.net/me.jpg",
      ownerIdentifier: OWNER_JID,
    });
    expect(connected[0]?.subject).toBe(`ravi.channel.inbound.whatsapp.connection.${h.instanceId}`);
  });

  it("passes the runtime caches to the socket config and strips ravi-only options", async () => {
    const h = createHarness({ socketOptions: { lidFirstEnabled: false, syncFullHistory: true } });
    await h.startAndWaitForSocket();
    const config = h.socketConfigs[0];
    expect(config?.syncFullHistory).toBe(true);
    expect(config && "lidFirstEnabled" in config).toBe(false);
    expect(typeof config?.cachedGroupMetadata).toBe("function");
    expect(typeof config?.getMessage).toBe("function");
    expect(typeof config?.shouldIgnoreJid).toBe("function");
    expect(h.runtime.isLidFirstEnabled()).toBe(false);
  });

  it("persists creds.update through saveCreds", async () => {
    const h = createHarness();
    const sock = await h.startAndWaitForSocket();
    sock.emit("creds.update", { me: { id: OWNER_JID } });
    await flush();
    expect(h.saveCreds).toHaveBeenCalledTimes(1);
  });

  it("reports failed/missing_dependency when the Baileys library cannot load", async () => {
    const h = createHarness({ loadLibrary: async () => Promise.reject(new Error("Cannot find module 'baileys'")) });
    h.runtime.start();
    await flush();
    expect(h.runtime.getState()).toBe("failed");
    expect(h.runtime.health()).toEqual({ status: "failed", reason: "missing_dependency" });
    expect(h.runtime.getStatus().state).toBe("error");
  });
});

describe("QR and pairing", () => {
  it("publishes connection.qr and republishes the pending QR on a second connect", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    const first = await h.runtime.connect();
    expect(first.status).toBe("connecting");
    await flush();
    h.socket().emit("connection.update", { qr: "2@QR-PAYLOAD" });
    await flush();

    expect(h.runtime.getState()).toBe("qr");
    expect(h.runtime.health()).toEqual({ status: "starting", reason: "qr_pending" });
    expect(h.runtime.getStatus().state).toBe("qr");
    const qr = h.publishedOfType("connection.qr");
    expect(qr).toHaveLength(1);
    expect(qr[0]?.subject).toBe(`ravi.channel.inbound.whatsapp.connection.${h.instanceId}`);
    const payload = qr[0]?.event.payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(["qrCode", "expiresAt"]);
    expect(payload.qrCode).toBe("2@QR-PAYLOAD");
    expect(typeof payload.expiresAt).toBe("number");

    const second = await h.runtime.connect();
    expect(second.status).toBe("qr");
    expect(h.publishedOfType("connection.qr")).toHaveLength(2);
    expect(h.sockets).toHaveLength(1);
  });

  it("connect() on a connected instance is a no-op", async () => {
    const h = createHarness();
    await h.connect();
    expect(await h.runtime.connect()).toEqual({ status: "connected", message: "Instance already connected" });
    expect(h.sockets).toHaveLength(1);
  });

  it("forceNewQr clears auth and opens a fresh socket", async () => {
    const h = createHarness();
    const first = await h.connect();
    const result = await h.runtime.connect({ forceNewQr: true });
    expect(result.status).toBe("connecting");
    await flush();
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(first.fake.end).toHaveBeenCalled();
    expect(h.sockets).toHaveLength(2);
  });

  it("rejects invalid connect options at the boundary", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await expect(h.runtime.call("connection.connect", { whatsapp: { connectTimeoutMs: -1 } })).rejects.toMatchObject({
      status: 400,
      code: "INVALID_REQUEST",
    });
  });

  it("requests a pairing code once the socket is ready", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    const pending = h.runtime.call("connection.pairingCode", { phoneNumber: "+55 (11) 99999-0000" });
    await flush();
    h.socket().emit("connection.update", { qr: "2@QR" });
    expect(await pending).toEqual({ code: "ABCD1234" });
    expect(h.socket().fake.requestPairingCode).toHaveBeenCalledWith("5511999990000");
  });

  it("rejects short phone numbers with 400", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await expect(h.runtime.requestPairingCode("12345")).rejects.toMatchObject({ status: 400 });
  });
});

describe("disconnect / logout", () => {
  it("disconnect closes the socket, publishes connection.disconnected and never reconnects (omni#1169)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("connection.disconnect", {});

    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "manual_disconnect" });
    expect(h.auth.flags.manualDisconnected).toBe(true);
    expect(sock.fake.end).toHaveBeenCalled();
    expect(sock.fake.logout).not.toHaveBeenCalled();
    expect(sock.fake.ev.listenerCount("connection.update")).toBe(0);
    const disconnected = h.publishedOfType("connection.disconnected");
    expect(disconnected.map((record) => record.event.payload)).toEqual([
      { reason: "User requested disconnect", willReconnect: false },
    ]);
    expect(h.manual.pending.size).toBe(0);
    await flush(30);
    expect(h.sockets).toHaveLength(1);
  });

  it("disconnect without a live socket still resets state and emits nothing", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await h.runtime.disconnect();
    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.publishedOfType("connection.disconnected")).toHaveLength(0);
  });

  it("logout unlinks the device, clears auth and reports logged_out", async () => {
    const h = createHarness();
    const sock = await h.connect();
    expect(await h.runtime.call("connection.logout", {})).toEqual({ unlinked: true });
    expect(sock.fake.logout).toHaveBeenCalledTimes(1);
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(h.runtime.getState()).toBe("logged_out");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "logged_out" });
    expect(h.runtime.getStatus()).toEqual({ state: "logged_out", isConnected: false, profileName: null });
    expect(h.publishedOfType("connection.disconnected")[0]?.event.payload).toMatchObject({ reason: "Logged out" });
  });

  it("logout after a disconnect wipes the creds but reports unlinked:false (no socket to unlink with)", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.call("connection.disconnect", {});

    expect(await h.runtime.call("connection.logout", {})).toEqual({ unlinked: false });
    expect(sock.fake.logout).not.toHaveBeenCalled();
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(h.runtime.getState()).toBe("logged_out");
  });

  it("logout while the socket is still connecting reports unlinked:false", async () => {
    const h = createHarness();
    const sock = await h.startAndWaitForSocket();
    expect(h.runtime.getState()).toBe("connecting");

    expect(await h.runtime.call("connection.logout", {})).toEqual({ unlinked: false });
    expect(sock.fake.logout).not.toHaveBeenCalled();
    expect(sock.fake.end).toHaveBeenCalled();
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
  });

  it("logout reports unlinked:false when WhatsApp rejects the unlink, and still wipes the creds", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.fake.logout.mockImplementation(async () => {
      throw new Error("Connection Closed");
    });

    expect(await h.runtime.call("connection.logout", {})).toEqual({ unlinked: false });
    expect(sock.fake.logout).toHaveBeenCalledTimes(1);
    expect(sock.fake.end).toHaveBeenCalled();
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(h.runtime.getState()).toBe("logged_out");
  });

  it("stop() closes the socket and later calls fail with 503", async () => {
    const h = createHarness();
    const sock = await h.connect();
    await h.runtime.stop();
    expect(sock.fake.end).toHaveBeenCalled();
    expect(h.runtime.getState()).toBe("stopped");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "stopped" });
    await expect(h.runtime.call("connection.connect", {})).rejects.toMatchObject({
      status: 503,
      code: "NOT_CONNECTED",
    });
  });
});

describe("socket loss", () => {
  it("connectionReplaced (440) drops the socket and does not reconnect", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("connection.update", closeWith(440, "Stream Errored (conflict)"));
    await flush(30);

    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "connection_replaced" });
    expect(sock.fake.end).toHaveBeenCalled();
    expect(h.sockets).toHaveLength(1);
    expect(h.manual.pending.size).toBe(0);
    expect(h.publishedOfType("connection.disconnected")[0]?.event.payload).toMatchObject({
      reason: "Connection replaced by another session",
      willReconnect: false,
    });
  });

  it("loggedOut (401) clears creds and reports logged_out", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("connection.update", closeWith(401, "Connection Failure"));
    await flush();

    expect(h.runtime.getState()).toBe("logged_out");
    expect(h.library.clearAuthState).toHaveBeenCalledTimes(1);
    expect(h.auth.flags.registered).toBe(false);
    expect(h.publishedOfType("connection.disconnected")[0]?.event.payload).toMatchObject({
      reason: "Logged out from WhatsApp",
      willReconnect: false,
    });
    expect(h.manual.pending.size).toBe(0);
  });

  it("reconnects an authenticated instance with backoff after a transient close", async () => {
    const h = createHarness();
    const sock = await h.connect();
    sock.emit("connection.update", closeWith(428, "Connection Closed"));
    await flush(1);
    expect(["reconnecting", "connecting"]).toContain(h.runtime.getState());
    await flush(30);
    expect(h.sockets).toHaveLength(2);
    h.socket().emit("connection.update", { connection: "open" });
    await flush();
    expect(h.runtime.getState()).toBe("connected");
    expect(h.runtime.health()).toMatchObject({ status: "connected", reconnectCount: 1 });
    expect(h.publishedOfType("connection.connected")).toHaveLength(2);
  });

  it("the supervisor re-arms a connect after a failed socket creation", async () => {
    let calls = 0;
    const h = createHarness({
      library: {
        createSocket: mock(async () => {
          calls++;
          throw new Error("ENETUNREACH");
        }),
      },
    });
    h.runtime.start();
    await flush();
    expect(calls).toBe(1);
    expect(h.runtime.getState()).toBe("disconnected");
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "connect_failed" });
    expect(h.manual.delays()).toEqual([1000]);

    h.manual.runAll();
    await flush();
    expect(calls).toBe(2);
    expect(h.manual.delays()).toEqual([2000]);
  });

  it("the supervisor never fires after a manual disconnect", async () => {
    const h = createHarness({
      library: {
        createSocket: mock(async () => {
          throw new Error("ENETUNREACH");
        }),
      },
    });
    h.runtime.start();
    await flush();
    expect(h.manual.pending.size).toBe(1);
    await h.runtime.disconnect();
    expect(h.manual.pending.size).toBe(0);
  });
});

describe("passkey", () => {
  it("tracks a passkey request and forwards the credential", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await h.runtime.connect();
    await flush();
    const sock = h.socket();
    sock.emit("connection.update", { passkey: { state: "request", publicKey: { challenge: "abc" } } });
    await flush();
    expect(h.runtime.getPasskeyState()).toMatchObject({ state: "request", publicKey: { challenge: "abc" } });

    await h.runtime.submitPasskeyResponse({ id: "cred" } as unknown as Parameters<
      typeof h.runtime.submitPasskeyResponse
    >[0]);
    expect(sock.fake.sendPasskeyResponse).toHaveBeenCalledTimes(1);
    expect(h.runtime.getPasskeyState()?.state).toBe("confirming");
  });

  it("auto-confirms when WhatsApp skips the handoff UX", async () => {
    const h = createHarness({ registered: false });
    h.runtime.start();
    await h.runtime.connect();
    await flush();
    const sock = h.socket();
    sock.emit("connection.update", { passkey: { state: "confirmation", code: "123", skipHandoffUX: true } });
    await flush();
    expect(sock.fake.sendPasskeyConfirmation).toHaveBeenCalledTimes(1);
    expect(h.runtime.getPasskeyState()?.state).toBe("confirming");
  });

  it("confirmPasskey without a pending confirmation is a 400", async () => {
    const h = createHarness();
    await h.connect();
    await expect(h.runtime.confirmPasskey()).rejects.toBeInstanceOf(WhatsAppRuntimeError);
  });
});

describe("group prewarm after connect", () => {
  const GROUP = "120363000000000001@g.us";
  const groups = {
    [GROUP]: {
      id: GROUP,
      subject: "Equipe",
      participants: [
        { id: "111@lid", admin: null },
        { id: "222@lid", admin: "admin" as const },
      ],
    },
  };

  it("prefetches metadata and warms device/session caches for every participant", async () => {
    const h = createHarness({ socket: { groups } });
    const sock = await h.connect();
    await flush();
    expect(sock.fake.groupFetchAllParticipating).toHaveBeenCalledTimes(1);
    expect(sock.fake.getUSyncDevices).toHaveBeenCalledWith(["111@lid", "222@lid"], true, false);
    expect(sock.fake.assertSessions).toHaveBeenCalledWith(["111@lid", "222@lid"], false);
    const cached = await h.socketConfigs[0]?.cachedGroupMetadata?.(GROUP);
    expect(cached?.subject).toBe("Equipe");
  });

  it("treats 'Connection Closed' during prefetch as reconnect noise (debug, not warn)", async () => {
    const logger = spyLogger();
    const h = createHarness({ logger });
    h.runtime.start();
    await flush();
    const sock = h.socket();
    sock.fake.groupFetchAllParticipating.mockImplementation(async () => {
      throw new Error("Connection Closed");
    });
    sock.emit("connection.update", { connection: "open" });
    await flush();
    const warned = logger.warn.mock.calls.map((call) => call[0]);
    expect(warned).not.toContain("groupFetchAllParticipating failed");
    expect(logger.debug.mock.calls.map((call) => call[0])).toContain(
      "Group metadata prefetch skipped; socket closed during reconnect",
    );
    expect(h.runtime.getState()).toBe("connected");
  });

  it("still warns for other prefetch failures", async () => {
    const logger = spyLogger();
    const h = createHarness({ logger });
    h.runtime.start();
    await flush();
    const sock = h.socket();
    sock.fake.groupFetchAllParticipating.mockImplementation(async () => {
      throw new Error("rate-overlimit");
    });
    sock.emit("connection.update", { connection: "open" });
    await flush();
    expect(logger.warn.mock.calls.map((call) => call[0])).toContain("groupFetchAllParticipating failed");
  });
});

describe("CHANNEL_INBOUND publishing", () => {
  it("re-ensures the stream and retries a failed publish once", async () => {
    const h = createHarness({ publishFailTimes: 1 });
    await h.connect();
    expect(h.ensureInboundStream).toHaveBeenCalledTimes(2);
    expect(h.publishedOfType("connection.connected")).toHaveLength(1);
  });

  it("keeps running when the stream check fails at start", async () => {
    const h = createHarness({ ensureInboundStream: async () => Promise.reject(new Error("jetstream not enabled")) });
    await h.connect();
    expect(h.runtime.getState()).toBe("connected");
  });
});

describe("persisted manual disconnect (survives runner restarts)", () => {
  it("a restarted runtime stays down after connection.disconnect, and connection.connect clears the marker", async () => {
    const auth = createMemoryAuthStorage({ registered: true });
    const first = createHarness({ auth });
    await first.connect();
    await first.runtime.call("connection.disconnect", {});
    await first.runtime.stop();
    expect(auth.flags.manualDisconnected).toBe(true);

    // Runner restart: same auth store, new runtime.
    const second = createHarness({ auth });
    second.runtime.start();
    await flush();
    expect(second.sockets).toHaveLength(0);
    expect(second.runtime.getState()).toBe("disconnected");
    expect(second.runtime.health()).toEqual({ status: "disconnected", reason: "manual_disconnect" });
    // The supervisor does not bring it back either.
    second.manual.runAll();
    await flush();
    expect(second.sockets).toHaveLength(0);

    await second.runtime.call("connection.connect", {});
    await flush();
    expect(auth.flags.manualDisconnected).toBe(false);
    expect(second.sockets).toHaveLength(1);
    second.socket().emit("connection.update", { connection: "open" });
    await flush();
    expect(second.runtime.health()).toMatchObject({ status: "connected" });
    await second.runtime.stop();

    // Next restart auto-connects again.
    const third = createHarness({ auth });
    await third.startAndWaitForSocket();
    expect(third.sockets).toHaveLength(1);
    await third.runtime.stop();
  });

  it("a pairing-code request clears the marker", async () => {
    const auth = createMemoryAuthStorage({ registered: false });
    auth.flags.manualDisconnected = true;
    const h = createHarness({ auth });
    h.runtime.start();
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "manual_disconnect" });
    const pending = h.runtime.call("connection.pairingCode", { phoneNumber: "+55 11 99999-0000" });
    await flush();
    expect(auth.flags.manualDisconnected).toBe(false);
    h.socket().emit("connection.update", { qr: "2@QR" });
    expect(await pending).toEqual({ code: "ABCD1234" });
  });

  it("a disconnect issued while Baileys is still loading is honoured: no socket is opened", async () => {
    let releaseLibrary: () => void = () => {};
    const libraryGate = new Promise<void>((resolve) => {
      releaseLibrary = resolve;
    });
    const h = createHarness();
    const loadLibrary = async () => {
      await libraryGate;
      return h.library;
    };
    const gated = createHarness({ auth: h.auth, loadLibrary });
    gated.runtime.start();
    expect(gated.runtime.getState()).toBe("connecting");
    await gated.runtime.call("connection.disconnect", {});
    releaseLibrary();
    await flush(30);
    expect(h.library.createSocket).not.toHaveBeenCalled();
    expect(gated.runtime.health()).toEqual({ status: "disconnected", reason: "manual_disconnect" });
    expect(h.auth.flags.manualDisconnected).toBe(true);
  });
});

describe("a connect after a disconnect that cancelled an in-flight attempt", () => {
  /** A harness whose Baileys load waits for `release()`; sockets land in `owner`. */
  function gatedHarness(options: { registered?: boolean } = {}) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = createHarness({ registered: options.registered ?? true });
    const gated = createHarness({
      auth: owner.auth,
      loadLibrary: async () => {
        await gate;
        return owner.library;
      },
    });
    return { owner, gated, release };
  }

  it("connection.connect is not dropped while the cancelled attempt still waits for Baileys", async () => {
    const { owner, gated, release } = gatedHarness();
    gated.runtime.start();
    await gated.runtime.call("connection.disconnect", {});

    const result = await gated.runtime.call("connection.connect", {});
    expect(result).toEqual({ status: "connecting", message: "Connection initiated" });
    release();
    await flush(30);

    expect(owner.library.createSocket).toHaveBeenCalledTimes(1);
    expect(gated.runtime.getState()).toBe("connecting");
    expect(owner.auth.flags.manualDisconnected).toBe(false);
    owner.socket().emit("connection.update", { connection: "open" });
    await flush();
    expect(gated.runtime.health()).toMatchObject({ status: "connected" });
    await gated.runtime.stop();
  });

  it("connection.connect after a logout that cancelled an attempt stuck in socket creation opens a fresh socket", async () => {
    let releaseFirst: () => void = () => {};
    const created: FakeSocket[] = [];
    const h = createHarness({
      library: {
        createSocket: mock(async () => {
          const socket = createFakeSocket();
          created.push(socket);
          if (created.length === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return socket.sock;
        }),
      },
    });
    h.runtime.start();
    await flush();
    expect(created).toHaveLength(1);
    await h.runtime.call("connection.logout", {});
    expect(h.runtime.getState()).toBe("logged_out");

    expect(await h.runtime.call("connection.connect", {})).toEqual({
      status: "connecting",
      message: "Connection initiated",
    });
    await flush();
    expect(created).toHaveLength(2);

    // The cancelled attempt finishes late: its socket is closed and the new one is kept.
    releaseFirst();
    await flush();
    expect(created[0]?.fake.end).toHaveBeenCalled();
    expect(created[1]?.fake.end).not.toHaveBeenCalled();
    created[1]?.emit("connection.update", { qr: "2@QR" });
    await flush();
    expect(h.runtime.getState()).toBe("qr");
    await h.runtime.stop();
  });

  it("connection.pairingCode after a cancelling disconnect opens a socket and returns the code", async () => {
    const { owner, gated, release } = gatedHarness();
    gated.runtime.start();
    await gated.runtime.call("connection.disconnect", {});

    const pending = gated.runtime.call("connection.pairingCode", { phoneNumber: "+55 11 99999-0000" });
    release();
    await flush(30);
    expect(owner.library.createSocket).toHaveBeenCalledTimes(1);
    expect(owner.auth.flags.manualDisconnected).toBe(false);
    owner.socket().emit("connection.update", { qr: "2@QR" });
    expect(await pending).toEqual({ code: "ABCD1234" });
    await gated.runtime.stop();
  });

  it("a cancelled attempt that fails later does not overwrite manual_disconnect or arm the supervisor", async () => {
    let failSocket: (error: Error) => void = () => {};
    const h = createHarness({
      library: {
        createSocket: mock(
          () =>
            new Promise<never>((_resolve, reject) => {
              failSocket = reject;
            }),
        ),
      },
    });
    h.runtime.start();
    await flush();
    expect(h.library.createSocket).toHaveBeenCalledTimes(1);
    await h.runtime.call("connection.disconnect", {});

    failSocket(new Error("ENETUNREACH"));
    await flush();
    expect(h.runtime.health()).toEqual({ status: "disconnected", reason: "manual_disconnect" });
    expect(h.manual.pending.size).toBe(0);
  });

  it("an attempt superseded by forceNewQr that fails later does not overwrite the new attempt's state", async () => {
    let failFirst: (error: Error) => void = () => {};
    let calls = 0;
    const created: FakeSocket[] = [];
    const h = createHarness({
      library: {
        createSocket: mock(async () => {
          calls++;
          if (calls === 1) {
            return new Promise<WASocket>((_resolve, reject) => {
              failFirst = reject;
            });
          }
          const socket = createFakeSocket();
          created.push(socket);
          return socket.sock;
        }),
      },
    });
    h.runtime.start();
    await flush();
    expect(calls).toBe(1);

    await h.runtime.call("connection.connect", { forceNewQr: true });
    await flush();
    expect(created).toHaveLength(1);
    created[0]?.emit("connection.update", { qr: "2@QR" });
    await flush();
    expect(h.runtime.getState()).toBe("qr");

    failFirst(new Error("ENETUNREACH"));
    await flush();
    expect(h.runtime.getState()).toBe("qr");
    expect(h.manual.pending.size).toBe(0);
    await h.runtime.stop();
  });
});

describe("QR cycle reset failures never escape as unhandled rejections", () => {
  it("reports qr_reset_failed health when clearing auth throws, and a later connect works", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const clearAuthState = mock(async () => {
        throw new Error("database is locked");
      });
      const h = createHarness({ registered: false, library: { clearAuthState } });
      h.runtime.start();
      await h.runtime.call("connection.connect", {});
      await flush();
      const sock = h.socket();
      // 1 fresh QR + 3 expired ones → the handler resets the QR cycle (clear auth + reconnect).
      for (const qr of ["2@A", "2@B", "2@C", "2@D"]) {
        sock.emit("connection.update", { qr });
        await flush();
      }
      await flush(30);
      expect(clearAuthState).toHaveBeenCalledTimes(1);
      expect(rejections).toEqual([]);
      expect(h.runtime.getState()).toBe("disconnected");
      expect(h.runtime.health()).toMatchObject({ status: "disconnected", reason: "qr_reset_failed" });
      expect(h.publishedOfType("connection.disconnected").at(-1)?.event.payload).toMatchObject({
        willReconnect: false,
      });
      expect(h.sockets).toHaveLength(1);

      // The runtime is not wedged: connection.connect opens a new socket.
      await h.runtime.call("connection.connect", {});
      await flush();
      expect(h.sockets).toHaveLength(2);
      h.socket().emit("connection.update", { qr: "2@E" });
      await flush();
      expect(h.runtime.getState()).toBe("qr");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("a throwing host callback inside connection.update is reported as a connection error", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const h = createHarness({ registered: false });
      h.runtime.start();
      await h.runtime.call("connection.connect", {});
      await flush();
      const original = h.runtime.handleQrCode.bind(h.runtime);
      h.runtime.handleQrCode = async () => {
        throw new Error("emit exploded");
      };
      h.socket().emit("connection.update", { qr: "2@A" });
      await flush(30);
      h.runtime.handleQrCode = original;
      expect(rejections).toEqual([]);
      expect(h.runtime.health()).toMatchObject({ status: "disconnected", reason: "connection_error" });
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

describe("auth-state write queue across the lifecycle", () => {
  it("stop() flushes pending auth writes with the configured timeout", async () => {
    const h = createHarness({ authFlushTimeoutMs: 1234 });
    await h.connect();
    await h.runtime.stop();
    expect(h.authFlush).toHaveBeenCalledWith({ timeoutMs: 1234 });
  });

  it("a reconnect flushes the previous socket's writes before re-reading the store", async () => {
    const h = createHarness();
    const sock = await h.connect();
    expect(h.authFlush).not.toHaveBeenCalled();
    sock.emit("connection.update", { connection: "close", lastDisconnect: { error: new Error("stream errored") } });
    await flush(30);
    expect(h.sockets.length).toBeGreaterThan(1);
    expect(h.authFlush).toHaveBeenCalledTimes(1);
  });

  it("logout and forceNewQr discard pending writes before clearing the auth state", async () => {
    const order: string[] = [];
    const h = createHarness({
      library: {
        clearAuthState: mock(async () => {
          order.push("clear");
        }),
      },
    });
    h.authDiscard.mockImplementation(async () => {
      order.push("discard");
    });
    await h.connect();
    await h.runtime.call("connection.connect", { forceNewQr: true });
    await flush();
    expect(order).toEqual(["discard", "clear"]);
    await h.runtime.call("connection.logout", {});
    expect(order).toEqual(["discard", "clear", "discard", "clear"]);
  });
});
